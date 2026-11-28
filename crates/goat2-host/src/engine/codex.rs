//! Codex driver wiring.
//!
//! `goat2-engine-codex` (lane B) owns the Codex app-server driver. The host supplies the one
//! thing the driver cannot see: where an attachment's file is in the thread folder.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use goat2_contracts::{ChatAttachment, ProviderCapabilities, ThreadId};
use goat2_engine_codex::engine::{CodexEngineFactory, CodexEngineOptions};

/// Lane B's Codex driver with the host's attachment lookup. `codex_bin` is the Codex program
/// (`GOAT2_CODEX_BIN`); without it `codex` is looked up on the host's PATH, which the desktop
/// shell sets from the person's login shell.
pub fn codex_factory(data_dir: &Path, codex_bin: Option<&Path>) -> CodexEngineFactory {
    let threads = data_dir.join("threads");
    let defaults = CodexEngineOptions::default();
    CodexEngineFactory::new(CodexEngineOptions {
        program: codex_bin.map_or(defaults.program.clone(), Path::to_path_buf),
        attachment_resolver: Some(Arc::new(move |thread_id, attachment| {
            attachment_path(&threads, thread_id, attachment)
        })),
        ..defaults
    })
}

/// `<dataDir>/threads/<threadId>/<blob.path>` when the attachment has a saved file there. A path
/// that is absolute or leaves the thread folder, or a missing file, gives `None`: the driver then
/// names the attachment unavailable (an image declines the turn), as v1 does.
fn attachment_path(
    threads: &Path,
    thread_id: &ThreadId,
    attachment: &ChatAttachment,
) -> Option<PathBuf> {
    let inside = |p: &Path| {
        p.components().next().is_some() && p.components().all(|c| matches!(c, Component::Normal(_)))
    };
    let thread = Path::new(thread_id.as_str());
    let rel = Path::new(&attachment.blob.as_ref()?.path);
    if !inside(thread) || !inside(rel) {
        return None;
    }
    let path = threads.join(thread).join(rel);
    path.is_file().then_some(path)
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
