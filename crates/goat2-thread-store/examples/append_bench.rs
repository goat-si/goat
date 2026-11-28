//! In-run append latency: every append is synced before it is published (review round 10).
//!
//! cargo run --release -p goat2-thread-store --example append_bench -- --items 300 --threads 20
//!
//! `--threads` store threads, each with one open run, append `--items` single-item lines each
//! (command summary or ~800 B answer, alternating) from their own OS thread at the same time, as
//! the host does from spawn_blocking. Prints per-append latency (median, p95, max) in ms and the
//! total appends per second as JSON. Compare --threads 1 with --threads 20 to see whether syncs of
//! different threads overlap or queue behind one another.

use std::sync::{Arc, Barrier};
use std::time::Instant;

use goat2_thread_store::contract::*;
use goat2_thread_store::{Store, StoreOptions};
use serde_json::json;

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

fn created() -> ThreadCreated {
    ThreadCreated {
        kind: ThreadKind::User,
        title: "append bench".into(),
        project_id: None,
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
            cwd: "/w".into(),
        },
        follow_up_mode: FollowUpMode::Steer,
    }
}

fn start_run(store: &Store, t: &ThreadId) {
    store
        .append(
            t,
            vec![
                LogEvent::InputAccepted(InputAccepted {
                    input_id: InputId::new("i1"),
                    from: InputSource::User,
                    mode: InputMode::Followup,
                    text: "go".into(),
                    attachments: Vec::new(),
                    client_request_id: "cr-i1".into(),
                }),
                LogEvent::RunStarted(RunStarted {
                    run_id: RunId::new("r1"),
                    input_ids: vec![InputId::new("i1")],
                    generation: 1,
                    engine_ref: None,
                }),
            ],
        )
        .unwrap();
}

fn main() {
    let mut items = 300usize;
    let mut threads = 1usize;
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut value = || it.next().expect("flag value");
        match flag.as_str() {
            "--items" => items = value().parse().unwrap(),
            "--threads" => threads = value().parse().unwrap(),
            other => panic!("unknown flag {other}"),
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(dir.path(), StoreOptions::default()).unwrap().0);
    let ids: Vec<ThreadId> = (0..threads).map(|i| ThreadId::new(format!("t{i}"))).collect();
    for t in &ids {
        store.create_thread(Some(t.clone()), created()).unwrap();
        start_run(&store, t);
    }
    let barrier = Arc::new(Barrier::new(threads));
    let wall = Instant::now();
    let workers: Vec<_> = ids
        .into_iter()
        .map(|t| {
            let (store, barrier) = (store.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                let mut ms = Vec::with_capacity(items);
                for n in 0..items {
                    let id = format!("it{n}");
                    let body = if n % 2 == 0 {
                        json!({"type": "command_execution", "input": "cargo test -p something", "outputOmitted": true, "exitCode": 0})
                    } else {
                        json!({"type": "assistant_message", "messageId": format!("m{n}"), "text": "x".repeat(800), "streaming": false})
                    };
                    let started = Instant::now();
                    store.append(&t, vec![item("r1", &id, body)]).unwrap();
                    ms.push(started.elapsed().as_secs_f64() * 1000.0);
                }
                ms
            })
        })
        .collect();
    let mut ms: Vec<f64> = workers
        .into_iter()
        .flat_map(|w| w.join().unwrap())
        .collect();
    let wall_s = wall.elapsed().as_secs_f64();
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pick = |q: f64| ms[((ms.len() as f64 - 1.0) * q).round() as usize];
    println!(
        "{}",
        json!({
            "threads": threads, "itemsPerThread": items,
            "medianMs": pick(0.5), "p95Ms": pick(0.95), "maxMs": ms[ms.len() - 1],
            "appendsPerSec": ms.len() as f64 / wall_s
        })
    );
}
