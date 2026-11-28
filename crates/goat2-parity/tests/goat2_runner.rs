//! The GOAT 2 runner drives a real goat2-host process with the fake codex.
use goat2_parity::trace::{ObservedTrace, Outcome, TraceEvent};
use std::path::PathBuf;

#[test]
fn goat2_runner_drives_the_host_on_simple_turn() {
    let runner = PathBuf::from(env!("CARGO_BIN_EXE_goat2-parity-goat2-runner"));
    let host = runner.with_file_name("goat2-host");
    if !host.is_file() {
        println!(
            "SKIPPED goat2 runner process test: build goat2-host first (cargo test --workspace does)"
        );
        return;
    }
    let out = std::env::temp_dir().join(format!("goat2-runner-test-{}.json", std::process::id()));
    let status = std::process::Command::new(&runner)
        .arg("--scenario")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios/simple_turn"))
        .arg("--out")
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success());
    let trace: ObservedTrace = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    let _ = std::fs::remove_file(&out);
    assert_eq!(trace.target, "goat2");
    // The host accepted the input and started a run either way.
    assert!(
        trace
            .events
            .iter()
            .any(|e| matches!(&e.event, TraceEvent::InputAccepted { input, .. } if input == "i1"))
    );
    assert!(
        trace
            .events
            .iter()
            .any(|e| matches!(&e.event, TraceEvent::RunStarted { .. }))
    );
    match &trace.outcome {
        // Until lane B wires goat2-host's CodexFactory to goat2-engine-codex (owner 2026-11-29),
        // the host refuses to start the engine. After that merge this run reaches the fake codex
        // and this arm stops matching: then expect Outcome::Ok and a consumed stream.
        Outcome::Error { reason } if reason.contains("Codex driver") => {}
        Outcome::Ok => assert!(trace.streams["codex"].consumed_all, "{trace:?}"),
        other => panic!("unexpected outcome {other:?}"),
    }
}
