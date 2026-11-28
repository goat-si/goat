//! Codex driver wiring.
//!
//! `goat2-engine-codex` (lane B) owns the Codex app-server driver. The host supplies what the
//! driver cannot see: an attachment's saved file in the thread folder, and the local log where
//! Codex's stderr goes instead of a reason.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use goat2_contracts::{ChatAttachment, ProviderCapabilities, ThreadId};
use goat2_engine_codex::attachments::ResolvedAttachment;
use goat2_engine_codex::engine::{
    CodexDiagnostic, CodexEngineFactory, CodexEngineOptions, DiagnosticsSink,
};

/// Lane B's Codex driver with the host's attachment lookup. `codex_bin` is the Codex program
/// (`GOAT2_CODEX_BIN`); without it `codex` is looked up on the host's PATH, which the desktop
/// shell sets from the person's login shell.
pub fn codex_factory(data_dir: &Path, codex_bin: Option<&Path>) -> CodexEngineFactory {
    let threads = data_dir.join("threads");
    let defaults = CodexEngineOptions::default();
    CodexEngineFactory::new(CodexEngineOptions {
        program: codex_bin.map_or(defaults.program.clone(), Path::to_path_buf),
        attachment_resolver: Some(Arc::new(move |thread_id, attachment, want_bytes| {
            resolve_attachment(&threads, thread_id, attachment, want_bytes)
        })),
        diagnostics: Some(diagnostics_sink(data_dir)),
        ..defaults
    })
}

/// The Codex diagnostics log: `<dataDir>/logs/codex-diagnostics.ndjson`.
const DIAGNOSTICS_FILE: &str = "codex-diagnostics.ndjson";
/// The log is rotated to `.1` (one older file kept) past this size.
const DIAGNOSTICS_MAX_BYTES: u64 = 1024 * 1024;

/// Owner decision: Codex's raw stderr never goes into goat.jsonl (append-only, so anything that
/// slips in stays) or the UI. The driver hands it here scrubbed of credentials and the private
/// home, and the reason names its id ("details: diag <id>"). This is a local file, owner-only
/// (0600), rotated, and never synced.
fn diagnostics_sink(data_dir: &Path) -> DiagnosticsSink {
    let path = data_dir.join("logs").join(DIAGNOSTICS_FILE);
    let lock = Arc::new(Mutex::new(()));
    Arc::new(move |diagnostic: CodexDiagnostic| {
        let _one_writer = lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(error) = append_diagnostic(&path, &diagnostic) {
            tracing::warn!(diag = %diagnostic.id, %error, "codex diagnostics log not written");
        }
    })
}

fn append_diagnostic(path: &Path, diagnostic: &CodexDiagnostic) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if fs::metadata(path).is_ok_and(|m| m.len() > DIAGNOSTICS_MAX_BYTES) {
        fs::rename(path, path.with_extension("ndjson.1"))?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let line = serde_json::json!({
        "at": crate::util::now_rfc3339(),
        "diag": diagnostic.id,
        "thread": diagnostic.thread_id,
        "what": diagnostic.what,
        "stderr": diagnostic.text,
    });
    writeln!(file, "{line}")
}

/// The store's blob name rule (goat2-thread-store `valid_blob_name`).
fn valid_blob_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The thread id and blob name of an attachment that is one of the thread's saved blobs
/// (`blobs/<name>` with the store's name rule, a thread id that is one plain name).
fn blob_location<'a>(
    thread_id: &'a ThreadId,
    attachment: &'a ChatAttachment,
) -> Option<(&'a str, &'a str)> {
    let name = attachment
        .blob
        .as_ref()?
        .path
        .strip_prefix("blobs/")
        .filter(|n| valid_blob_name(n))?;
    let id = thread_id.as_str();
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', '\0']) {
        return None;
    }
    Some((id, name))
}

/// The attachment's saved file and, when the driver asks (native images are sent inline), its
/// bytes. The bytes are read through descriptors (`open_blob`), so no folder swapped for a
/// symlink can redirect them. The path only names the file in the text Codex reads (v1
/// `resolveAttachmentPath`); Codex opens it itself, as in v1. `None` makes the driver name the
/// attachment unavailable (an image declines the turn), as v1 does.
fn resolve_attachment(
    threads: &Path,
    thread_id: &ThreadId,
    attachment: &ChatAttachment,
    want_bytes: bool,
) -> Option<ResolvedAttachment> {
    let path = attachment_path(threads, thread_id, attachment)?;
    let bytes = if want_bytes {
        let (id, name) = blob_location(thread_id, attachment)?;
        Some(read_blob(threads, id, name)?)
    } else {
        None
    };
    Some(ResolvedAttachment { path, bytes })
}

/// `<dataDir>/threads/<threadId>/blobs/<name>` when the attachment is one of the thread's saved
/// blobs and nothing on the way (thread folder, blobs folder, file) is a symlink.
pub(crate) fn attachment_path(
    threads: &Path,
    thread_id: &ThreadId,
    attachment: &ChatAttachment,
) -> Option<PathBuf> {
    let (id, name) = blob_location(thread_id, attachment)?;
    let thread_dir = threads.join(id);
    let blobs = thread_dir.join("blobs");
    let path = blobs.join(name);
    let plain_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
    let plain_file = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file());
    (plain_dir(&thread_dir) && plain_dir(&blobs) && plain_file).then_some(path)
}

/// Reads `<threads>/<id>/blobs/<name>` one component at a time: each folder is opened relative
/// to the descriptor of the one before it, and every step (folders and the file) refuses a
/// symlink (`O_NOFOLLOW`). A folder replaced by a symlink before its step is refused; one
/// replaced after its step no longer matters, the held descriptor still names the original.
/// Only a regular file is read.
#[cfg(unix)]
fn read_blob(threads: &Path, id: &str, name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let threads_fd = unix_fs::open_dir(threads)?;
    let thread_fd = unix_fs::open_dir_at(&threads_fd, id)?;
    let blobs_fd = unix_fs::open_dir_at(&thread_fd, "blobs")?;
    let mut file = unix_fs::open_file_at(&blobs_fd, name)?;
    let mut out = Vec::new();
    file.read_to_end(&mut out).ok()?;
    Some(out)
}

/// Windows is Part 2 (no descriptor-relative opens here yet): the same checks, then a read.
#[cfg(not(unix))]
fn read_blob(threads: &Path, id: &str, name: &str) -> Option<Vec<u8>> {
    let path = threads.join(id).join("blobs").join(name);
    let plain_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
    let plain_file = std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file());
    if !(plain_dir(&threads.join(id)) && plain_dir(&threads.join(id).join("blobs")) && plain_file) {
        return None;
    }
    std::fs::read(path).ok()
}

#[cfg(unix)]
mod unix_fs {
    use std::ffi::CString;
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    const DIR_FLAGS: libc::c_int =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    fn owned(fd: libc::c_int) -> Option<OwnedFd> {
        // SAFETY: a non-negative descriptor was just returned to us and nothing else owns it.
        (fd >= 0).then(|| unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// The threads folder (the trusted root under the host's data dir).
    pub(super) fn open_dir(path: &Path) -> Option<OwnedFd> {
        let c = CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: `c` is a valid NUL-terminated path.
        owned(unsafe { libc::open(c.as_ptr(), DIR_FLAGS) })
    }

    /// One folder named `name` (a single component) inside `dir`, never through a symlink.
    pub(super) fn open_dir_at(dir: &OwnedFd, name: &str) -> Option<OwnedFd> {
        let c = CString::new(name).ok()?;
        // SAFETY: `dir` is an open descriptor; `c` is a valid NUL-terminated component.
        owned(unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), DIR_FLAGS) })
    }

    /// The regular file `name` inside `dir`, never through a symlink. `O_NONBLOCK` keeps a FIFO
    /// from blocking the open; it is then refused as not a regular file.
    pub(super) fn open_file_at(dir: &OwnedFd, name: &str) -> Option<File> {
        let c = CString::new(name).ok()?;
        // SAFETY: `dir` is an open descriptor; `c` is a valid NUL-terminated component.
        let fd = owned(unsafe {
            libc::openat(
                dir.as_raw_fd(),
                c.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        })?;
        let file = File::from(fd);
        file.metadata().ok()?.is_file().then_some(file)
    }
}

/// v1 `CodexProviderCapabilitiesV2`, from lane B's driver (one copy, compared whole with v1
/// `CodexCapabilities.ts` by its tests). The fake engine reports the same flags.
pub fn codex_capabilities() -> ProviderCapabilities {
    goat2_engine_codex::capabilities::codex_capabilities()
}

#[cfg(test)]
mod tests {
    use goat2_contracts::{BlobRef, ChatAttachment, ChatAttachmentType, ThreadId};

    use super::attachment_path;

    /// Owner decision: Codex's stderr lands in the local diagnostics log under the id the
    /// reason names, owner-only, and the log rotates.
    #[test]
    fn codex_diagnostics_go_to_a_private_rotating_local_log() {
        use goat2_engine_codex::engine::CodexDiagnostic;
        let dir = std::env::temp_dir().join(format!("goat2-codex-diag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sink = super::diagnostics_sink(&dir);
        let diagnostic = |id: &str, text: String| CodexDiagnostic {
            id: id.into(),
            thread_id: "t1".into(),
            what: "exit",
            text,
        };
        sink(diagnostic("0000abcd", "codex: boom".into()));
        let path = dir.join("logs").join(super::DIAGNOSTICS_FILE);
        let line: serde_json::Value =
            serde_json::from_str(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
        assert_eq!(line["diag"], "0000abcd");
        assert_eq!(line["thread"], "t1");
        assert_eq!(line["what"], "exit");
        assert_eq!(line["stderr"], "codex: boom");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // Past the size bound the log moves to .1 and a new one starts.
        let big = "x".repeat(super::DIAGNOSTICS_MAX_BYTES as usize + 1);
        sink(diagnostic("00000002", big));
        sink(diagnostic("00000003", "after".into()));
        assert!(dir.join("logs").join("codex-diagnostics.ndjson.1").exists());
        let now = std::fs::read_to_string(&path).unwrap();
        assert!(
            now.contains("00000003") && !now.contains("0000abcd"),
            "{now}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn image(path: &str) -> ChatAttachment {
        ChatAttachment {
            kind: ChatAttachmentType::Image,
            id: "a".into(),
            name: "a.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 1,
            blob: Some(BlobRef {
                path: path.into(),
                size_bytes: 1,
            }),
        }
    }

    #[cfg(unix)]
    #[test]
    fn attachments_never_reach_through_a_symlink_or_outside_blobs() {
        let dir = tempfile::tempdir().unwrap();
        let threads = dir.path().join("threads");
        std::fs::create_dir_all(threads.join("t1/blobs")).unwrap();
        std::fs::write(threads.join("t1/goat.jsonl"), b"log").unwrap();
        std::fs::write(dir.path().join("outside.png"), b"x").unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("outside.png"),
            threads.join("t1/blobs/link.png"),
        )
        .unwrap();
        std::fs::create_dir_all(dir.path().join("elsewhere/blobs")).unwrap();
        std::fs::write(dir.path().join("elsewhere/blobs/b.png"), b"x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("elsewhere"), threads.join("t2")).unwrap();
        let t1 = ThreadId::new("t1");
        for bad in [
            "goat.jsonl",
            "card.json",
            "blobs/link.png",
            "blobs/../goat.jsonl",
            "blobs/.hidden",
        ] {
            assert_eq!(attachment_path(&threads, &t1, &image(bad)), None, "{bad}");
            assert_eq!(
                super::resolve_attachment(&threads, &t1, &image(bad), true),
                None,
                "{bad}"
            );
        }
        // Reading directly (no path check first) still refuses the symlinked file and folder.
        assert_eq!(super::read_blob(&threads, "t1", "link.png"), None);
        assert_eq!(super::read_blob(&threads, "t2", "b.png"), None);
        assert_eq!(
            attachment_path(&threads, &ThreadId::new("t2"), &image("blobs/b.png")),
            None
        );
    }

    /// The review r3 race, made deterministic by running the read's steps by hand: a thread
    /// folder swapped for a symlink before its step is refused; one swapped after its step
    /// cannot redirect the read (the held descriptor still names the original folder).
    #[cfg(unix)]
    #[test]
    fn a_thread_folder_swapped_for_a_symlink_mid_read_cannot_redirect_it() {
        use std::io::Read;

        use super::unix_fs::{open_dir, open_dir_at, open_file_at};
        let dir = tempfile::tempdir().unwrap();
        let threads = dir.path().join("threads");
        std::fs::create_dir_all(threads.join("t1/blobs")).unwrap();
        std::fs::write(threads.join("t1/blobs/a.png"), b"inside").unwrap();
        std::fs::create_dir_all(dir.path().join("outside/blobs")).unwrap();
        std::fs::write(dir.path().join("outside/blobs/a.png"), b"outside").unwrap();
        let swap = || {
            std::fs::rename(threads.join("t1"), threads.join("t1-moved")).unwrap();
            std::os::unix::fs::symlink(dir.path().join("outside"), threads.join("t1")).unwrap();
        };
        let unswap = || {
            std::fs::remove_file(threads.join("t1")).unwrap();
            std::fs::rename(threads.join("t1-moved"), threads.join("t1")).unwrap();
        };

        // Swapped after the thread folder was opened: the read still gets the thread's own file.
        let threads_fd = open_dir(&threads).unwrap();
        let thread_fd = open_dir_at(&threads_fd, "t1").unwrap();
        swap();
        let blobs_fd = open_dir_at(&thread_fd, "blobs").unwrap();
        let mut bytes = Vec::new();
        open_file_at(&blobs_fd, "a.png")
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, b"inside");

        // Swapped before: the step refuses the symlink, and the whole read gives nothing.
        assert!(open_dir_at(&threads_fd, "t1").is_none());
        assert_eq!(super::read_blob(&threads, "t1", "a.png"), None);
        unswap();
        assert_eq!(
            super::read_blob(&threads, "t1", "a.png").as_deref(),
            Some(&b"inside"[..])
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_blob_is_refused_without_blocking() {
        let dir = tempfile::tempdir().unwrap();
        let threads = dir.path().join("threads");
        std::fs::create_dir_all(threads.join("t1/blobs")).unwrap();
        let fifo =
            std::ffi::CString::new(threads.join("t1/blobs/f.png").to_str().unwrap().to_string())
                .unwrap();
        // SAFETY: a valid NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(super::read_blob(&threads, "t1", "f.png"), None);
    }

    #[test]
    fn the_resolver_reads_bytes_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("threads/t1/blobs")).unwrap();
        std::fs::write(dir.path().join("threads/t1/blobs/a.png"), b"png").unwrap();
        let factory = super::codex_factory(dir.path(), None);
        let resolve = factory.options.attachment_resolver.clone().unwrap();
        let t1 = ThreadId::new("t1");
        let path_only = resolve(&t1, &image("blobs/a.png"), false).unwrap();
        assert_eq!(path_only.path, dir.path().join("threads/t1/blobs/a.png"));
        assert_eq!(path_only.bytes, None);
        assert_eq!(
            resolve(&t1, &image("blobs/a.png"), true)
                .unwrap()
                .bytes
                .as_deref(),
            Some(&b"png"[..])
        );
    }

    #[test]
    fn the_codex_program_comes_from_host_config_or_path() {
        let dir = tempfile::tempdir().unwrap();
        let fake = std::path::Path::new("/opt/parity/fake-codex");
        assert_eq!(
            super::codex_factory(dir.path(), Some(fake)).options.program,
            fake
        );
        assert_eq!(
            super::codex_factory(dir.path(), None).options.program,
            std::path::PathBuf::from("codex")
        );
        assert!(
            super::codex_factory(dir.path(), None)
                .options
                .attachment_resolver
                .is_some()
        );
    }

    #[test]
    fn v1_codex_capabilities_decode() {
        let caps = super::codex_capabilities();
        assert!(caps.turns.supports_active_steering);
        assert!(caps.sessions.supports_model_switch_in_session);
        assert!(caps.memory.is_none());
    }

    #[test]
    fn attachments_resolve_only_to_saved_files_inside_their_thread_folder() {
        let dir = tempfile::tempdir().unwrap();
        let threads = dir.path().join("threads");
        std::fs::create_dir_all(threads.join("t1/blobs")).unwrap();
        std::fs::write(threads.join("t1/blobs/a.png"), b"png").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"x").unwrap();
        let at = |path: Option<&str>| ChatAttachment {
            kind: ChatAttachmentType::Image,
            id: "a".into(),
            name: "a.png".into(),
            mime_type: "image/png".into(),
            size_bytes: 3,
            blob: path.map(|p| BlobRef {
                path: p.into(),
                size_bytes: 3,
            }),
        };
        let t1 = ThreadId::new("t1");
        assert_eq!(
            attachment_path(&threads, &t1, &at(Some("blobs/a.png"))),
            Some(threads.join("t1/blobs/a.png"))
        );
        for bad in [
            "blobs/missing.png",
            "../../secret.txt",
            "/etc/hosts",
            "",
            "./blobs/a.png",
        ] {
            assert_eq!(
                attachment_path(&threads, &t1, &at(Some(bad))),
                None,
                "{bad}"
            );
        }
        assert_eq!(attachment_path(&threads, &t1, &at(None)), None);
        assert_eq!(
            attachment_path(&threads, &ThreadId::new(".."), &at(Some("secret.txt"))),
            None
        );
    }
}
