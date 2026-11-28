//! Codex driver wiring.
//!
//! `goat2-engine-codex` (lane B) owns the Codex app-server driver. The host supplies the one
//! thing the driver cannot see: where an attachment's file is in the thread folder.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use goat2_contracts::{ChatAttachment, ProviderCapabilities, ThreadId};
use goat2_engine_codex::engine::{CodexEngineFactory, CodexEngineOptions};

/// Lane B's Codex driver with defaults (`codex` on PATH) and the host's attachment lookup.
pub fn codex_factory(data_dir: &Path) -> CodexEngineFactory {
    let threads = data_dir.join("threads");
    CodexEngineFactory::new(CodexEngineOptions {
        attachment_resolver: Some(Arc::new(move |thread_id, attachment| {
            attachment_path(&threads, thread_id, attachment)
        })),
        ..Default::default()
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

/// v1 `CodexProviderCapabilitiesV2`, values verbatim from goat-si/goat origin/dev 916b5ccc
/// `apps/server/src/orchestration-v2/Adapters/CodexCapabilities.ts:3-101` (v1 sets no `memory`).
pub fn codex_capabilities() -> ProviderCapabilities {
    serde_json::from_value(serde_json::json!({
        "sessions": {
            "supportsMultipleProviderThreadsPerSession": true,
            "supportsModelSwitchInSession": true,
            "supportsProviderSwitchingViaHandoff": true,
            "supportsRuntimeModeSwitchInSession": true,
            "pendingRequestsSurviveRestart": false
        },
        "threads": {
            "canCreateEmptyThread": true,
            "canReadThreadSnapshot": true,
            "canRollbackThread": true,
            "canForkThread": true,
            "canForkFromTurn": true,
            "canForkWhileSourceRunning": true,
            "canForkFromSubagentThread": true,
            "exposesNativeThreadId": true,
            "forkHonorsTargetCwd": true
        },
        "turns": {
            "exposesNativeTurnId": true,
            "emitsTurnStarted": true,
            "emitsTurnCompleted": true,
            "supportsInterrupt": true,
            "supportsNativeResume": true,
            "supportsActiveSteering": true,
            "activeSteeringDuringCompaction": true,
            "supportsSteeringByInterruptRestart": true,
            "supportsQueuedMessages": true,
            "terminalStatusQuality": "strong"
        },
        "streaming": {
            "streamsAssistantText": true,
            "streamsReasoning": true,
            "streamsToolOutput": true,
            "streamsPlanText": true,
            "emitsMessageCompleted": true
        },
        "tools": {
            "exposesToolItemIds": true,
            "emitsToolStarted": true,
            "emitsToolCompleted": true,
            "emitsToolOutput": true,
            "supportsMcpTools": true,
            "supportsDynamicToolCallbacks": true
        },
        "approvals": {
            "supportsCommandApproval": true,
            "supportsFileReadApproval": true,
            "supportsFileChangeApproval": true,
            "supportsApplyPatchApproval": true,
            "approvalsHaveNativeRequestIds": true,
            "approvalCallbacksAreLiveOnly": true,
            "approvalsCanOriginateFromSubagents": true
        },
        "planning": {
            "emitsPlanUpdated": true,
            "emitsTodoList": true,
            "emitsProposedPlan": true,
            "supportsStructuredQuestions": true,
            "planDeltasHaveItemIds": true
        },
        "subagents": {
            "supportsSubagents": true,
            "exposesSubagentThreadIds": true,
            "emitsSubagentLifecycle": true,
            "canWaitForSubagents": true,
            "canCloseSubagents": true,
            "canForkSubagentThread": true
        },
        "context": {
            "acceptsSystemContext": true,
            "acceptsDeveloperContext": true,
            "acceptsSyntheticUserContext": true,
            "canGenerateSummaries": true,
            "canConsumeHandoffSummaries": true,
            "supportsDeltaHandoff": true,
            "supportsFullThreadHandoff": true,
            "maxRecommendedHandoffChars": null
        },
        "checkpointing": {
            "appCanCheckpointFilesystem": true,
            "supportsNestedCheckpointScopes": true,
            "providerCanRollbackConversation": true,
            "providerRollbackReturnsSnapshot": true,
            "providerCanReadConversationSnapshot": true
        },
        "identity": {
            "nativeThreadIds": "strong",
            "nativeTurnIds": "strong",
            "nativeItemIds": "strong",
            "nativeRequestIds": "strong"
        },
        "runtimePolicy": { "enforcement": "native" }
    }))
    .expect("v1 Codex capabilities decode as the contract type")
}

#[cfg(test)]
mod tests {
    use goat2_contracts::{BlobRef, ChatAttachment, ChatAttachmentType, ThreadId};

    use super::attachment_path;

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
