//! The fake codex replays a real recording when fed the recorded outbound frames, and names the
//! mismatch when fed a wrong one.

mod support;

use goat2_engine_codex::transcript::Entry;
use goat2_engine_codex::transport::TransportConfig;
use serde_json::Value;
use support::fake::{fake_exit_of, load, spawn_fake};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Drive the fake with raw frames: send each recorded outbound frame (with a fresh id for
/// requests) and read the inbound ones.
async fn replay_raw(name: &str, corrupt: bool) -> (Option<i32>, String) {
    let transcript = load(&format!("codex-0.167.0/{name}.json"));
    let path = support::fake::write_temp(&transcript);
    let mut launch = support::fake::fake_launch(&path, false);
    // The exit code is the assertion: give a busy machine time to let the (niced) fake exit.
    launch.kill_grace = std::time::Duration::from_secs(10);
    let mut child = goat2_engine_codex::process::ChildProcess::spawn(&launch).unwrap();
    let mut stdin = child.take_stdin().unwrap();
    let mut lines = BufReader::new(child.take_stdout().unwrap()).lines();
    let mut next_id = 100;
    let mut corrupted = false;
    for entry in &transcript.entries {
        match entry {
            Entry::ExpectOutbound { frame, .. } => {
                let mut frame: Value = frame.clone();
                if frame.get("method").is_some() && frame.get("id").is_some() {
                    frame["id"] = Value::from(next_id);
                    next_id += 1;
                }
                if corrupt && !corrupted && frame["method"] == "turn/start" {
                    frame["params"]["threadId"] = Value::from("not-the-recorded-thread");
                    corrupted = true;
                }
                stdin
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .unwrap();
                if corrupted {
                    break;
                }
            }
            Entry::EmitInbound { .. } => {
                let line =
                    tokio::time::timeout(std::time::Duration::from_secs(5), lines.next_line())
                        .await
                        .expect("fake answered")
                        .unwrap()
                        .expect("a line");
                let _: Value = serde_json::from_str(&line).unwrap();
            }
            Entry::RuntimeExit { .. } => break,
        }
    }
    drop(stdin);
    let summary = child.shutdown().await;
    (summary.status.and_then(|s| s.code()), child.stderr_tail())
}

#[tokio::test]
async fn recordings_replay_with_fresh_request_ids() {
    for name in ["basic", "steer", "interrupt", "approval", "resume"] {
        let (code, stderr) = replay_raw(name, false).await;
        assert_eq!(code, Some(0), "{name}: {stderr}");
    }
}

#[tokio::test]
async fn a_wrong_frame_is_named() {
    let (code, stderr) = replay_raw("basic", true).await;
    assert_eq!(code, Some(3), "{stderr}");
    assert!(stderr.contains("/params/threadId"), "{stderr}");
}

#[tokio::test]
async fn connection_level_replay_reports_clean_exit() {
    let t = load("codex-0.167.0/basic.json");
    let mut s = spawn_fake(&t, false, TransportConfig::default());
    // Nothing sent: the fake is waiting for initialize; closing input makes it exit 4 (EOF).
    let (code, _) = fake_exit_of(&mut s).await;
    assert_eq!(code, Some(4));
}
