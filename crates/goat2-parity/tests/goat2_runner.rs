//! The GOAT 2 runner drives a real goat2-host process (lane B's Codex driver, goat2 3debd307224)
//! with the fake codex replaying the scenario's v1 recording.
use goat2_parity::{
    compare::compare,
    scenario::LoadedScenario,
    trace::{ObservedTrace, Outcome},
};
use std::path::{Path, PathBuf};

fn run(scenario: &Path) -> Option<ObservedTrace> {
    let runner = PathBuf::from(env!("CARGO_BIN_EXE_goat2-parity-goat2-runner"));
    if !runner.with_file_name("goat2-host").is_file() {
        println!(
            "SKIPPED goat2 runner process test: build goat2-host first (cargo test --workspace does)"
        );
        return None;
    }
    let out = std::env::temp_dir().join(format!(
        "goat2-runner-test-{}-{}.json",
        std::process::id(),
        scenario.file_name().unwrap().to_string_lossy()
    ));
    let status = std::process::Command::new(&runner)
        .arg("--scenario")
        .arg(scenario)
        .arg("--out")
        .arg(&out)
        .status()
        .unwrap();
    assert!(status.success());
    let trace = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    let _ = std::fs::remove_file(&out);
    Some(trace)
}

fn scenarios() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios")
}

#[test]
fn simple_turn_passes_on_goat2() {
    let dir = scenarios().join("simple_turn");
    let Some(trace) = run(&dir) else { return };
    assert_eq!(trace.target, "goat2");
    assert_eq!(trace.outcome, Outcome::Ok, "{trace:?}");
    assert!(trace.streams["codex"].consumed_all, "{trace:?}");
    let report = compare(&LoadedScenario::load(&dir).unwrap(), &trace);
    assert!(report.passed(), "{report:?}");
}

/// A prompt that differs from the recorded one reaches the fake as a different turn/start text:
/// the stream report names it and the comparison fails.
#[test]
fn a_wrong_prompt_fails_on_goat2() {
    let src = scenarios().join("simple_turn");
    let dir = std::env::temp_dir().join(format!("goat2-runner-wrong-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("transcripts")).unwrap();
    std::fs::copy(
        src.join("transcripts/codex.ndjson"),
        dir.join("transcripts/codex.ndjson"),
    )
    .unwrap();
    let mut json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(src.join("scenario.json")).unwrap()).unwrap();
    json["steps"][0]["text"] = "Respond with the following text: something else".into();
    std::fs::write(
        dir.join("scenario.json"),
        serde_json::to_vec(&json).unwrap(),
    )
    .unwrap();
    let trace = run(&dir);
    let loaded = LoadedScenario::load(&dir).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let Some(trace) = trace else { return };
    assert!(
        trace.streams["codex"]
            .outbound_mismatches
            .iter()
            .any(|m| m.contains("text differs")),
        "{trace:?}"
    );
    assert!(!compare(&loaded, &trace).passed());
}
