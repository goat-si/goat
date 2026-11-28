use goat2_engine_codex::{
    contract::ThreadId,
    items::{
        ItemContext, completed_item, item_status, rfc3339_ms, started_item, web_search_patterns,
    },
    protocol::server::ThreadItem,
};
use serde_json::{Value, json};

fn project(value: Value) -> Value {
    let item: ThreadItem = serde_json::from_value(value).unwrap();
    let thread = ThreadId::from("thread");
    let context = ItemContext {
        thread_id: &thread,
        codex_thread_id: "codex-thread",
        turn_id: "turn",
        ordinal: 4,
        started_at_ms: Some(0),
        completed_at_ms: 1000,
    };
    serde_json::to_value(completed_item(&item, &context).unwrap()).unwrap()
}
#[test]
fn assistant_message() {
    let v = project(json!({"type":"agentMessage","id":"a","text":"hello","phase":"final_answer"}));
    assert_eq!(v["type"], "assistant_message");
    assert_eq!(v["phase"], "final_answer");
    assert_eq!(v["messageId"], "a");
    assert_eq!(v["nativeItemRef"]["strength"], "strong");
}
#[test]
fn reasoning() {
    let v = project(json!({"type":"reasoning","id":"r","summary":["one", ""],"content":["two"]}));
    assert_eq!(v["text"], "one\ntwo");
}
#[test]
fn plan() {
    let v = project(json!({"type":"plan","id":"p","text":"do it"}));
    assert_eq!(v["type"], "proposed_plan");
    assert_eq!(v["markdown"], "do it");
}
#[test]
fn command_execution() {
    let v = project(
        json!({"type":"commandExecution","id":"c","command":"cat a","status":"failed","exitCode":1,"commandActions":[{"type":"read","command":"cat a","path":" a "}]}),
    );
    assert_eq!(v["commandActions"][0]["path"], "a");
    assert_eq!(v["status"], "failed");
    assert_eq!(v["exitCode"], 1);
    assert_eq!(v["outputOmitted"], true);
    assert!(v.get("output").is_none());
}
#[test]
fn command_execution_keeps_a_bounded_one_line_summary() {
    // A long script with a secret further down: only the first line, cut to 200 characters,
    // is stored; the rest stays in Codex's record (name/summary/locator rule).
    let script = format!(
        "python3 - <<'EOF' {}\nAPI_KEY=secret-value\nprint(1)\nEOF",
        "x".repeat(5_000)
    );
    let v = project(
        json!({"type":"commandExecution","id":"c","command":script,"status":"completed",
        "commandActions":[{"type":"search","command":"rg","query":format!("{}\nsecret-value", "q".repeat(500)),"path":"src"}]}),
    );
    let input = v["input"].as_str().unwrap();
    assert!(input.starts_with("python3 - <<'EOF' xxx"), "{input}");
    assert!(input.ends_with('…'));
    assert_eq!(input.chars().count(), 200);
    let query = v["commandActions"][0]["query"].as_str().unwrap();
    assert_eq!(query.chars().count(), 200);
    assert!(!v.to_string().contains("secret-value"));
}
#[test]
fn file_change() {
    let v = project(
        json!({"type":"fileChange","id":"f","status":"completed","changes":[{"path":"old","kind":{"type":"update","move_path":"new"},"diff":"secret"}]}),
    );
    assert_eq!(v["fileName"], "old");
    assert_eq!(
        v["changes"][0],
        json!({"operation":"move","path":"new","oldPath":"old"})
    );
    assert_eq!(v["patchOmitted"], true);
}
#[test]
fn file_change_keeps_bounded_paths_and_entries() {
    // Paths are summaries too: one line, at most 200 characters, at most 50 entries.
    let long = format!("src/{}.rs", "d".repeat(1_000));
    let mut changes = vec![
        json!({"path": long, "kind": {"type": "add"}, "diff": "x"}),
        json!({"path": "a.rs\nsecret-value", "kind": {"type": "update", "move_path": "b.rs\nsecret-value"}, "diff": "x"}),
    ];
    for n in 0..118 {
        changes.push(json!({"path": format!("f{n}.rs"), "kind": {"type": "update"}, "diff": "x"}));
    }
    let v = project(json!({"type":"fileChange","id":"f","status":"completed","changes":changes}));
    let file_name = v["fileName"].as_str().unwrap();
    assert_eq!(file_name.chars().count(), 200);
    assert!(file_name.ends_with('…'));
    let listed = v["changes"].as_array().unwrap();
    assert_eq!(listed.len(), 50);
    assert_eq!(listed[0]["path"].as_str().unwrap().chars().count(), 200);
    assert_eq!(
        listed[1],
        json!({"operation":"move","path":"b.rs…","oldPath":"a.rs…"})
    );
    assert!(!v.to_string().contains("secret-value"));
}
#[test]
fn summary_line_never_exceeds_the_limit() {
    use goat2_engine_codex::items::{SUMMARY_MAX_CHARS, summary_line};
    assert_eq!(summary_line("  ls -la  "), "ls -la");
    assert_eq!(summary_line("\n\n  first\nsecond"), "first…");
    for len in [199, 200, 201, 5_000] {
        let one = "é".repeat(len);
        let s = summary_line(&one);
        assert!(s.chars().count() <= SUMMARY_MAX_CHARS, "{len}");
        assert_eq!(s.ends_with('…'), len > SUMMARY_MAX_CHARS, "{len}");
        let two = summary_line(&format!("{one}\nmore"));
        assert!(two.chars().count() <= SUMMARY_MAX_CHARS, "{len}");
        assert!(two.ends_with('…'));
    }
}
#[test]
fn web_search() {
    let v = project(
        json!({"type":"webSearch","id":"w","query":" q ","action":{"type":"search","queries":["a","q"],"query":"a"}}),
    );
    assert_eq!(v["patterns"], json!(["a", "q"]));
}
#[test]
fn mcp_tool() {
    let v = project(
        json!({"type":"mcpToolCall","id":"m","server":"s","tool":"t","arguments":{"a":1},"status":"completed"}),
    );
    assert_eq!(v["toolName"], "s.t");
    assert_eq!(v["outputOmitted"], true);
}
#[test]
fn dynamic_tool() {
    let v = project(
        json!({"type":"dynamicToolCall","id":"d","namespace":" n ","tool":"t","arguments":{"token":"secret-value","blob":"x"},"status":"completed"}),
    );
    assert_eq!(v["toolName"], "n.t");
    // Tool calls keep name, summary and locator only: arguments are never stored.
    assert_eq!(v["input"], Value::Null);
    assert!(!v.to_string().contains("secret-value"));
}
#[test]
fn mcp_tool_call_keeps_no_arguments() {
    let big = "y".repeat(200_000);
    let v = project(
        json!({"type":"mcpToolCall","id":"m","server":"goat","tool":"thread_send","arguments":{"message":big,"apiKey":"secret-value"},"status":"completed"}),
    );
    assert_eq!(v["toolName"], "goat.thread_send");
    assert_eq!(v["input"], Value::Null);
    assert!(v.to_string().len() < 2_000, "{} bytes", v.to_string().len());
    assert!(!v.to_string().contains("secret-value"));
}
#[test]
fn image_view() {
    let v = project(json!({"type":"imageView","id":"i","path":"/tmp/a.png"}));
    assert_eq!(v["toolName"], "view_image");
    assert_eq!(v["input"], Value::Null);
    assert_eq!(v["toolSummary"], "/tmp/a.png");
}
#[test]
fn image_generation() {
    let v = project(
        json!({"type":"imageGeneration","id":"i","status":"failed","revisedPrompt":"p","failure":{"message":"no"}}),
    );
    assert_eq!(v["title"], "Generate image");
    assert_eq!(v["status"], "failed");
    assert_eq!(v["input"], Value::Null);
    assert!(!v.to_string().contains("\"p\""));
    assert!(v.get("output").is_none());
}
#[test]
fn compaction() {
    let v = project(json!({"type":"contextCompaction","id":"x"}));
    assert_eq!(v["title"], "Context compacted");
}
#[test]
fn ignored_and_started() {
    let thread = ThreadId::from("t");
    let ctx = ItemContext {
        thread_id: &thread,
        codex_thread_id: "codex-thread",
        turn_id: "u",
        ordinal: 0,
        started_at_ms: None,
        completed_at_ms: 0,
    };
    for value in [
        json!({"type":"userMessage","id":"u","content":[]}),
        json!({"type":"fileChange","id":"f","changes":[],"status":"completed"}),
        json!({"type":"hookPrompt","id":"h"}),
        json!({"type":"unknownNewType"}),
    ] {
        let item: ThreadItem = serde_json::from_value(value).unwrap();
        assert!(completed_item(&item, &ctx).is_none());
    }
    let item: ThreadItem =
        serde_json::from_value(json!({"type":"webSearch","id":"w","query":"x"})).unwrap();
    let v = serde_json::to_value(started_item(&item, &ctx).unwrap()).unwrap();
    assert_eq!(v["status"], "running");
    assert!(v["completedAt"].is_null());
}
#[test]
fn timestamps_and_status() {
    assert_eq!(rfc3339_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(rfc3339_ms(-1), "1969-12-31T23:59:59.999Z");
    assert_eq!(rfc3339_ms(951782400123), "2000-02-29T00:00:00.123Z");
    assert_eq!(format!("{:?}", item_status(Some("declined"))), "Cancelled");
}
#[test]
fn search_patterns() {
    assert_eq!(
        web_search_patterns(
            " q ",
            Some(&json!({"type":"search","queries":[" a ","q",""],"query":"a"}))
        ),
        vec!["a", "q"]
    );
    assert_eq!(
        web_search_patterns("q", Some(&json!({"type":"openPage","url":"u"}))),
        vec!["u", "q"]
    );
    assert_eq!(
        web_search_patterns(
            "q",
            Some(&json!({"type":"findInPage","pattern":"p","url":"u"}))
        ),
        vec!["p", "u", "q"]
    );
    assert_eq!(
        web_search_patterns(" q ", Some(&json!({"type":"other"}))),
        vec!["q"]
    );
    assert!(web_search_patterns(" ", None).is_empty());
}
