//! Per-run temp directories for registry agents, from v1 `registryRuntimeTemp.ts` (1-122; 124-146 are in catalog.rs `prepare_runtime_spawn`)
//! at 916b5ccc1b2. Only `antigravity-acp` gets one (v1 `:134`): its TMPDIR (TEMP/TMP on Windows)
//! points into a directory removed when the run ends; directories of dead GOAT processes are
//! retired at startup and removed in the background.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::command_path::Environment;

/// v1 `registryRuntimeTemp.ts:13`.
pub const MAX_LIVE: usize = 256;

/// v1 `registryRuntimeTemp.ts:11-12`: one gate and live set per process.
fn live() -> &'static Mutex<HashSet<PathBuf>> {
    static LIVE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// v1 `registryRuntimeTemp.ts:15-26`: `run-<pid>-` of a process that no longer exists.
fn is_dead_run(entry: &str) -> bool {
    let Some(rest) = entry.strip_prefix("run-") else {
        return false;
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() || !rest[digits.len()..].starts_with('-') {
        return false;
    }
    let Ok(pid) = digits.parse::<i32>() else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists.
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        !alive && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// v1 `registryRuntimeTemp.ts:28-38`: at most 1024 scanned, 32 returned with a prefix.
fn entries(directory: &Path, prefix: Option<&str>) -> io::Result<Vec<String>> {
    let mut result = Vec::new();
    for (scanned, entry) in fs::read_dir(directory)?.enumerate() {
        if scanned >= 1024 {
            break;
        }
        let name = entry?.file_name().to_string_lossy().into_owned();
        if prefix.is_none_or(|p| name.starts_with(p)) {
            result.push(name);
        }
        if prefix.is_some() && result.len() == 32 {
            break;
        }
    }
    Ok(result)
}

/// `fs.makeTempDirectory({directory, prefix})`.
pub(crate) fn make_temp_directory(parent: &Path, prefix: &str) -> io::Result<PathBuf> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..64 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        let candidate = parent.join(format!(
            "{prefix}{:x}{:08x}",
            NEXT.fetch_add(1, Ordering::Relaxed),
            nanos
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a unique temp directory",
    ))
}

/// The per-run temp root (v1 `makeRegistryRuntimeTemp`).
#[derive(Debug, Clone)]
pub struct RegistryRuntimeTemp {
    root: PathBuf,
    platform: String,
}

/// One run's directory; removed when dropped (v1 `acquireRelease` release).
#[derive(Debug)]
pub struct RuntimeTempLease {
    directory: PathBuf,
}

impl RuntimeTempLease {
    pub fn directory(&self) -> &Path {
        &self.directory
    }
}

impl Drop for RuntimeTempLease {
    fn drop(&mut self) {
        let mut live = live().lock().unwrap_or_else(|e| e.into_inner());
        let _ = fs::remove_dir_all(&self.directory);
        live.remove(&self.directory);
    }
}

impl RegistryRuntimeTemp {
    /// v1 `registryRuntimeTemp.ts:40-82`: retire dead runs into `<root>.old-*`, then remove every
    /// retired directory on a background thread.
    pub fn new(root: PathBuf, platform: &str) -> Self {
        let parent = root.parent().map(Path::to_path_buf).unwrap_or_default();
        let prefix = format!(
            "{}.old-",
            root.file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default()
        );
        let retired = {
            let live = live().lock().unwrap_or_else(|e| e.into_inner());
            (|| -> io::Result<Vec<String>> {
                if root.exists() {
                    let stale: Vec<String> = entries(&root, None)?
                        .into_iter()
                        .filter(|e| is_dead_run(e) && !live.contains(&root.join(e)))
                        .collect();
                    if !stale.is_empty() {
                        let destination = make_temp_directory(&parent, &prefix)?;
                        for entry in stale {
                            // v1 logs "Could not retire ACP agent temp files." and continues.
                            let _ = fs::rename(root.join(&entry), destination.join(&entry));
                        }
                    }
                }
                entries(&parent, Some(&prefix))
            })()
            .unwrap_or_default()
        };
        if !retired.is_empty() {
            let parent = parent.clone();
            std::thread::spawn(move || {
                for entry in retired {
                    // v1 logs "Could not remove leftover ACP agent temp files." on failure.
                    let _ = fs::remove_dir_all(parent.join(entry));
                }
            });
        }
        Self {
            root,
            platform: platform.to_owned(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// v1 `registryRuntimeTemp.ts:83-121`: a fresh `run-<pid>-*` directory and the environment
    /// that points the agent's temp files into it.
    pub fn acquire(
        &self,
        environment: &Environment,
    ) -> io::Result<(Environment, RuntimeTempLease)> {
        let mut live = live().lock().unwrap_or_else(|e| e.into_inner());
        if live.len() >= MAX_LIVE {
            return Err(io::Error::other(
                "Too many Antigravity sessions are running.",
            ));
        }
        fs::create_dir_all(&self.root)?;
        let directory = make_temp_directory(&self.root, &format!("run-{}-", std::process::id()))?;
        live.insert(directory.clone());
        drop(live);
        let value = directory.to_string_lossy().into_owned();
        let env = if self.platform != "win32" {
            let mut env = environment.clone();
            env.insert("TMPDIR".into(), value);
            env
        } else {
            let mut env: Environment = environment
                .iter()
                .filter(|(k, _)| !matches!(k.to_lowercase().as_str(), "temp" | "tmp"))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            env.insert("TEMP".into(), value.clone());
            env.insert("TMP".into(), value);
            env
        };
        Ok((env, RuntimeTempLease { directory }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_sets_temp_and_release_removes_it() {
        let dir = tempfile::tempdir().unwrap();
        let temp = RegistryRuntimeTemp::new(dir.path().join("acp-registry"), "linux");
        let base: Environment = [("TMPDIR".into(), "/tmp".into()), ("A".into(), "b".into())].into();
        let (env, lease) = temp.acquire(&base).unwrap();
        let run = lease.directory().to_path_buf();
        assert_eq!(env["TMPDIR"], run.to_string_lossy());
        assert_eq!(env["A"], "b");
        assert!(
            run.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&format!("run-{}-", std::process::id()))
        );
        assert!(run.is_dir());
        drop(lease);
        assert!(!run.exists());

        let windows = RegistryRuntimeTemp::new(dir.path().join("win"), "win32");
        let base: Environment = [("Temp".into(), "x".into()), ("tmp".into(), "y".into())].into();
        let (env, _lease) = windows.acquire(&base).unwrap();
        assert_eq!(env.keys().collect::<Vec<_>>(), ["TEMP", "TMP"]);
    }

    #[cfg(unix)]
    #[test]
    fn dead_runs_are_retired_and_live_ones_kept() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("acp-registry");
        // PID 0x7fff_fff0 is far above any real PID limit, so it is dead.
        let dead = root.join("run-2147483632-abc");
        let mine = root.join(format!("run-{}-abc", std::process::id()));
        let other = root.join("notes");
        for d in [&dead, &mine, &other] {
            fs::create_dir_all(d).unwrap();
        }
        let _temp = RegistryRuntimeTemp::new(root.clone(), "linux");
        assert!(!dead.exists());
        assert!(mine.exists());
        assert!(other.exists());
        assert!(!is_dead_run("run-x-1"));
        assert!(!is_dead_run(&format!("run-{}-x", std::process::id())));
    }
}
