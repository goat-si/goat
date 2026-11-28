use goat2_parity::{scenario::Scenario, trace::ObservedTrace};
use schemars::schema_for;
use std::{fs, path::PathBuf};

#[test]
fn schemas_match() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for (name, schema) in [
        (
            "scenario",
            serde_json::to_value(schema_for!(Scenario)).unwrap(),
        ),
        (
            "observed",
            serde_json::to_value(schema_for!(ObservedTrace)).unwrap(),
        ),
    ] {
        let path = root.join("schema").join(format!("{name}.schema.json"));
        let expected = format!("{}\n", serde_json::to_string_pretty(&schema).unwrap());
        if std::env::var_os("GOAT2_PARITY_BLESS").as_deref() == Some(std::ffi::OsStr::new("1")) {
            fs::write(&path, &expected).unwrap();
        }
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            expected,
            "schema drift: {name}"
        );
    }
}

#[test]
fn readme_examples_deserialize() {
    let readme = include_str!("../README.md");
    let examples: Vec<_> = readme
        .split("```json\n")
        .skip(1)
        .map(|s| s.split("\n```").next().unwrap())
        .collect();
    assert_eq!(examples.len(), 2);
    let scenario: Scenario = serde_json::from_str(examples[0]).unwrap();
    let observed: ObservedTrace = serde_json::from_str(examples[1]).unwrap();
    assert_eq!(scenario.v, 1);
    assert_eq!(observed.v, 1);
    for (name, example) in [("scenario", examples[0]), ("observed", examples[1])] {
        let schema: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("schema")
                    .join(format!("{name}.schema.json")),
            )
            .unwrap(),
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_str(example).unwrap();
        for key in schema["required"].as_array().unwrap() {
            assert!(
                value.get(key.as_str().unwrap()).is_some(),
                "{name} missing {key}"
            );
        }
    }
}

#[test]
fn versions_and_await_wire() {
    use goat2_parity::scenario::Step;
    let step: Step = serde_json::from_str(r#"{"do":"await","id":"a","thread":"main","until":"run_status","run":"r1","status":"running"}"#).unwrap();
    assert_eq!(serde_json::to_value(step).unwrap()["until"], "run_status");
    let step: Step =
        serde_json::from_str(r#"{"do":"await_call","id":"a","call":"c","timeoutMs":100}"#).unwrap();
    assert_eq!(serde_json::to_value(step).unwrap()["timeoutMs"], 100);
    let readme = include_str!("../README.md");
    let examples: Vec<_> = readme
        .split("```json\n")
        .skip(1)
        .map(|s| s.split("\n```").next().unwrap())
        .collect();
    for (i, text) in examples.iter().enumerate() {
        let value = text.replace("\"v\": 1", "\"v\": 2");
        if i == 0 {
            assert!(serde_json::from_str::<Scenario>(&value).is_err());
        } else {
            assert!(serde_json::from_str::<ObservedTrace>(&value).is_err());
        }
    }
}

#[test]
fn all_await_conditions_round_trip_and_reject_unknown() {
    use goat2_parity::scenario::Step;
    for json in [
        r#"{"do":"await","id":"a","thread":"t1","until":"steerable","run":"r1"}"#,
        r#"{"do":"await","id":"a","thread":"t1","until":"idle"}"#,
        r#"{"do":"await","id":"a","thread":"t1","until":"run_status","run":"r1","status":"running"}"#,
    ] {
        let expected: serde_json::Value = serde_json::from_str(json).unwrap();
        let parsed: Step = serde_json::from_str(json).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), expected);
    }
    assert!(
        serde_json::from_str::<Step>(
            r#"{"do":"await","id":"a","thread":"t1","until":"idle","bad":1}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<Step>(
            r#"{"do":"await_call","id":"a","call":"c","timeoutMs":1,"bad":1}"#
        )
        .is_err()
    );
}
