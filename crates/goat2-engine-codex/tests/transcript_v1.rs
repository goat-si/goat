//! Transcripts in GOAT v1's replay format (packages/effect-codex-app-server/src/replay.ts:16-45)
//! round-trip through [Transcript]: camelCase `afterMs`, and all three runtime_exit statuses.

use goat2_engine_codex::transcript::{Entry, ExitKind, Transcript, canonical};
use serde_json::json;

#[test]
fn v1_shaped_transcript_round_trips() {
    let v1 = json!({
        "provider": "codex",
        "protocol": "codex.app-server",
        "version": "0.156.1",
        "scenario": "v1-shape",
        "metadata": {"source": "replay.test.ts shape"},
        "entries": [
            {"type": "expect_outbound", "label": "initialize", "frame": {"id": 1, "method": "initialize", "params": {}}},
            {"type": "emit_inbound", "label": "init-ok", "frame": {"id": 1, "result": {}}, "afterMs": 5},
            {"type": "emit_inbound", "frame": {"method": "turn/started", "params": {}}},
            {"type": "runtime_exit", "status": "cancelled"}
        ]
    });
    let transcript: Transcript = serde_json::from_value(v1.clone()).unwrap();
    assert!(matches!(
        transcript.entries[1],
        Entry::EmitInbound {
            after_ms: Some(5),
            ..
        }
    ));
    assert!(matches!(
        transcript.entries[3],
        Entry::RuntimeExit {
            status: ExitKind::Cancelled,
            ..
        }
    ));
    let back = serde_json::to_value(&transcript).unwrap();
    assert_eq!(canonical(&back), canonical(&v1));
    for status in ["success", "error", "cancelled"] {
        let entry: Entry =
            serde_json::from_value(json!({"type": "runtime_exit", "status": status})).unwrap();
        assert!(matches!(entry, Entry::RuntimeExit { .. }));
    }
}
