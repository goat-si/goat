//! Claude driver wiring.
//!
//! `goat2-engine-claude` (lane P2-A) owns the Claude Code driver. The host supplies what the
//! driver cannot see: the program (`GOAT2_CLAUDE_BIN`), GOAT 2's own Claude home and an
//! attachment's saved file in the thread folder.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use goat2_engine_claude::{ClaudeEngineFactory, ClaudeEngineOptions};

/// GOAT 2's Claude home for the default instance: `<dataDir>/claude-home`. The Claude child gets
/// it as `CLAUDE_CONFIG_DIR`, set over anything the host inherited, so GOAT 2 never reads or
/// writes the person's own `~/.claude` session (owner decision; v1 keeps its own
/// `~/.goat/claude-home` the same way). An instance with its own home (`ProviderTarget`)
/// replaces it per session.
pub fn claude_home(data_dir: &Path) -> PathBuf {
    data_dir.join("claude-home")
}

/// Lane P2-A's Claude driver with the host's program, home and attachment lookup. `claude_bin`
/// is `GOAT2_CLAUDE_BIN`; without it `claude` is looked up on the host's PATH, which the desktop
/// shell sets from the person's login shell.
pub fn claude_factory(data_dir: &Path, claude_bin: Option<&Path>) -> ClaudeEngineFactory {
    let home = claude_home(data_dir);
    // Created private before Claude writes credentials into it; Claude creates it itself if this
    // fails, so a failure here only loses the 0700 mode.
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&home);
    }
    #[cfg(not(unix))]
    let _ = std::fs::create_dir_all(&home);
    let threads = data_dir.join("threads");
    let mut options = ClaudeEngineOptions::default();
    if let Some(bin) = claude_bin {
        options.launch.binary = bin.to_path_buf();
    }
    options.launch.env.push((
        "CLAUDE_CONFIG_DIR".to_owned(),
        home.to_string_lossy().into_owned(),
    ));
    // Claude reads attachments itself: the driver only needs the saved file's path.
    options.attachments = Some(Arc::new(move |thread_id, attachment| {
        super::codex::attachment_path(&threads, thread_id, attachment)
    }));
    ClaudeEngineFactory::new(options)
}

#[cfg(test)]
mod tests {
    use goat2_contracts::{BlobRef, ChatAttachment, ChatAttachmentType, ThreadId};

    fn attachment(path: &str) -> ChatAttachment {
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

    #[test]
    fn claude_runs_in_goat2s_own_home_with_the_configured_program() {
        let dir = tempfile::tempdir().unwrap();
        let factory = super::claude_factory(dir.path(), Some(std::path::Path::new("/opt/claude")));
        let home = dir.path().join("claude-home");
        assert_eq!(
            factory.options.launch.binary,
            std::path::PathBuf::from("/opt/claude")
        );
        assert_eq!(
            factory.options.launch.env.last(),
            Some(&(
                "CLAUDE_CONFIG_DIR".to_owned(),
                home.to_string_lossy().into_owned()
            ))
        );
        assert!(home.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&home).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        assert_eq!(
            super::claude_factory(dir.path(), None)
                .options
                .launch
                .binary,
            std::path::PathBuf::from("claude")
        );
    }

    #[test]
    fn attachments_resolve_only_to_saved_blobs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("threads/t1/blobs")).unwrap();
        std::fs::write(dir.path().join("threads/t1/blobs/a.png"), b"png").unwrap();
        let factory = super::claude_factory(dir.path(), None);
        let resolve = factory.options.attachments.clone().unwrap();
        let t1 = ThreadId::new("t1");
        assert_eq!(
            resolve(&t1, &attachment("blobs/a.png")),
            Some(dir.path().join("threads/t1/blobs/a.png"))
        );
        assert_eq!(resolve(&t1, &attachment("../secret")), None);
        assert_eq!(
            resolve(&ThreadId::new("../t1"), &attachment("blobs/a.png")),
            None
        );
    }
}
