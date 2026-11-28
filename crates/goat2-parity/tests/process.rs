use goat2_parity::{
    scenario::LoadedScenario,
    target::{ProcessTarget, Target},
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "parity-process-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn runner(&self, body: &str) -> ProcessTarget {
        let p = self.0.join("runner.sh");
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        ProcessTarget {
            name: "v1".into(),
            program: p,
            args: vec![],
        }
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
fn scenario() -> LoadedScenario {
    LoadedScenario::load(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios/simple_turn"))
        .unwrap()
}
#[test]
fn process_boundary_success_and_errors_capture_stderr() {
    let t = Temp::new();
    let valid = r#"while [ "$1" != "--out" ]; do shift; done
printf '%s' '{"v":1,"target":"v1","scenario":"simple_turn","outcome":{"outcome":"ok"},"events":[],"streams":{},"incomplete":false}' > "$2"
echo success-note >&2"#;
    let run = t.runner(valid).run(&scenario()).unwrap();
    assert_eq!(run.trace.v, 1);
    assert!(run.stderr.contains("success-note"));
    for (script, expected) in [
        ("echo failure-note >&2; exit 3", "runner exited"),
        ("echo failure-note >&2; exit 0", "missing output"),
        (
            "while [ \"$1\" != \"--out\" ]; do shift; done; echo bad > \"$2\"; echo failure-note >&2",
            "invalid output",
        ),
        (
            "while [ \"$1\" != \"--out\" ]; do shift; done; echo '{\"v\":2}' > \"$2\"; echo failure-note >&2",
            "invalid output",
        ),
    ] {
        let error = t.runner(script).run(&scenario()).unwrap_err();
        assert!(error.message.contains(expected), "{error}");
        assert!(error.stderr.contains("failure-note"));
    }
}
#[test]
fn runner_reporting_another_target_is_rejected() {
    let t = Temp::new();
    let other = r#"while [ "$1" != "--out" ]; do shift; done
printf '%s' '{"v":1,"target":"goat2","scenario":"simple_turn","outcome":{"outcome":"ok"},"events":[],"streams":{},"incomplete":false}' > "$2""#;
    let error = t.runner(other).run(&scenario()).unwrap_err();
    assert!(error.message.contains("invoked as"), "{error}");
}
#[test]
fn cli_validate_and_missing_runner_and_diff() {
    let bin = env!("CARGO_BIN_EXE_goat2-parity");
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let validate = std::process::Command::new(bin)
        .args(["validate", "--scenarios"])
        .arg(root.join("scenarios"))
        .output()
        .unwrap();
    assert!(
        validate.status.success(),
        "{}",
        String::from_utf8_lossy(&validate.stderr)
    );
    let run = std::process::Command::new(bin)
        .args(["run", "--target", "v1", "--v1-root", "/tmp", "--runner"])
        .arg(root.join("v1-runner/does-not-exist.sh"))
        .output()
        .unwrap();
    assert!(!run.status.success());
    let stderr = String::from_utf8_lossy(&run.stderr);
    assert!(stderr.contains("v1 runner not installed"), "{stderr}");
    let t = Temp::new();
    let observed = t.0.join("observed.json");
    fs::write(&observed, r#"{"v":1,"target":"v1","scenario":"simple_turn","outcome":{"outcome":"error","reason":"mismatch"},"events":[],"streams":{},"incomplete":false}"#).unwrap();
    let diff = std::process::Command::new(bin)
        .arg("diff")
        .arg("--scenario")
        .arg(root.join("scenarios/simple_turn"))
        .arg("--observed")
        .arg(observed)
        .output()
        .unwrap();
    assert_eq!(diff.status.code(), Some(1));
}
