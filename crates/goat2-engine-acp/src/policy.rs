//! Client-side permission policy for ACP agents.
//!
//! v1: `packages/provider-acp/src/server/clientPolicy.ts` (disposition, changed paths, workspace
//! containment) and `permissionOptions.ts` (option selection). GOAT 2 threads carry a runtime mode
//! and a cwd; v1's optional `approvalPolicy` / `sandboxPolicy` are never set, so the branches for
//! them reduce to v1's `undefined` cases.

use std::path::{Component, Path, PathBuf};

use goat2_contracts::RuntimeMode;
use serde_json::Value;

/// v1 `AcpPermissionDisposition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    Allow,
    Ask,
    Deny,
}

/// v1 `AcpRuntimePolicy` as GOAT 2 has it.
#[derive(Debug, Clone)]
pub struct RuntimePolicy {
    pub runtime_mode: RuntimeMode,
    pub cwd: Option<String>,
    pub extra_roots: Vec<String>,
}

/// v1 `AcpChangedPaths`: the paths a change touches, or unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChangedPaths {
    Known(Vec<String>),
    Unknown,
}

const MAX_ACP_CHANGED_PATHS: usize = 256;

/// v1 `ACP_RAW_INPUT_PATH_KEYS`.
pub const ACP_RAW_INPUT_PATH_KEYS: [&str; 3] = ["path", "filePath", "file_path"];

fn has_url_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') {
            return false;
        }
    }
    false
}

/// v1 `acpCheckablePath`.
fn checkable_path(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    if value.trim().is_empty() || value.contains('\0') {
        return None;
    }
    if Path::new(value).is_absolute() {
        return Some(value.to_owned());
    }
    if value.starts_with('~') || has_url_scheme(value) {
        return None;
    }
    if cfg!(unix) && value.contains('\\') {
        return None;
    }
    Some(value.to_owned())
}

/// v1 `acpChangedPathsOfToolCall` (clientPolicy.ts:139-209).
pub fn changed_paths_of_tool_call(tool_call: &Value) -> ChangedPaths {
    let mut paths: Vec<String> = Vec::new();
    let mut complete = true;
    let mut require = |value: Option<&Value>, paths: &mut Vec<String>| match checkable_path(value) {
        Some(path) => {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        None => complete = false,
    };
    match tool_call.get("locations") {
        Some(Value::Array(locations)) => {
            for location in locations {
                require(location.get("path"), &mut paths);
            }
        }
        None | Some(Value::Null) => {}
        Some(_) => require(None, &mut paths),
    }
    match tool_call.get("content") {
        Some(Value::Array(content)) => {
            for entry in content {
                match entry.get("type").and_then(Value::as_str) {
                    Some("content") | Some("terminal") => continue,
                    Some("diff") => {}
                    _ => {
                        require(None, &mut paths);
                        continue;
                    }
                }
                match entry.get("changes") {
                    None | Some(Value::Null) => require(entry.get("path"), &mut paths),
                    Some(Value::Array(changes)) => {
                        if entry.get("path").is_some_and(|p| !p.is_null()) {
                            require(entry.get("path"), &mut paths);
                        }
                        for change in changes {
                            match change.get("operation").and_then(Value::as_str) {
                                Some("move") => {
                                    require(change.get("oldPath"), &mut paths);
                                    require(change.get("path"), &mut paths);
                                }
                                Some("add" | "delete" | "modify" | "copy") => {
                                    require(change.get("path"), &mut paths)
                                }
                                _ => require(None, &mut paths),
                            }
                        }
                    }
                    Some(_) => require(None, &mut paths),
                }
            }
        }
        None | Some(Value::Null) => {}
        Some(_) => require(None, &mut paths),
    }
    if let Some(input) = tool_call.get("rawInput").and_then(Value::as_object) {
        for key in ACP_RAW_INPUT_PATH_KEYS {
            if let Some(value) = input.get(key).filter(|v| !v.is_null()) {
                require(Some(value), &mut paths);
            }
        }
    }
    if complete && paths.len() <= MAX_ACP_CHANGED_PATHS {
        ChangedPaths::Known(paths)
    } else {
        ChangedPaths::Unknown
    }
}

fn resolve_permission_path(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    if path.trim().is_empty() {
        return None;
    }
    if Path::new(path).is_absolute() {
        return Some(PathBuf::from(path));
    }
    let cwd = cwd.filter(|c| !c.trim().is_empty())?;
    Some(Path::new(cwd).join(path))
}

/// v1 `acpCanonicalPathForContainment`: realpath of the deepest existing ancestor plus the
/// missing suffix; fails closed on anything but "does not exist".
fn canonical_for_containment(path: &Path) -> Option<PathBuf> {
    let mut candidate = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&candidate) {
            Ok(real) => {
                let mut out = real;
                for part in missing.iter().rev() {
                    out.push(part);
                }
                return Some(normalize_lexically(&out));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
        if std::fs::symlink_metadata(&candidate).is_ok() {
            // Exists (dangling symlink) but cannot be resolved.
            return None;
        }
        let name = candidate.file_name()?.to_os_string();
        missing.push(name);
        if !candidate.pop() {
            return None;
        }
    }
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn within_root(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

/// v1 `acpMutationStaysInWorkspace` with no sandbox writable roots.
fn mutation_stays_in_workspace(policy: &RuntimePolicy, changed: &ChangedPaths) -> bool {
    let ChangedPaths::Known(paths) = changed else {
        return false;
    };
    if paths.is_empty() {
        return false;
    }
    let cwd = policy.cwd.as_deref().filter(|c| !c.trim().is_empty());
    let mut roots = Vec::new();
    if let Some(cwd) = cwd
        && let Some(root) = canonical_for_containment(Path::new(cwd))
    {
        roots.push(root);
    }
    for extra in &policy.extra_roots {
        if let Some(resolved) = resolve_permission_path(extra, cwd)
            && let Some(root) = canonical_for_containment(&resolved)
        {
            roots.push(root);
        }
    }
    if roots.is_empty() {
        return false;
    }
    paths.iter().all(|changed| {
        resolve_permission_path(changed, cwd)
            .and_then(|p| canonical_for_containment(&p))
            .is_some_and(|canonical| roots.iter().any(|root| within_root(&canonical, root)))
    })
}

fn is_read_kind(kind: &str) -> bool {
    matches!(kind, "read" | "search" | "think")
}

fn is_mutation_kind(kind: &str) -> bool {
    matches!(kind, "edit" | "delete" | "move")
}

/// v1 `acpOperationDisposition` for GOAT 2's policy (no approval or sandbox policy).
pub fn operation_disposition(
    policy: &RuntimePolicy,
    kind: Option<&str>,
    changed: &ChangedPaths,
) -> Disposition {
    let kind = kind.unwrap_or("other");
    if is_read_kind(kind) {
        return Disposition::Allow;
    }
    match policy.runtime_mode {
        RuntimeMode::ApprovalRequired => Disposition::Ask,
        // Auto-accept covers file changes in the thread's own folders; the user decides the rest.
        RuntimeMode::AutoAcceptEdits => {
            if is_mutation_kind(kind) && mutation_stays_in_workspace(policy, changed) {
                Disposition::Allow
            } else {
                Disposition::Ask
            }
        }
        RuntimeMode::Auto | RuntimeMode::FullAccess => Disposition::Allow,
    }
}

/// v1 `acpPermissionDisposition` (clientPolicy.ts:330-338). `tool_call` is the request's `toolCall`.
pub fn permission_disposition(policy: &RuntimePolicy, tool_call: &Value) -> Disposition {
    operation_disposition(
        policy,
        tool_call.get("kind").and_then(Value::as_str),
        &changed_paths_of_tool_call(tool_call),
    )
}

/// v1 `acpMcpToolApprovalElicitationDisposition` (clientPolicy.ts:340-357).
pub fn mcp_tool_approval_elicitation_disposition(
    policy: &RuntimePolicy,
    request: &Value,
    native_request_id: Option<&str>,
) -> Option<Disposition> {
    let is_mcp_approval = request.get("mode").and_then(Value::as_str) == Some("form")
        && (request
            .get("_meta")
            .and_then(|m| m.get("codex_approval_kind"))
            .and_then(Value::as_str)
            == Some("mcp_tool_call")
            || native_request_id.is_some_and(|id| id.starts_with("mcp_tool_call_approval_")));
    if !is_mcp_approval {
        return None;
    }
    Some(if policy.runtime_mode == RuntimeMode::ApprovalRequired {
        Disposition::Ask
    } else {
        Disposition::Allow
    })
}

/// The decisions a person can make on a permission request (v1 `ProviderApprovalDecision` minus cancel).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionChoice {
    Accept,
    AcceptForSession,
    Decline,
}

fn option_id_of_kind<'a>(options: &'a [Value], kind: &str) -> Option<&'a str> {
    options
        .iter()
        .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
        .and_then(|option| option.get("optionId").and_then(Value::as_str))
}

/// v1 `selectPermissionOptionId` (permissionOptions.ts:4-15).
pub fn select_permission_option_id(options: &[Value], choice: PermissionChoice) -> Option<String> {
    match choice {
        // Agents may offer only allow_once, and answering "cancelled" would stop the turn.
        PermissionChoice::AcceptForSession => option_id_of_kind(options, "allow_always")
            .or_else(|| option_id_of_kind(options, "allow_once")),
        PermissionChoice::Accept => option_id_of_kind(options, "allow_once"),
        PermissionChoice::Decline => option_id_of_kind(options, "reject_once"),
    }
    .map(str::to_owned)
}

/// v1 `selectAutoApprovedPermissionOption`: prefer allow-once; allow-always can persist.
pub fn select_auto_approved_option(options: &[Value]) -> Option<String> {
    select_permission_option_id(options, PermissionChoice::Accept)
        .or_else(|| select_permission_option_id(options, PermissionChoice::AcceptForSession))
}

/// v1 `acpModeAllowed`.
pub fn mode_allowed(mode: Option<RuntimeMode>, ceiling: RuntimeMode) -> bool {
    fn rank(mode: RuntimeMode) -> u8 {
        match mode {
            RuntimeMode::ApprovalRequired => 0,
            RuntimeMode::AutoAcceptEdits => 1,
            RuntimeMode::Auto => 2,
            RuntimeMode::FullAccess => 3,
        }
    }
    mode.is_some_and(|mode| rank(mode) <= rank(ceiling))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(mode: RuntimeMode, cwd: &str) -> RuntimePolicy {
        RuntimePolicy {
            runtime_mode: mode,
            cwd: Some(cwd.to_owned()),
            extra_roots: vec![],
        }
    }

    #[test]
    fn reads_never_ask() {
        let p = policy(RuntimeMode::ApprovalRequired, "/tmp");
        assert_eq!(
            permission_disposition(&p, &json!({"kind": "read"})),
            Disposition::Allow
        );
        assert_eq!(
            permission_disposition(&p, &json!({"kind": "execute"})),
            Disposition::Ask
        );
    }

    #[test]
    fn auto_accept_edits_only_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let p = policy(RuntimeMode::AutoAcceptEdits, cwd);
        let inside = json!({"kind": "edit", "locations": [{"path": format!("{cwd}/a/new.txt")}]});
        let outside = json!({"kind": "edit", "locations": [{"path": "/etc/passwd"}]});
        let traversal = json!({"kind": "edit", "rawInput": {"path": "../x"}});
        assert_eq!(permission_disposition(&p, &inside), Disposition::Allow);
        assert_eq!(permission_disposition(&p, &outside), Disposition::Ask);
        assert_eq!(permission_disposition(&p, &traversal), Disposition::Ask);
        assert_eq!(
            permission_disposition(&p, &json!({"kind": "execute"})),
            Disposition::Ask
        );
    }

    #[test]
    fn unknown_diff_shapes_are_unknown() {
        let call = json!({"content": [{"type": "diff", "changes": [{"operation": "chmod", "path": "a"}]}]});
        assert_eq!(changed_paths_of_tool_call(&call), ChangedPaths::Unknown);
        let tilde = json!({"rawInput": {"path": "~/x"}});
        assert_eq!(changed_paths_of_tool_call(&tilde), ChangedPaths::Unknown);
    }

    #[test]
    fn option_selection_matches_v1() {
        let options = vec![
            json!({"optionId": "once", "kind": "allow_once", "name": "Allow"}),
            json!({"optionId": "no", "kind": "reject_once", "name": "Reject"}),
        ];
        assert_eq!(
            select_permission_option_id(&options, PermissionChoice::AcceptForSession).as_deref(),
            Some("once")
        );
        assert_eq!(
            select_permission_option_id(&options, PermissionChoice::Decline).as_deref(),
            Some("no")
        );
        assert_eq!(
            select_auto_approved_option(&options).as_deref(),
            Some("once")
        );
    }
}
