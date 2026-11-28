//! Executable lookup and PATH handling for registry launches and installs, from v1
//! `packages/shared/src/shell.ts:99-154,326-332,370-423` (`SpawnExecutableResolution` default),
//! `shellPathEntries.ts:1-23`, `managedCommandPath.ts` (all 33 lines), `localCommandPath.ts` (all 30
//! lines) and `AcpRegistrySupport.ts:534-546` at 916b5ccc1b2.
//!
//! `platform` is a Node platform name (`darwin`, `linux`, `win32`, ...), passed in so callers and tests
//! choose it, as v1's `HostProcess.Platform` does. Paths are joined with this host's separator.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

/// A process environment (v1 `NodeJS.ProcessEnv`).
pub type Environment = BTreeMap<String, String>;

/// This process's environment, lossily decoded.
pub fn host_environment() -> Environment {
    std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        .collect()
}

/// Node's `process.platform` for this build.
pub fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Node's `process.arch` for this build.
pub fn host_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn delimiter(platform: &str) -> char {
    if platform == "win32" { ';' } else { ':' }
}

/// v1 `shellPathEntries.ts:1-23`: preferred entries first, duplicates and blanks dropped.
pub fn merge_path_entries(
    preferred: Option<&str>,
    inherited: Option<&str>,
    platform: &str,
) -> Option<String> {
    let delimiter = delimiter(platform);
    let mut merged: Vec<&str> = Vec::new();
    for value in [preferred, inherited].into_iter().flatten() {
        for entry in value.split(delimiter) {
            let entry = if platform == "win32" {
                entry.trim()
            } else {
                entry
            };
            if !entry.is_empty() && !merged.contains(&entry) {
                merged.push(entry);
            }
        }
    }
    (!merged.is_empty()).then(|| merged.join(&delimiter.to_string()))
}

/// v1 `managedCommandPath.ts:3-12`.
fn read_environment_path<'a>(environment: &'a Environment, platform: &str) -> Option<&'a str> {
    if platform != "win32" {
        return environment.get("PATH").map(String::as_str);
    }
    environment.get("PATH").map(String::as_str).or_else(|| {
        environment
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("path"))
            .map(|(_, v)| v.as_str())
    })
}

/// v1 `managedCommandPath.ts:14-23`: put `directory` first on PATH.
pub fn with_preferred_path(
    environment: &Environment,
    directory: &Path,
    platform: &str,
) -> Environment {
    let mut next = environment.clone();
    let directory = directory.to_string_lossy();
    match merge_path_entries(
        Some(&directory),
        read_environment_path(environment, platform),
        platform,
    ) {
        Some(path) => next.insert("PATH".into(), path),
        None => next.remove("PATH"),
    };
    next
}

/// v1 `managedCommandPath.ts:25-33`: Windows npm reads any-case `npm_config_prefix`.
pub fn without_npm_prefix(environment: &Environment, platform: &str) -> Environment {
    if platform != "win32" {
        return environment.clone();
    }
    environment
        .iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case("npm_config_prefix"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// v1 `shell.ts:370-372`.
fn read_env_path(environment: &Environment) -> Option<&str> {
    ["PATH", "Path", "path"]
        .iter()
        .find_map(|k| environment.get(*k))
        .map(String::as_str)
}

/// v1 `shell.ts:378-394`.
fn windows_path_extensions(environment: &Environment) -> Vec<String> {
    let fallback = || [".COM", ".EXE", ".BAT", ".CMD"].map(String::from).to_vec();
    let raw = environment.get("PATHEXT").or_else(|| {
        environment
            .iter()
            .find(|(k, _)| k.to_uppercase() == "PATHEXT")
            .map(|(_, v)| v)
    });
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return fallback();
    };
    let mut parsed: Vec<String> = Vec::new();
    for entry in raw.split(';') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let ext = if entry.starts_with('.') {
            entry.to_uppercase()
        } else {
            format!(".{}", entry.to_uppercase())
        };
        if !parsed.contains(&ext) {
            parsed.push(ext);
        }
    }
    if parsed.is_empty() {
        fallback()
    } else {
        parsed
    }
}

/// Node `path.extname` (a leading dot alone is not an extension).
fn extname(command: &str) -> &str {
    let base_start = command.rfind(['/', '\\']).map_or(0, |i| i + 1);
    let base = &command[base_start..];
    match base.rfind('.') {
        Some(0) | None => "",
        Some(i) => &base[i..],
    }
}

/// v1 `shell.ts:396-423`.
fn command_candidates(command: &str, platform: &str, extensions: &[String]) -> Vec<String> {
    if platform != "win32" {
        return vec![command.to_owned()];
    }
    let mut candidates: Vec<String> = Vec::new();
    let mut push = |c: String| {
        if !candidates.contains(&c) {
            candidates.push(c);
        }
    };
    let extension = extname(command);
    if !extension.is_empty() && extensions.contains(&extension.to_uppercase()) {
        let stem = &command[..command.len() - extension.len()];
        push(command.to_owned());
        push(format!("{stem}{}", extension.to_uppercase()));
        push(format!("{stem}{}", extension.to_lowercase()));
    } else {
        for ext in extensions {
            push(format!("{command}{ext}"));
            push(format!("{command}{}", ext.to_lowercase()));
        }
    }
    candidates
}

fn is_executable(candidate: &Path, platform: &str, extensions: &[String]) -> bool {
    match candidate.metadata() {
        Ok(m) if m.is_file() => {}
        _ => return false,
    }
    if platform == "win32" {
        let name = candidate.to_string_lossy();
        return extensions.contains(&extname(&name).to_uppercase());
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(candidate.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `c` is a valid NUL-terminated path for the duration of the call.
        unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// v1 `shell.ts:99-154` (`resolveSpawnExecutableWithNode`): find `command` as v1 spawns it.
///
/// A command with a separator is probed as given; a bare name is looked up on the environment's
/// PATH, where an empty POSIX entry means the current directory (anchored to an absolute path).
pub fn resolve_executable(
    command: &str,
    platform: &str,
    environment: &Environment,
) -> Option<PathBuf> {
    let extensions = if platform == "win32" {
        windows_path_extensions(environment)
    } else {
        Vec::new()
    };
    let candidates = command_candidates(command, platform, &extensions);
    if command.contains('/') || command.contains('\\') {
        return candidates
            .into_iter()
            .map(PathBuf::from)
            .find(|c| is_executable(c, platform, &extensions));
    }
    let path_value = read_env_path(environment).unwrap_or("");
    for entry in path_value.split(delimiter(platform)) {
        let empty_component = entry.is_empty() && !path_value.is_empty() && platform != "win32";
        let entry = if empty_component {
            "."
        } else if platform == "win32" {
            entry.trim().trim_matches('"')
        } else {
            entry
        };
        if entry.is_empty() {
            continue;
        }
        for candidate in &candidates {
            let mut probe = Path::new(entry).join(candidate);
            if empty_component {
                let Ok(absolute) = std::path::absolute(&probe) else {
                    continue;
                };
                probe = absolute;
            }
            if is_executable(&probe, platform, &extensions) {
                return Some(probe);
            }
        }
    }
    None
}

/// v1 `localCommandPath.ts:6-11`: absolute without resolving symlinks or `..`.
pub fn resolve_absolute_local_command(command: &Path) -> PathBuf {
    if command.is_absolute() {
        return command.to_path_buf();
    }
    std::path::absolute(command).unwrap_or_else(|_| command.to_path_buf())
}

/// Node `path.resolve` for one path: absolute, with `.` and `..` folded lexically.
fn node_resolve(path: &Path) -> PathBuf {
    let absolute = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in absolute.components() {
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

/// v1 `localCommandPath.ts:13-30`.
pub fn is_same_resolved_path(left: &Path, right: &Path, platform: &str) -> bool {
    let normalize = |p: &Path| {
        let s = node_resolve(p).to_string_lossy().into_owned();
        if platform == "win32" {
            s.to_lowercase()
        } else {
            s
        }
    };
    if normalize(left) == normalize(right) {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(l), Ok(r)) => normalize(&l) == normalize(&r),
        _ => false,
    }
}

/// v1 `AcpRegistrySupport.ts:534-546`: a wrapper symlink named like the runner points at the
/// toolchain bin directory; any other link (npm-cli.js) keeps the runner's own directory.
pub fn manager_bin_directory(runner: &Path) -> PathBuf {
    let parent = runner.parent().map(Path::to_path_buf).unwrap_or_default();
    let Ok(target) = std::fs::read_link(runner) else {
        return parent;
    };
    let target = if target.is_absolute() {
        target
    } else {
        node_resolve(&parent.join(target))
    };
    if target.file_name() == runner.file_name() {
        target.parent().map(Path::to_path_buf).unwrap_or(parent)
    } else {
        parent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Environment {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    #[test]
    fn merge_and_preferred_path() {
        assert_eq!(
            merge_path_entries(Some("/a"), Some("/b:/a::/c"), "linux").as_deref(),
            Some("/a:/b:/c")
        );
        assert_eq!(
            merge_path_entries(Some("C:\\a"), Some(" C:\\b ; C:\\a"), "win32").as_deref(),
            Some("C:\\a;C:\\b")
        );
        assert_eq!(merge_path_entries(None, None, "linux"), None);
        let e = with_preferred_path(&env(&[("Path", "C:\\x")]), Path::new("C:\\y"), "win32");
        assert_eq!(e["PATH"], "C:\\y;C:\\x");
        let stripped = without_npm_prefix(&env(&[("NPM_CONFIG_PREFIX", "x"), ("A", "b")]), "win32");
        assert_eq!(stripped, env(&[("A", "b")]));
        assert_eq!(
            without_npm_prefix(&env(&[("npm_config_prefix", "x")]), "linux").len(),
            1
        );
    }

    #[test]
    fn windows_candidates_use_pathext() {
        let exts = windows_path_extensions(&env(&[("PathExt", "exe;.Cmd")]));
        assert_eq!(exts, [".EXE", ".CMD"]);
        assert_eq!(
            command_candidates("npm", "win32", &exts),
            ["npm.EXE", "npm.exe", "npm.CMD", "npm.cmd"]
        );
        assert_eq!(
            command_candidates("npm.Cmd", "win32", &exts),
            ["npm.Cmd", "npm.CMD", "npm.cmd"]
        );
        assert_eq!(windows_path_extensions(&env(&[])).len(), 4);
        assert_eq!(extname(".hidden"), "");
        assert_eq!(extname("dir.d/file"), "");
    }

    #[cfg(unix)]
    #[test]
    fn posix_lookup_needs_the_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("tool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        let environment = env(&[("PATH", &path)]);
        assert_eq!(resolve_executable("tool", "linux", &environment), None);
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            resolve_executable("tool", "linux", &environment),
            Some(tool.clone())
        );
        assert_eq!(
            resolve_executable(tool.to_str().unwrap(), "linux", &env(&[])),
            Some(tool.clone())
        );
        // On win32 the extension decides, not the mode bits.
        let cmd = dir.path().join("tool.cmd");
        std::fs::write(&cmd, "@echo off").unwrap();
        // (Compared without case: this file system may match "tool.CMD" first.)
        let found = resolve_executable("tool", "win32", &environment).unwrap();
        assert_eq!(
            found.to_string_lossy().to_lowercase(),
            cmd.to_string_lossy().to_lowercase()
        );
    }

    #[cfg(unix)]
    #[test]
    fn same_path_and_manager_directory_follow_links() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(is_same_resolved_path(&link, &real, "linux"));
        assert!(is_same_resolved_path(&real.join("../real"), &real, "linux"));
        assert!(!is_same_resolved_path(
            &dir.path().join("x"),
            &real,
            "linux"
        ));

        let toolchain = dir.path().join("toolchain/bin");
        std::fs::create_dir_all(&toolchain).unwrap();
        std::fs::write(toolchain.join("npm"), "").unwrap();
        let shims = dir.path().join("shims");
        std::fs::create_dir(&shims).unwrap();
        std::os::unix::fs::symlink(toolchain.join("npm"), shims.join("npm")).unwrap();
        assert_eq!(manager_bin_directory(&shims.join("npm")), toolchain);
        std::os::unix::fs::symlink("../toolchain/bin/npm-cli.js", shims.join("npx")).unwrap();
        assert_eq!(manager_bin_directory(&shims.join("npx")), shims);
        assert_eq!(manager_bin_directory(&toolchain.join("npm")), toolchain);
    }
}
