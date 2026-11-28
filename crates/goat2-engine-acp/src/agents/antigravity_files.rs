//! Antigravity's `fs/read_text_file` reader.
//!
//! v1 `readAntigravityClientTextFile` (`apps/server/src/provider/acp/AntigravityClientFiles.ts:15-133`
//! at 916b5ccc1b2): requests resolve through symlinks (the nearest existing ancestor for a missing
//! path) and must land inside the thread's folder or the attachments folder; UTF-8 text under
//! 8 MiB, sliced by ACP's 1-based `line` and `limit`. The write helper (:135-312) is not carried:
//! GOAT never advertises `writeTextFile` to Antigravity (AntigravityAcpSupport.ts:164-171).

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

const CLIENT_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// ACP `invalid params`.
const INVALID_PARAMS: i32 = -32602;
/// ACP `resource not found` (v1 `AcpRequestError.resourceNotFound`).
const RESOURCE_NOT_FOUND: i32 = -32002;
const INTERNAL_ERROR: i32 = -32603;

/// v1 `resolveClientFilePath` (:26-76): the resolved file, or None when it is outside every root.
fn resolve_client_file_path(allowed_roots: &[PathBuf], request_path: &str) -> Option<PathBuf> {
    let mut existing = std::path::absolute(request_path).ok()?;
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let real = loop {
        if let Ok(resolved) = std::fs::canonicalize(&existing) {
            let mut real = resolved;
            for part in missing.iter().rev() {
                real.push(part);
            }
            break real;
        }
        // Only missing entries fall back to their parent; a dangling or unreadable link stops here.
        let entry_exists = match std::fs::symlink_metadata(&existing) {
            Ok(_) => true,
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        };
        let parent = existing.parent()?.to_path_buf();
        if entry_exists || parent == existing {
            return None;
        }
        missing.push(existing.file_name()?.to_os_string());
        existing = parent;
    };
    let inside = allowed_roots.iter().any(|root| {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.clone());
        real.starts_with(&root)
    });
    inside.then_some(real)
}

/// Serve one `fs/read_text_file` request: the ACP response, or an error code and message.
pub fn read_client_text_file(
    allowed_roots: &[PathBuf],
    request: &Value,
) -> Result<Value, (i32, String)> {
    let request_path = request
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(file_path) = resolve_client_file_path(allowed_roots, request_path) else {
        return Err((
            INVALID_PARAMS,
            format!("Path '{request_path}' is outside the session workspace."),
        ));
    };
    let info = std::fs::metadata(&file_path).map_err(|_| {
        (
            RESOURCE_NOT_FOUND,
            format!("File '{request_path}' not found."),
        )
    })?;
    if !info.is_file() || info.len() > CLIENT_FILE_MAX_BYTES {
        return Err((
            INVALID_PARAMS,
            format!(
                "File '{request_path}' is not a readable text file under {CLIENT_FILE_MAX_BYTES} bytes."
            ),
        ));
    }
    let bytes = std::fs::read(Path::new(&file_path))
        .map_err(|_| (INTERNAL_ERROR, format!("Could not read '{request_path}'.")))?;
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        (
            INVALID_PARAMS,
            format!("File '{request_path}' is not a UTF-8 text file."),
        )
    })?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.contains('\0') {
        return Err((
            INVALID_PARAMS,
            format!("File '{request_path}' contains binary data."),
        ));
    }
    let line = request.get("line").and_then(Value::as_u64);
    let limit = request.get("limit").and_then(Value::as_u64);
    if line.is_none() && limit.is_none() {
        return Ok(json!({"content": text}));
    }
    // ACP lines are 1-indexed; `limit` is a line count.
    let lines: Vec<&str> = text.split('\n').collect();
    let start = (line.unwrap_or(1).saturating_sub(1) as usize).min(lines.len());
    let end = match limit {
        None => lines.len(),
        Some(limit) => lines.len().min(start.saturating_add(limit as usize)),
    };
    Ok(json!({"content": lines[start..end].join("\n")}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_inside_the_workspace_only() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = workspace.path().join("a.txt");
        std::fs::write(&file, "one\ntwo\nthree").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "no").unwrap();
        let roots = vec![workspace.path().to_path_buf()];
        let read = |path: &Path, extra: Value| {
            let mut request = json!({"sessionId": "s", "path": path.to_string_lossy()});
            if let (Some(r), Some(e)) = (request.as_object_mut(), extra.as_object()) {
                r.extend(e.clone());
            }
            read_client_text_file(&roots, &request)
        };
        assert_eq!(
            read(&file, json!({})).unwrap()["content"],
            "one\ntwo\nthree"
        );
        assert_eq!(
            read(&file, json!({"line": 2, "limit": 1})).unwrap()["content"],
            "two"
        );
        assert_eq!(
            read(&outside.path().join("secret.txt"), json!({}))
                .unwrap_err()
                .0,
            INVALID_PARAMS
        );
        #[cfg(unix)]
        {
            let link = workspace.path().join("link.txt");
            std::os::unix::fs::symlink(outside.path().join("secret.txt"), &link).unwrap();
            assert_eq!(read(&link, json!({})).unwrap_err().0, INVALID_PARAMS);
        }
        assert_eq!(
            read(&workspace.path().join("missing.txt"), json!({})).unwrap_err(),
            (
                RESOURCE_NOT_FOUND,
                format!(
                    "File '{}' not found.",
                    workspace.path().join("missing.txt").display()
                )
            )
        );
        let binary = workspace.path().join("b.bin");
        std::fs::write(&binary, [b'a', 0, b'b']).unwrap();
        assert!(
            read(&binary, json!({}))
                .unwrap_err()
                .1
                .contains("binary data")
        );
    }
}
