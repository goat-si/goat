use goat2_parity::{
    scenario::LoadedScenario,
    transcript::{self, Record},
};
use std::{fs, path::PathBuf};
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios")
}
#[test]
fn all_scenarios_load() {
    let mut count = 0;
    for entry in fs::read_dir(root()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            LoadedScenario::load(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            count += 1;
        }
    }
    assert_eq!(count, 16);
}
#[test]
fn steer_error_only_outbound_contains_steer() {
    let dir = root().join("steer_rpc_error_codex");
    let s = LoadedScenario::load(&dir).unwrap();
    let stream = &s.scenario.streams["codex"];
    let records = transcript::parse(&fs::read(dir.join(&stream.transcript)).unwrap()).unwrap();
    let steer = "Actually, respond with exactly: steering fixture observed";
    let mut outbound = 0;
    for record in records {
        match record {
            Record::ExpectOutbound { frame, .. }
                if frame.get("method").and_then(|x| x.as_str()) == Some("turn/steer")
                    && frame.to_string().contains(steer) =>
            {
                outbound += 1;
            }
            Record::EmitInbound { frame, .. } => {
                let text = frame.to_string();
                assert!(!text.contains("steering fixture observed"));
                assert!(!text.contains(steer));
            }
            _ => {}
        }
    }
    assert_eq!(outbound, 1);
}
#[test]
fn pinned_prompts_match_source_when_available() {
    let Some(v1) = std::env::var_os("GOAT_V1_ROOT") else {
        println!("SKIPPED pinned source checks: GOAT_V1_ROOT unset");
        return;
    };
    for entry in fs::read_dir(root()).unwrap() {
        let dir = entry.unwrap().path();
        if !dir.is_dir() {
            continue;
        }
        let s = LoadedScenario::load(&dir).unwrap();
        for stream in s.scenario.streams.values() {
            let data = fs::read(PathBuf::from(&v1).join(&stream.provenance.source)).unwrap();
            transcript::verify_hash(&data, &stream.provenance.source_sha256).unwrap();
            if stream.provenance.transform.is_none() {
                assert_eq!(data, fs::read(dir.join(&stream.transcript)).unwrap());
            }
            let text = String::from_utf8(data).unwrap();
            for step in &s.scenario.steps {
                if let goat2_parity::scenario::Step::Send { text: prompt, .. } = step
                    && prompt != "temporary queued text"
                    && prompt != "steer after completion"
                {
                    assert!(text.contains(prompt), "{}: {prompt}", s.scenario.name);
                }
            }
        }
    }
}

#[test]
fn transformed_source_hash_mismatch_fails_when_v1_available() {
    let Some(v1) = std::env::var_os("GOAT_V1_ROOT") else {
        println!("SKIPPED transformed source hash check: GOAT_V1_ROOT unset");
        return;
    };
    let original = root().join("steer_rpc_error_codex");
    let temp = std::env::temp_dir().join(format!("parity-source-hash-{}", std::process::id()));
    let case = temp.join("case");
    fs::create_dir_all(case.join("transcripts")).unwrap();
    let mut json: serde_json::Value =
        serde_json::from_slice(&fs::read(original.join("scenario.json")).unwrap()).unwrap();
    json["streams"]["codex"]["provenance"]["sourceSha256"] = "0".repeat(64).into();
    fs::write(
        case.join("scenario.json"),
        serde_json::to_vec(&json).unwrap(),
    )
    .unwrap();
    fs::copy(
        original.join("transcripts/codex.ndjson"),
        case.join("transcripts/codex.ndjson"),
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_goat2-parity"))
        .arg("validate")
        .arg("--scenarios")
        .arg(&temp)
        .env("GOAT_V1_ROOT", v1)
        .output()
        .unwrap();
    let _ = fs::remove_dir_all(&temp);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("sha256 mismatch"));
}

#[test]
fn queue_cancel_transcript_is_source_prefix_and_runtime_exit() {
    let Some(v1) = std::env::var_os("GOAT_V1_ROOT") else {
        println!("SKIPPED queue cancel source check: GOAT_V1_ROOT unset");
        return;
    };
    let dir = root().join("queue_cancel_while_active");
    let loaded = LoadedScenario::load(&dir).unwrap();
    let stream = &loaded.scenario.streams["codex"];
    let source = fs::read_to_string(PathBuf::from(v1).join(&stream.provenance.source)).unwrap();
    let mut expected: String = source.split_inclusive('\n').take(32).collect();
    assert_eq!(expected.lines().count(), 32);
    expected.push_str("{\"type\":\"runtime_exit\",\"status\":\"success\"}\n");
    assert_eq!(
        fs::read_to_string(dir.join(&stream.transcript)).unwrap(),
        expected
    );
}

#[test]
fn pinned_step_prompts_equal_stored_outbound_frame_text() {
    use goat2_parity::scenario::Step;
    for entry in fs::read_dir(root()).unwrap() {
        let dir = entry.unwrap().path();
        if !dir.is_dir() {
            continue;
        }
        let loaded = LoadedScenario::load(&dir).unwrap();
        let mut texts = Vec::new();
        for stream in loaded.scenario.streams.values() {
            for record in
                transcript::parse(&fs::read(dir.join(&stream.transcript)).unwrap()).unwrap()
            {
                if let Record::ExpectOutbound { frame, .. } = record
                    && matches!(frame["method"].as_str(), Some("turn/start" | "turn/steer"))
                    && let Some(inputs) = frame["params"]["input"].as_array()
                {
                    for input in inputs {
                        if let Some(text) = input["text"].as_str() {
                            texts.push(text.to_owned());
                        }
                    }
                }
            }
        }
        for step in &loaded.scenario.steps {
            if let Step::Send { text, input, .. } = step {
                if texts.contains(text) {
                    continue;
                }
                // These inputs are edited, cancelled, or refused before a provider frame exists.
                let absent = match loaded.scenario.name.as_str() {
                    "queue_edit_then_start" => input == "i2" && text == "temporary queued text" && loaded.scenario.steps.iter().any(|s| matches!(s, Step::QueueEdit { input: edited, text, .. } if edited == input && texts.contains(text))),
                    "queue_cancel_while_active" => input == "i2" && loaded.scenario.steps.iter().any(|s| matches!(s, Step::QueueCancel { input: cancelled, .. } if cancelled == input)),
                    "steer_refused_at_admission" => text == "steer after completion",
                    _ => false,
                };
                assert!(
                    absent,
                    "{}: no exact outbound text for {input}: {text}",
                    loaded.scenario.name
                );
            }
        }
    }
}
