use goat2_parity::{
    compare::compare,
    refs::{self, Roots},
    scenario::LoadedScenario,
    target::{ProcessTarget, Target},
    trace::ObservedTrace,
};
use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};
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
            for path in dirs(&root)? {
                match LoadedScenario::load(&path) {
                    Ok(s) => println!("OK {}", s.scenario.name),
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
            match refs::check(&roots, &paths) {
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
            if !runner.is_file() {
                return Err("v1 runner not installed".into());
            }
            let only = if args.iter().any(|a| a == "--only") {
                Some(value(&args, "--only")?)
            } else {
                None
            };
            let mut target = ProcessTarget {
                name: "v1".into(),
                program: runner,
                args: vec!["--v1-root".into(), root],
            };
            let mut failed = false;
            let mut selected = 0;
            for path in dirs(&scenarios_root())? {
                let scenario = LoadedScenario::load(&path)?;
                if only.as_ref().is_some_and(|n| n != &scenario.scenario.name) {
                    continue;
                }
                selected += 1;
                match target.run(&scenario) {
                    Ok(run) => {
                        if !run.stderr.is_empty() {
                            eprint!("{}", run.stderr);
                        }
                        let report = compare(&scenario, &run.trace);
                        println!("{}: {report:?}", scenario.scenario.name);
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
