//! Startup benchmark: N threads, then open the store three ways and print JSON.
//!
//! cargo run --release -p goat2-thread-store --example startup_bench -- --threads 1000
//!
//! Fixture: every thread has `--runs` finished runs (8 lines each: input, start, accept, delivery,
//! answer ~800 B, command summary, finish, checkpoint). Every `--active-every`th thread is left with
//! an open run (half of them accepted by the engine), then the store is dropped without flushing.
//! Fixtures are written with fsync off; every measured open uses the default options (fsync on).
//!
//! Measured: (1) unclean start that settles the open runs, (2) warm clean start, repeated,
//! (3) start after deleting cards.sqlite (rebuild from folders), repeated.

use std::path::{Path, PathBuf};
use std::time::Instant;

use goat2_thread_store::contract::*;
use goat2_thread_store::{CardFilter, StartupReport, Store, StoreOptions, testing};
use serde_json::json;

struct Args {
    threads: usize,
    runs: usize,
    active_every: usize,
    repeat: usize,
    dir: Option<PathBuf>,
}

fn args() -> Args {
    let mut a = Args {
        threads: 1000,
        runs: 5,
        active_every: 20,
        repeat: 5,
        dir: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().expect("flag value");
        match flag.as_str() {
            "--threads" => a.threads = value().parse().unwrap(),
            "--runs" => a.runs = value().parse().unwrap(),
            "--active-every" => a.active_every = value().parse().unwrap(),
            "--repeat" => a.repeat = value().parse().unwrap(),
            "--dir" => a.dir = Some(PathBuf::from(value())),
            other => panic!("unknown flag {other}"),
        }
    }
    a
}

fn created(i: usize) -> ThreadCreated {
    ThreadCreated {
        kind: if i == 0 {
            ThreadKind::Bot
        } else {
            ThreadKind::User
        },
        title: format!("Thread {i}: investigate something reasonably long so titles look real"),
        project_id: Some(ProjectId::new(format!("proj-{}", i % 7))),
        bot_id: None,
        parent: None,
        engine: EngineConfig {
            provider_instance_id: ProviderInstanceId::new("codex"),
            model_selection: ModelSelection {
                instance_id: ProviderInstanceId::new("codex"),
                model: "gpt-6.1-terra".into(),
                options: None,
            },
            runtime_mode: RuntimeMode::FullAccess,
            cwd: format!("/Users/me/work/repo-{}", i % 13),
        },
        follow_up_mode: FollowUpMode::Steer,
    }
}

fn item(run: &str, id: &str, body: serde_json::Value) -> LogEvent {
    let mut item = json!({
        "id": id, "threadId": "t", "runId": run, "providerThreadId": "codex-1", "providerTurnId": "turn-1",
        "nativeItemRef": null, "parentItemId": null, "ordinal": 1, "status": "completed", "title": null,
        "startedAt": "2026-11-28T10:00:00Z", "completedAt": "2026-11-28T10:00:05Z", "updatedAt": "2026-11-28T10:00:05Z"
    });
    for (k, v) in body.as_object().unwrap() {
        item[k] = v.clone();
    }
    LogEvent::ItemCompleted(
        serde_json::from_value(json!({"runId": run, "item": item, "engineLocator": {"turnId": "turn-1", "itemId": id}}))
            .unwrap(),
    )
}

fn input(id: &str) -> LogEvent {
    LogEvent::InputAccepted(InputAccepted {
        input_id: InputId::new(id),
        from: InputSource::User,
        mode: InputMode::Followup,
        text: "Please look at the failing test and fix it; explain what changed.".into(),
        attachments: Vec::new(),
        client_request_id: format!("cr-{id}"),
    })
}

fn run_events(r: usize, done: bool, accepted: bool) -> Vec<LogEvent> {
    let run = format!("r{r}");
    let inp = format!("i{r}");
    let mut events = vec![
        input(&inp),
        LogEvent::RunStarted(RunStarted {
            run_id: RunId::new(&run),
            input_ids: vec![InputId::new(&inp)],
            generation: 1,
            engine_ref: Some(EngineRef {
                driver: EngineDriver::Codex,
                id: "codex-1".into(),
            }),
        }),
    ];
    if accepted {
        events.push(LogEvent::RunAccepted(RunAccepted {
            run_id: RunId::new(&run),
            engine_turn_ref: EngineTurnRef {
                driver: EngineDriver::Codex,
                id: format!("turn-{r}"),
            },
        }));
    }
    if done {
        events.push(LogEvent::InputDelivered(InputDelivered {
            input_id: InputId::new(&inp),
            run_id: RunId::new(&run),
            delivered_as: DeliveredAs::Turn,
            outcome: DeliveryOutcome::Accepted,
        }));
        events.push(item(&run, &format!("{run}-cmd"), json!({"type": "command_execution", "input": "cargo test -p something", "outputOmitted": true, "exitCode": 0})));
        events.push(item(&run, &format!("{run}-ans"), json!({"type": "assistant_message", "messageId": format!("m{r}"), "text": "x".repeat(800), "streaming": false})));
        events.push(LogEvent::RunFinished(RunFinished {
            run_id: RunId::new(&run),
            outcome: RunOutcome::Completed,
            reason: None,
            token_usage: None,
        }));
    }
    events
}

fn generate(dir: &Path, a: &Args) -> (usize, u64) {
    let (store, _) = Store::open(
        dir,
        StoreOptions {
            fsync: false,
            ..Default::default()
        },
    )
    .unwrap();
    let mut active = 0;
    for i in 0..a.threads {
        let id = ThreadId::new(format!("thread-{i:05}"));
        store.create_thread(Some(id.clone()), created(i)).unwrap();
        for r in 0..a.runs {
            store.append(&id, run_events(r, true, true)).unwrap();
        }
        if i % a.active_every == 0 {
            store
                .append(&id, run_events(a.runs, false, active % 2 == 0))
                .unwrap();
            active += 1;
        }
    }
    store.flush().unwrap();
    testing::crash(store);
    let mut bytes = 0;
    for entry in std::fs::read_dir(dir.join("threads")).unwrap() {
        bytes += std::fs::metadata(entry.unwrap().path().join("goat.jsonl"))
            .unwrap()
            .len();
    }
    (active, bytes)
}

fn measure(dir: &Path) -> (StartupReport, f64, usize) {
    let t = Instant::now();
    let (store, report) = Store::open(dir, StoreOptions::default()).unwrap();
    let cards = store.find(&CardFilter::default()).len();
    let first_list_ms = t.elapsed().as_secs_f64() * 1000.0;
    store.close().unwrap();
    (report, first_list_ms, cards)
}

fn remove_index(dir: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.join(format!("cards.sqlite{suffix}")));
    }
}

fn cpu() -> String {
    let out = if cfg!(target_os = "macos") {
        std::process::Command::new("sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()
    } else {
        std::process::Command::new("sh")
            .args(["-c", "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"])
            .output()
            .ok()
    };
    out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_default()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn main() {
    let a = args();
    let tmp;
    let dir = match &a.dir {
        Some(d) => d.clone(),
        None => {
            tmp = tempfile::tempdir().unwrap();
            tmp.path().to_path_buf()
        }
    };
    let t = Instant::now();
    let (active, log_bytes) = generate(&dir, &a);
    let generate_ms = t.elapsed().as_secs_f64() * 1000.0;

    let (unclean, unclean_list_ms, _) = measure(&dir);
    let mut warm = Vec::new();
    for _ in 0..a.repeat {
        warm.push(measure(&dir));
    }
    let mut rebuild = Vec::new();
    for _ in 0..a.repeat {
        remove_index(&dir);
        rebuild.push(measure(&dir));
    }
    let summary = |runs: &[(StartupReport, f64, usize)]| {
        json!({
            "openTotalMsMedian": median(runs.iter().map(|r| r.0.timings.total_ms).collect()),
            "openTotalMsAll": runs.iter().map(|r| (r.0.timings.total_ms * 100.0).round() / 100.0).collect::<Vec<_>>(),
            "firstCardListMsMedian": median(runs.iter().map(|r| r.1).collect()),
            "logsOpened": runs[0].0.logs_opened,
            "cards": runs[0].2,
            "timingsFirst": runs[0].0.timings,
            "index": runs[0].0.index,
        })
    };
    let out = json!({
        "machine": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "cpu": cpu(),
            "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "dataDir": dir.display().to_string(),
        },
        "fixture": {
            "threads": a.threads,
            "linesPerThread": 1 + a.runs * 8,
            "openRunsAtCrash": active,
            "logBytesTotal": log_bytes,
            "generateMs": generate_ms,
        },
        "uncleanStart": {
            "openTotalMs": unclean.timings.total_ms,
            "firstCardListMs": unclean_list_ms,
            "logsOpened": unclean.logs_opened,
            "settled": unclean.settled.len(),
            "interrupted": unclean.settled.iter().filter(|s| s.outcome == RunOutcome::Interrupted).count(),
            "unknown": unclean.settled.iter().filter(|s| s.outcome == RunOutcome::Unknown).count(),
            "timings": unclean.timings,
        },
        "warmStart": summary(&warm),
        "rebuildAfterIndexDelete": summary(&rebuild),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
