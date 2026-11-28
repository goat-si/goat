//! Per-instance Codex homes: a port of v1 `apps/server/src/provider/Drivers/CodexHomeLayout.ts`
//! (goat origin/dev 916b5ccc), with the path rule of `CodexManagedHome.ts`.
//!
//! The default instance uses the person's shared Codex home (`~/.codex` or the one their settings
//! name). Every other instance gets an "auth overlay": a private folder the host owns, in which
//! every entry of the shared home is a symlink except the account's own files (`auth.json`,
//! `auth.lock`, `models_cache.json`) and a few local ones (`log`, `memories`, `tmp`). The second
//! account so keeps the person's config, MCP servers, skills, plugins and sessions, and a native
//! thread resumes under either instance (the continuation key is the shared home).

use std::ffi::OsString;
use std::io;
use std::path::{Component, Path, PathBuf};

/// v1 `CodexHomeLayout`. Its Debug shows no paths (home paths are never logged or shown).
#[derive(Clone, PartialEq, Eq)]
pub enum HomeLayout {
    /// The shared home itself. `effective` is set only when settings named the shared home
    /// (then CODEX_HOME is set to it); `None` leaves Codex's own default.
    Direct {
        shared: PathBuf,
        effective: Option<PathBuf>,
    },
    /// A private overlay over the shared home.
    AuthOverlay { shared: PathBuf, effective: PathBuf },
}

impl std::fmt::Debug for HomeLayout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HomeLayout::Direct { effective, .. } => f
                .debug_struct("Direct")
                .field("shared", &"<set>")
                .field("effective", &effective.as_ref().map(|_| "<set>"))
                .finish(),
            HomeLayout::AuthOverlay { .. } => f
                .debug_struct("AuthOverlay")
                .field("shared", &"<set>")
                .field("effective", &"<set>")
                .finish(),
        }
    }
}

/// v1 `KNOWN_SHARED_DIRECTORIES`: created in the shared home and always linked.
const KNOWN_SHARED_DIRECTORIES: [&str; 11] = [
    "sessions",
    "archived_sessions",
    "sqlite",
    "shell_snapshots",
    "worktrees",
    "skills",
    "plugins",
    "cache",
    "logs",
    "mcp-oauth-locks",
    "thread-writer-locks",
];
/// v1 `PRIVATE_ENTRY_NAMES`: the account's own files (auth.lock guards the private auth.json).
const PRIVATE_ENTRY_NAMES: [&str; 3] = ["auth.json", "auth.lock", "models_cache.json"];
/// v1 `SHADOW_LOCAL_ENTRY_NAMES` (Finder keeps .DS_Store per folder).
const SHADOW_LOCAL_ENTRY_NAMES: [&str; 4] = ["log", "memories", "tmp", ".DS_Store"];
/// v1 `REPLACEABLE_SHARED_RUNTIME_ENTRIES`: Codex may create these locally first; they guard shared
/// state, so a local one is replaced by the shared link.
const REPLACEABLE_SHARED_RUNTIME_ENTRIES: [&str; 3] = [
    "mcp-oauth-locks",
    "thread-writer-locks",
    ".sqlite-maintenance.lock",
];
/// v1 `BUNDLED_MARKETPLACE`: Codex accepts bundled plugins only from under CODEX_HOME.
const BUNDLED_MARKETPLACE: &str = "openai-bundled";

/// v1 `CodexShadowHomeError`. The paths are kept for callers, but neither Display nor Debug
/// shows them (home paths are never logged or shown; v1's messages name them).
#[derive(thiserror::Error)]
pub enum HomeLayoutError {
    #[error("filesystem operation '{operation}' failed ({})", source.kind())]
    FileSystem {
        operation: &'static str,
        path: PathBuf,
        target: Option<PathBuf>,
        #[source]
        source: io::Error,
    },
    #[error("the instance home must differ from the shared home")]
    PathConflict { shared: PathBuf, effective: PathBuf },
    #[error("'{entry}' already exists in the instance home and is not a symlink")]
    EntryConflict { entry: String, link: PathBuf },
    #[error("the private entry '{entry}' must be a real file, not a symlink")]
    PrivateEntrySymlink { entry: String, path: PathBuf },
    #[error("symlinks are not supported on this platform yet")]
    Unsupported,
}

impl std::fmt::Debug for HomeLayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HomeLayoutError({self})")
    }
}

/// What a materialization noticed but did not treat as an error (v1 logs these).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Materialized {
    /// v1: a local `thread-writer-locks` that still holds a lock may guard a live writer; it is kept
    /// and shared on a later setup.
    pub kept_local_thread_writer_locks: bool,
}

/// v1 `resolveCodexHomeLayout` with the host's resolved paths: `shared_home` is the shared home settings
/// name (v1 `homePath`; `None` = `<user_home>/.codex`), `private_home` the instance's own folder (v1
/// `shadowHomePath`; `None` for the default instance). Paths are made absolute lexically, as v1's
/// `path.resolve`.
pub fn resolve(
    shared_home: Option<&Path>,
    private_home: Option<&Path>,
    user_home: &Path,
) -> HomeLayout {
    let shared = absolute(&shared_home.map_or_else(|| user_home.join(".codex"), Path::to_path_buf));
    match private_home {
        None => HomeLayout::Direct {
            effective: shared_home.map(|_| shared.clone()),
            shared,
        },
        Some(private) => HomeLayout::AuthOverlay {
            effective: absolute(private),
            shared,
        },
    }
}

impl HomeLayout {
    /// The shared home.
    pub fn shared(&self) -> &Path {
        match self {
            HomeLayout::Direct { shared, .. } | HomeLayout::AuthOverlay { shared, .. } => shared,
        }
    }

    /// The CODEX_HOME to set, if any.
    pub fn codex_home(&self) -> Option<&Path> {
        match self {
            HomeLayout::Direct { effective, .. } => effective.as_deref(),
            HomeLayout::AuthOverlay { effective, .. } => Some(effective),
        }
    }

    /// v1 `continuationKey`: native threads continue across instances of one shared home.
    pub fn continuation_key(&self) -> String {
        format!("codex:home:{}", self.shared().display())
    }

    /// v1 `codexHomeLaunchArgs`: an overlay points the bundled marketplace at its own `.tmp` link,
    /// because the shared config names the original home. These go before the person's own launch
    /// arguments so an explicit source still wins.
    pub fn launch_args(&self) -> Vec<OsString> {
        let HomeLayout::AuthOverlay { effective, .. } = self else {
            return Vec::new();
        };
        let source = effective
            .join(".tmp")
            .join("bundled-marketplaces")
            .join(BUNDLED_MARKETPLACE);
        let quoted = serde_json::to_string(&source.to_string_lossy()).unwrap_or_default();
        vec![
            "-c".into(),
            format!("marketplaces.{BUNDLED_MARKETPLACE}.source={quoted}").into(),
        ]
    }

    /// v1 `materializeCodexShadowHome`: lay the overlay out (idempotent). A direct layout needs
    /// nothing.
    pub fn materialize(&self) -> Result<Materialized, HomeLayoutError> {
        let HomeLayout::AuthOverlay { shared, effective } = self else {
            return Ok(Materialized::default());
        };
        if shared == effective {
            return Err(HomeLayoutError::PathConflict {
                shared: shared.clone(),
                effective: effective.clone(),
            });
        }
        materialize_overlay(shared, effective)
    }
}

#[cfg(not(unix))]
fn materialize_overlay(_shared: &Path, _effective: &Path) -> Result<Materialized, HomeLayoutError> {
    // Windows (symlink privileges, junctions) is Part 2.
    Err(HomeLayoutError::Unsupported)
}

#[cfg(unix)]
fn materialize_overlay(shared: &Path, effective: &Path) -> Result<Materialized, HomeLayoutError> {
    let fs_err = |operation: &'static str, path: &Path, target: Option<&Path>| {
        let path = path.to_path_buf();
        let target = target.map(Path::to_path_buf);
        move |source: io::Error| HomeLayoutError::FileSystem {
            operation,
            path,
            target,
            source,
        }
    };
    let make_dir = |p: &Path| std::fs::create_dir_all(p).map_err(fs_err("makeDirectory", p, None));
    make_dir(shared)?;
    make_dir(effective)?;
    for dir in KNOWN_SHARED_DIRECTORIES {
        make_dir(&shared.join(dir))?;
    }
    let mut entries: Vec<String> = KNOWN_SHARED_DIRECTORIES
        .iter()
        .map(|s| s.to_string())
        .collect();
    for entry in std::fs::read_dir(shared).map_err(fs_err("readDirectory", shared, None))? {
        let entry = entry.map_err(fs_err("readDirectory", shared, None))?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !PRIVATE_ENTRY_NAMES.contains(&name.as_str())
            && !SHADOW_LOCAL_ENTRY_NAMES.contains(&name.as_str())
            && !entries.contains(&name)
        {
            entries.push(name);
        }
    }
    // Private entries other than auth.json that are symlinks are removed (each account keeps its own).
    for name in PRIVATE_ENTRY_NAMES.iter().filter(|n| **n != "auth.json") {
        let path = effective.join(name);
        if let LinkState::Symlink(_) = link_state(&path)? {
            std::fs::remove_file(&path).map_err(fs_err("remove", &path, None))?;
        }
    }
    let mut out = Materialized::default();
    for name in &entries {
        if ensure_symlink(shared, effective, name)? {
            out.kept_local_thread_writer_locks = true;
        }
    }
    let auth = effective.join("auth.json");
    if let LinkState::Symlink(_) = link_state(&auth)? {
        return Err(HomeLayoutError::PrivateEntrySymlink {
            entry: "auth.json".into(),
            path: auth,
        });
    }
    Ok(out)
}

#[cfg(unix)]
enum LinkState {
    Missing,
    NotSymlink,
    Symlink(PathBuf),
}

/// v1 `readLinkState`.
#[cfg(unix)]
fn link_state(path: &Path) -> Result<LinkState, HomeLayoutError> {
    match std::fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(LinkState::Missing),
        Err(source) => Err(HomeLayoutError::FileSystem {
            operation: "readLink",
            path: path.to_path_buf(),
            target: None,
            source,
        }),
        Ok(m) if m.file_type().is_symlink() => std::fs::read_link(path)
            .map(LinkState::Symlink)
            .map_err(|source| HomeLayoutError::FileSystem {
                operation: "readLink",
                path: path.to_path_buf(),
                target: None,
                source,
            }),
        Ok(_) => Ok(LinkState::NotSymlink),
    }
}

/// v1 `ensureSymlink`. Returns whether a local thread-writer-locks folder was kept.
#[cfg(unix)]
fn ensure_symlink(shared: &Path, effective: &Path, name: &str) -> Result<bool, HomeLayoutError> {
    let target = shared.join(name);
    let link = effective.join(name);
    let create = || {
        std::os::unix::fs::symlink(&target, &link).map_err(|source| HomeLayoutError::FileSystem {
            operation: "symlink",
            path: link.clone(),
            target: Some(target.clone()),
            source,
        })
    };
    let remove = |recursive: bool| {
        let result = if recursive {
            std::fs::remove_dir_all(&link).or_else(|_| std::fs::remove_file(&link))
        } else {
            std::fs::remove_file(&link)
        };
        result.map_err(|source| HomeLayoutError::FileSystem {
            operation: "remove",
            path: link.clone(),
            target: None,
            source,
        })
    };
    match link_state(&link)? {
        LinkState::Missing => create()?,
        LinkState::NotSymlink => {
            if !REPLACEABLE_SHARED_RUNTIME_ENTRIES.contains(&name) {
                return Err(HomeLayoutError::EntryConflict {
                    entry: name.into(),
                    link,
                });
            }
            if name == "thread-writer-locks" {
                // Codex deletes a thread lock on release, so one that is left may still guard a
                // live writer: keep the local folder until a later setup finds none.
                let read_error = |source: io::Error| HomeLayoutError::FileSystem {
                    operation: "readDirectory",
                    path: link.clone(),
                    target: None,
                    source,
                };
                // v1 fails on a directory it cannot read; so does an entry it cannot read.
                let mut live = false;
                for entry in std::fs::read_dir(&link).map_err(read_error)? {
                    let name = entry.map_err(read_error)?.file_name();
                    let name = name.to_string_lossy();
                    if name.ends_with(".lock") && name != ".coordination.lock" {
                        live = true;
                    }
                }
                if live {
                    return Ok(true);
                }
            }
            remove(true)?;
            create()?;
        }
        LinkState::Symlink(existing) => {
            let parent = link.parent().unwrap_or(effective);
            if absolute(&parent.join(existing)) != target {
                remove(false)?;
                create()?;
            }
        }
    }
    Ok(false)
}

/// What [Redactor] puts in place of the private home.
pub const REDACTED: &str = "<instance home>";

/// Replaces an instance's private home in outward text (errors, Codex's stderr, RPC messages,
/// probe messages): home paths are never logged or shown. Both the path as given and its
/// canonical form are replaced.
#[derive(Clone, Default)]
pub struct Redactor {
    needles: Vec<String>,
}

impl Redactor {
    /// For an instance overlay; nothing to redact for the shared home.
    pub fn for_layout(layout: Option<&HomeLayout>) -> Self {
        let Some(HomeLayout::AuthOverlay { effective, .. }) = layout else {
            return Self::default();
        };
        let mut needles = vec![effective.display().to_string()];
        if let Ok(canonical) = effective.canonicalize() {
            needles.push(canonical.display().to_string());
        }
        needles.retain(|n| !n.is_empty());
        needles.sort_by_key(|n| std::cmp::Reverse(n.len()));
        needles.dedup();
        Self { needles }
    }

    /// `text` with the private home replaced by "<instance home>".
    pub fn apply(&self, text: &str) -> String {
        self.needles
            .iter()
            .fold(text.to_string(), |t, n| t.replace(n.as_str(), REDACTED))
    }

    /// Whether `text` names the private home.
    pub fn mentions(&self, text: &str) -> bool {
        self.needles.iter().any(|n| text.contains(n.as_str()))
    }

    /// A serde value (a TurnItem with its commands, paths, prompts and summaries) with the
    /// private home replaced in every string and object key. Untouched unless it names the home.
    pub fn value<T: serde::Serialize + serde::de::DeserializeOwned>(&self, value: T) -> T {
        if self.needles.is_empty() {
            return value;
        }
        let Ok(mut json) = serde_json::to_value(&value) else {
            return value;
        };
        if !self.json_mentions(&json) {
            return value;
        }
        self.redact_json(&mut json);
        match serde_json::from_value(json) {
            Ok(redacted) => redacted,
            Err(_) => {
                // A serde round trip of a value just serialized; tests cover every item kind.
                debug_assert!(false, "redacted value no longer decodes");
                value
            }
        }
    }

    fn json_mentions(&self, json: &serde_json::Value) -> bool {
        match json {
            serde_json::Value::String(s) => self.mentions(s),
            serde_json::Value::Array(a) => a.iter().any(|v| self.json_mentions(v)),
            serde_json::Value::Object(o) => o
                .iter()
                .any(|(k, v)| self.mentions(k) || self.json_mentions(v)),
            _ => false,
        }
    }

    fn redact_json(&self, json: &mut serde_json::Value) {
        match json {
            serde_json::Value::String(s) => *s = self.apply(s),
            serde_json::Value::Array(a) => a.iter_mut().for_each(|v| self.redact_json(v)),
            serde_json::Value::Object(o) => {
                let entries = std::mem::take(o);
                for (k, mut v) in entries {
                    self.redact_json(&mut v);
                    o.insert(self.apply(&k), v);
                }
            }
            _ => {}
        }
    }
}

/// v1 `path.resolve`: absolute against the working directory, with `.` and `..` folded
/// lexically (symlinks are not followed).
fn absolute(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
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
