//! In-run append latency: every append is synced before it is published (review round 10).
//!
//! cargo run --release -p goat2-thread-store --example append_bench -- --items 300
//!
//! One thread, one open run, then `--items` single-item appends (command summary or ~800 B
//! answer, alternating). Prints per-append latency (median, p95, max) in ms as JSON.

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

fn main() {
    let mut items = 300usize;
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        match flag.as_str() {
            "--items" => items = it.next().expect("flag value").parse().unwrap(),
            other => panic!("unknown flag {other}"),
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let (store, _) = Store::open(dir.path(), StoreOptions::default()).unwrap();
    let t = ThreadId::new("t");
    store
        .create_thread(
            Some(t.clone()),
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
            },
        )
        .unwrap();
    store
        .append(
            &t,
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
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pick = |q: f64| ms[((ms.len() as f64 - 1.0) * q).round() as usize];
    println!(
        "{}",
        json!({"items": items, "medianMs": pick(0.5), "p95Ms": pick(0.95), "maxMs": ms[ms.len() - 1]})
    );
}
