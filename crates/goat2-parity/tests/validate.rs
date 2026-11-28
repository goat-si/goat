use goat2_parity::scenario::LoadedScenario;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static ID: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios/simple_turn");
        let out = std::env::temp_dir().join(format!(
            "goat2-validate-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(out.join("transcripts")).unwrap();
        let json = fs::read(root.join("scenario.json")).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&json).unwrap();
        for stream in v["streams"].as_object().unwrap().values() {
            let path = stream["transcript"].as_str().unwrap();
            fs::copy(root.join(path), out.join(path)).unwrap();
        }
        fs::write(out.join("scenario.json"), json).unwrap();
        Self(out)
    }
    fn edit(&self, f: impl FnOnce(&mut serde_json::Value)) {
        let p = self.0.join("scenario.json");
        let mut v = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        f(&mut v);
        fs::write(p, serde_json::to_vec(&v).unwrap()).unwrap();
    }
    fn fails(&self) {
        assert!(LoadedScenario::load(&self.0).is_err());
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn rejects_bad_declarations() {
    let f = Fixture::new();
    f.edit(|v| {
        let step = v["steps"][0].clone();
        v["steps"].as_array_mut().unwrap().push(step)
    });
    f.fails();
    let f = Fixture::new();
    f.edit(|v| v["steps"][0]["thread"] = "unknown".into());
    f.fails();
    let f = Fixture::new();
    f.edit(|v| {
        v["targets"]["v1"]["status"] = "unsupported".into();
        v["targets"]["v1"].as_object_mut().unwrap().remove("reason");
    });
    f.fails();
    let f = Fixture::new();
    f.edit(|v| {
        v["targets"]["v1"]["expect"] = v["expect"].clone();
    });
    f.fails();
    let f = Fixture::new();
    f.edit(|v| {
        v["steps"].as_array_mut().unwrap().push(
            serde_json::json!({"do":"await_call","id":"join","call":"unknown","timeoutMs":1}),
        );
    });
    f.fails();
    let f = Fixture::new();
    f.edit(|v| {
        let events = v["expect"]["threads"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap()
            .as_array_mut()
            .unwrap();
        events.push(events[0].clone());
    });
    f.fails();
    let f = Fixture::new();
    f.edit(|v| {
        let id = v["expect"]["threads"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()[0]["id"]
            .clone();
        v["expect"]["happensBefore"] = serde_json::json!([[id, id]]);
    });
    f.fails();
    let f = Fixture::new();
    f.edit(|v| {
        let stream = v["streams"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        stream["provenance"]["sha256"] = "bad".into();
    });
    f.fails();
}

macro_rules! invalid_case {
    ($name:ident, $edit:expr) => {
        #[test]
        fn $name() {
            let f = Fixture::new();
            f.edit($edit);
            f.fails();
        }
    };
}
invalid_case!(
    unknown_input_alias_in_expect,
    |v: &mut serde_json::Value| {
        let events = v["expect"]["threads"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        events[0]["input"] = "unknown".into();
    }
);
invalid_case!(happens_before_unknown_id, |v: &mut serde_json::Value| {
    v["expect"]["happensBefore"] = serde_json::json!([["unknown", "unknown2"]]);
});
invalid_case!(transcript_path_escape, |v: &mut serde_json::Value| {
    let stream = v["streams"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    stream["transcript"] = "../outside.ndjson".into();
});
invalid_case!(
    verbatim_source_hash_mismatch,
    |v: &mut serde_json::Value| {
        let stream = v["streams"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap();
        stream["provenance"]["sourceSha256"] = "0".repeat(64).into();
    }
);
invalid_case!(pending_without_reason, |v: &mut serde_json::Value| {
    v["targets"]["v1"]["status"] = "pending".into();
    v["targets"]["v1"].as_object_mut().unwrap().remove("reason");
});
invalid_case!(await_call_for_waited_call, |v: &mut serde_json::Value| {
    let caller = v["threads"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    v["steps"].as_array_mut().unwrap().extend([
        serde_json::json!({"do":"mcp","id":"call","caller":caller,"path":"x","args":{},"call":"c","wait":true}),
        serde_json::json!({"do":"await_call","id":"join","call":"c","timeoutMs":1})
    ]);
});
invalid_case!(scenario_wrong_version, |v: &mut serde_json::Value| {
    v["v"] = 2.into();
});

invalid_case!(unknown_thread_alias, |v: &mut serde_json::Value| {
    v["steps"][0]["thread"] = "unknown".into();
});
invalid_case!(duplicate_step_id, |v: &mut serde_json::Value| {
    let x = v["steps"][0].clone();
    v["steps"].as_array_mut().unwrap().push(x);
});
invalid_case!(duplicate_expected_event_id, |v: &mut serde_json::Value| {
    let e = v["expect"]["threads"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()
        .as_array_mut()
        .unwrap();
    e.push(e[0].clone());
});
invalid_case!(happens_before_cycle, |v: &mut serde_json::Value| {
    let id = v["expect"]["threads"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()[0]["id"]
        .clone();
    v["expect"]["happensBefore"] = serde_json::json!([[id, id]]);
});
invalid_case!(tampered_transcript_sha256, |v: &mut serde_json::Value| {
    v["streams"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()["provenance"]["sha256"] = "0".repeat(64).into();
});
invalid_case!(
    transform_none_with_source_mismatch,
    |v: &mut serde_json::Value| {
        let p = &mut v["streams"]
            .as_object_mut()
            .unwrap()
            .values_mut()
            .next()
            .unwrap()["provenance"];
        p["sourceSha256"] = "0".repeat(64).into();
    }
);
invalid_case!(
    target_expect_without_decision,
    |v: &mut serde_json::Value| {
        v["targets"]["v1"]["expect"] = v["expect"].clone();
    }
);
invalid_case!(await_call_unknown_call, |v: &mut serde_json::Value| {
    v["steps"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"do":"await_call","id":"join","call":"unknown","timeoutMs":1}));
});

#[test]
fn empty_v1_refs_is_rejected() {
    let src = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios/simple_turn");
    let dir = std::env::temp_dir().join(format!("parity-empty-refs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("transcripts")).unwrap();
    for e in std::fs::read_dir(src.join("transcripts")).unwrap() {
        let p = e.unwrap().path();
        std::fs::copy(&p, dir.join("transcripts").join(p.file_name().unwrap())).unwrap();
    }
    let mut v: serde_json::Value =
        serde_json::from_slice(&std::fs::read(src.join("scenario.json")).unwrap()).unwrap();
    v["v1Refs"] = serde_json::json!([]);
    std::fs::write(dir.join("scenario.json"), serde_json::to_vec(&v).unwrap()).unwrap();
    let err = goat2_parity::scenario::LoadedScenario::load(&dir).unwrap_err();
    std::fs::remove_dir_all(&dir).unwrap();
    assert!(err.contains("v1Refs"), "{err}");
}
