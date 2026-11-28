//! Drift check for packages/contracts-rs. `GOAT2_CONTRACTS_BLESS=1` rewrites the owned files.

use std::path::{Path, PathBuf};

use goat2_contracts::codegen::{self, FIXTURE_TS, Files, OWNED_DIRS, ROOTS, SCHEMA_DIR, TS_DIR};

fn repo_root() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    assert!(
        root.join("Cargo.toml").is_file() && root.join("pnpm-workspace.yaml").is_file(),
        "workspace root not found from {}",
        env!("CARGO_MANIFEST_DIR")
    );
    root
}

fn committed(root: &Path) -> Files {
    let mut files = Files::new();
    for dir in OWNED_DIRS {
        codegen::read_tree(root, &root.join(dir), &mut files).expect("read owned dir");
    }
    let fixture = root.join(FIXTURE_TS);
    if fixture.is_file() {
        files.insert(
            FIXTURE_TS.into(),
            std::fs::read_to_string(fixture).expect("read fixture module"),
        );
    }
    files
}

#[test]
fn generated_artifacts_are_current() {
    let root = repo_root();
    let expected = codegen::render_all().expect("render");
    let actual = committed(&root);

    if std::env::var("GOAT2_CONTRACTS_BLESS").as_deref() == Ok("1") {
        for stale in actual.keys().filter(|p| !expected.contains_key(*p)) {
            std::fs::remove_file(root.join(stale)).expect("remove stale file");
        }
        for (path, text) in &expected {
            let target = root.join(path);
            std::fs::create_dir_all(target.parent().expect("parent")).expect("mkdir");
            if actual.get(path) != Some(text) {
                std::fs::write(&target, text).expect("write");
            }
        }
        return;
    }

    let missing: Vec<_> = expected
        .keys()
        .filter(|p| !actual.contains_key(*p))
        .collect();
    let stale: Vec<_> = actual
        .keys()
        .filter(|p| !expected.contains_key(*p))
        .collect();
    let changed: Vec<_> = expected
        .iter()
        .filter(|(p, text)| actual.get(*p).is_some_and(|a| a != *text))
        .map(|(p, _)| p)
        .collect();
    assert!(
        missing.is_empty() && stale.is_empty() && changed.is_empty(),
        "packages/contracts-rs is out of date (run GOAT2_CONTRACTS_BLESS=1 cargo test -p goat2-contracts --test generated)\nmissing: {missing:?}\nstale: {stale:?}\nchanged: {changed:?}"
    );
}

#[test]
fn generation_is_deterministic() {
    assert_eq!(
        codegen::render_all().unwrap(),
        codegen::render_all().unwrap()
    );
}

#[test]
fn every_root_has_typescript_schema_and_index_export() {
    let files = codegen::render_all().unwrap();
    let index = &files[&format!("{TS_DIR}/index.ts")];
    for root in ROOTS {
        assert!(
            files.contains_key(&format!("{TS_DIR}/{root}.ts")),
            "{root}.ts"
        );
        assert!(
            files.contains_key(&format!("{SCHEMA_DIR}/{root}.schema.json")),
            "{root} schema"
        );
        assert!(
            index.contains(&format!("\"./{root}.ts\"")),
            "index exports {root}"
        );
    }
}

#[test]
fn typescript_output_has_the_wire_shape() {
    let files = codegen::render_typescript().unwrap();
    let ts = |name: &str| files[&format!("{TS_DIR}/{name}.ts")].clone();
    let host = ts("HostFrame");
    assert!(!host.contains("Box"), "Box must not leak into TypeScript");
    assert!(host.contains("card: ThreadCard") && host.contains("line: LogLine"));
    assert!(ts("InputDelivered").contains("as: DeliveredAs,"));
    assert!(ts("ThreadCard").contains("archived?: boolean"));
    assert!(ts("InputAccepted").contains("attachments?: Array<ChatAttachment>"));
    assert!(ts("ProviderFailure").contains("resetAt?: string | null"));
    assert!(ts("RequestResolved").contains("answers?: { [key in string]: JsonValue }"));
    assert!(
        ts("LogLine").contains("seq: number"),
        "u64 must be number, not bigint"
    );
    let limits = &files[&format!("{TS_DIR}/limits.ts")];
    assert!(limits.contains("export const MAX_SAFE_WIRE_INTEGER = 9007199254740991;"));
    assert!(limits.contains("\"input.changed\""));
}

#[test]
fn schemas_bound_u64_to_safe_integers() {
    let files = codegen::render_json_schemas();
    let line = &files[&format!("{SCHEMA_DIR}/LogLine.schema.json")];
    assert!(line.contains("\"format\": \"uint64\""));
    assert!(line.contains("\"maximum\": 9007199254740991"));
}
