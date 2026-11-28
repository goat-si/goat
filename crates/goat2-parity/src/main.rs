use goat2_parity::{
    compare::compare,
    refs::{self, Roots},
    scenario::{LoadedScenario, SupportStatus},
    target::{ProcessTarget, Target},
    trace::ObservedTrace,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::ExitCode,
};
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RequiredEntry {
    escalated: Option<Escalation>,
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Escalation {
    decision: String,
    asked_at: String,
    answer: Option<String>,
}
impl RequiredEntry {
    fn answered(&self) -> bool {
        self.escalated.as_ref().is_some_and(|e| {
            !e.decision.trim().is_empty()
                && !e.asked_at.trim().is_empty()
                && e.answer.as_ref().is_some_and(|a| !a.trim().is_empty())
        })
    }
}
fn required(root: &Path) -> Result<BTreeMap<String, RequiredEntry>, String> {
    let path = root.join("REQUIRED.json");
    let data = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let entries: BTreeMap<String, RequiredEntry> =
        serde_json::from_slice(&data).map_err(|e| format!("{}: {e}", path.display()))?;
    if entries.is_empty() {
        return Err("REQUIRED.json contains no scenarios".into());
    }
    Ok(entries)
}
fn missing_required(
    root: &Path,
    entries: &BTreeMap<String, RequiredEntry>,
    passed: &BTreeSet<String>,
) -> Vec<String> {
    entries
        .iter()
        .filter_map(|(name, entry)| {
            if (!root.join(name).is_dir() || !passed.contains(name)) && !entry.answered() {
                Some(format!(
                    "REQUIRED {name}: {}",
                    if root.join(name).is_dir() {
                        "not PASS"
                    } else {
                        "missing"
                    }
                ))
            } else {
                None
            }
        })
        .collect()
}
fn value(args: &[String], key: &str) -> Result<String, String> {
    let i = args
        .iter()
        .position(|a| a == key)
        .ok_or_else(|| format!("missing {key}"))?;
    args.get(i + 1)
        .filter(|v| !v.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("missing value for {key}"))
}
fn scenarios_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scenarios")
}
fn dirs(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for e in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let p = e.map_err(|e| e.to_string())?.path();
        if p.is_dir() {
            paths.push(p);
        }
    }
    paths.sort();
    if paths.is_empty() {
        return Err("no scenarios".into());
    }
    Ok(paths)
}
fn execute() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args
        .first()
        .ok_or("expected validate, check-refs, diff, or run")?;
    match command.as_str() {
        "validate" => {
            let root = if args.iter().any(|a| a == "--scenarios") {
                PathBuf::from(value(&args, "--scenarios")?)
            } else {
                scenarios_root()
            };
            let mut errors = Vec::new();
            let v1_root = if args.iter().any(|a| a == "--v1-root") {
                Some(PathBuf::from(value(&args, "--v1-root")?))
            } else {
                None
            };
            if v1_root.is_none() {
                println!("v1Refs unverified");
            }
            for path in dirs(&root)? {
                match LoadedScenario::load(&path) {
                    Ok(s) => {
                        if let Some(v1) = &v1_root {
                            for reference in &s.scenario.v1_refs {
                                if let Err(e) = refs::validate_v1_ref(reference, v1) {
                                    errors.push(format!(
                                        "{}: v1Ref {reference}: {e}",
                                        s.scenario.name
                                    ));
                                }
                            }
                        }
                        println!("OK {}", s.scenario.name)
                    }
                    Err(e) => errors.push(format!("{}: {e}", path.display())),
                }
            }
            if !errors.is_empty() {
                return Err(errors.join("\n"));
            }
        }
        "check-refs" => {
            let roots = Roots {
                v1: value(&args, "--v1-root")?.into(),
                sdk_py: value(&args, "--sdk-py-root")?.into(),
                sdk_ts: value(&args, "--sdk-ts-root")?.into(),
                design: value(&args, "--design-root")?.into(),
                goat2: value(&args, "--goat2-root")?.into(),
            };
            let mut paths = Vec::new();
            let mut i = 1;
            while i < args.len() {
                if args[i].starts_with("--") {
                    if args[i] == "--skip-missing-roots" {
                        i += 1;
                        continue;
                    }
                    if ![
                        "--v1-root",
                        "--sdk-py-root",
                        "--sdk-ts-root",
                        "--design-root",
                        "--goat2-root",
                    ]
                    .contains(&args[i].as_str())
                    {
                        return Err(format!("unknown option {}", args[i]));
                    }
                    i += 2;
                } else {
                    paths.push(PathBuf::from(&args[i]));
                    i += 1;
                }
            }
            match refs::check_with_options(
                &roots,
                &paths,
                args.iter().any(|a| a == "--skip-missing-roots"),
            ) {
                Ok(s) => print!("{s}"),
                Err(s) => return Err(s),
            }
        }
        "diff" => {
            let scenario = LoadedScenario::load(Path::new(&value(&args, "--scenario")?))?;
            let bytes = std::fs::read(value(&args, "--observed")?).map_err(|e| e.to_string())?;
            let trace: ObservedTrace = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let report = compare(&scenario, &trace);
            println!("{report:#?}");
            if !report.passed() {
                return Err("comparison did not pass".into());
            }
        }
        "run" => {
            if value(&args, "--target")? != "v1" {
                return Err("unknown target".into());
            }
            let root = value(&args, "--v1-root")?;
            let runner = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("v1-runner/run-v1.sh");
            let filtered = args.iter().any(|a| a == "--only" || a == "--scenarios");
            if filtered {
                println!("DIAGNOSTIC (filtered)");
            }
            let scenarios = if args.iter().any(|a| a == "--scenarios") {
                PathBuf::from(value(&args, "--scenarios")?)
            } else {
                scenarios_root()
            };
            let required = if filtered {
                BTreeMap::new()
            } else {
                required(&scenarios)?
            };
            let only = if args.iter().any(|a| a == "--only") {
                Some(value(&args, "--only")?)
            } else {
                None
            };
            let mut target = ProcessTarget {
                name: "v1".into(),
                program: runner.clone(),
                args: vec!["--v1-root".into(), root],
            };
            let mut failed = false;
            let mut selected = 0;
            let mut passed = BTreeSet::new();
            for path in dirs(&scenarios)? {
                let scenario = LoadedScenario::load(&path)?;
                if path.file_name().and_then(|n| n.to_str()) != Some(&scenario.scenario.name) {
                    return Err(format!(
                        "{}: scenario name does not match directory",
                        path.display()
                    ));
                }
                if only.as_ref().is_some_and(|n| n != &scenario.scenario.name) {
                    continue;
                }
                selected += 1;
                let name = &scenario.scenario.name;
                let support = scenario.scenario.targets.get("v1");
                if support.is_none_or(|s| s.status != SupportStatus::Supported) {
                    println!(
                        "{name}: PENDING/UNSUPPORTED {:?}",
                        support.and_then(|s| s.reason.as_deref())
                    );
                    if filtered {
                        failed = true;
                    }
                    continue;
                }
                if !runner.is_file() {
                    eprintln!("{name}: v1 runner not installed");
                    failed = true;
                    continue;
                }
                match target.run(&scenario) {
                    Ok(run) => {
                        if !run.stderr.is_empty() {
                            eprint!("{}", run.stderr);
                        }
                        let report = compare(&scenario, &run.trace);
                        println!("{}: {report:?}", scenario.scenario.name);
                        if report.passed() {
                            passed.insert(name.clone());
                        }
                        failed |= !report.passed();
                    }
                    Err(e) => {
                        eprintln!("{}: {e}", scenario.scenario.name);
                        failed = true;
                    }
                }
            }
            if selected == 0 {
                return Err("no matching scenario".into());
            }
            for message in missing_required(&scenarios, &required, &passed) {
                eprintln!("{message}");
                failed = true;
            }
            if failed {
                return Err("one or more scenarios did not pass".into());
            }
        }
        _ => return Err(format!("unknown command {command}")),
    }
    Ok(())
}

fn main() -> ExitCode {
    match execute() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn required_missing_and_pending_are_failures() {
        let root = std::env::temp_dir().join(format!("parity-required-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(root.join("pending")).unwrap();
        let entries: BTreeMap<String, RequiredEntry> =
            serde_json::from_str(r#"{"missing":{},"pending":{}}"#).unwrap();
        let problems = missing_required(&root, &entries, &BTreeSet::new());
        assert!(problems.iter().any(|s| s == "REQUIRED missing: missing"));
        assert!(problems.iter().any(|s| s == "REQUIRED pending: not PASS"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
