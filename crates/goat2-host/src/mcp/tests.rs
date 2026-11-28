use super::*;
use async_trait::async_trait;
use goat2_contracts::{RunId, ThreadId, ThreadKind};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Fake {
    calls: AtomicUsize,
}
#[async_trait]
impl McpHost for Fake {
    fn grant(&self, token: &str) -> Option<McpGrant> {
        match token {
            "good" | "inactive" => Some(McpGrant {
                thread_id: ThreadId::from(token),
                process_generation: 1,
                host_generation: 1,
            }),
            _ => None,
        }
    }
    async fn caller(&self, g: &McpGrant) -> Result<api::Caller, api::SurfaceError> {
        if g.thread_id.as_str() == "inactive" {
            return Err(api::SurfaceError::new(
                ErrorCode::FailedPrecondition,
                "no_active_run",
                "No run",
                false,
            ));
        }
        Ok(api::Caller {
            thread_id: g.thread_id.clone(),
            run_id: RunId::from("run"),
            kind: ThreadKind::Worker,
        })
    }
    async fn thread_start(&self, c: &api::Caller, a: api::ThreadStartArgs) -> SurfaceResult {
        let count = self.calls.fetch_add(1, Ordering::SeqCst);
        if a.task == "parallel" {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if a.task == "retry" && count == 0 {
            return SurfaceResult::err(
                ErrorCode::Unavailable,
                "not_started",
                "No effect ran",
                true,
            );
        }
        SurfaceResult::ok(json!({"threadId":c.thread_id,"task":a.task}))
    }
    async fn thread_send(&self, _: &api::Caller, _: api::ThreadSendArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
    async fn thread_read(&self, _: &api::Caller, _: api::ThreadReadArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
    async fn thread_list(&self, _: &api::Caller, _: api::ThreadListArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
    async fn thread_wait(&self, _: &api::Caller, _: api::ThreadWaitArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
    async fn thread_stop(&self, _: &api::Caller, _: api::ThreadStopArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
    async fn report_result(&self, _: &api::Caller, _: api::ReportResultArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
    async fn user_send(&self, _: &api::Caller, _: api::UserSendArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
    async fn request_ask(&self, _: &api::Caller, _: api::RequestAskArgs) -> SurfaceResult {
        SurfaceResult::ok(json!({}))
    }
}
async fn serve() -> (String, Arc<Fake>) {
    let host = Arc::new(Fake::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(axum::serve(listener, router(host.clone())).into_future());
    (format!("http://{addr}/mcp"), host)
}
async fn rpc(url: &str, token: &str, method: &str, params: Value) -> Value {
    let res = reqwest::Client::new()
        .post(url)
        .bearer_auth(token)
        .header("accept", "application/json, text/event-stream")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
        .send()
        .await
        .unwrap();
    let status = res.status();
    let text = res.text().await.unwrap();
    assert!(status.is_success(), "{status}: {text}");
    serde_json::from_str(&text).unwrap()
}
async fn call(url: &str, token: &str, name: &str, args: Value) -> Value {
    let r = rpc(
        url,
        token,
        "tools/call",
        json!({"name":name,"arguments":args}),
    )
    .await;
    let result = &r["result"];
    let value = result["structuredContent"].clone();
    assert_eq!(
        serde_json::from_str::<Value>(result["content"][0]["text"].as_str().unwrap()).unwrap(),
        value
    );
    assert_eq!(result["isError"], value["status"] == "error");
    value
}
#[tokio::test]
async fn http_surface_auth_and_dispatch() {
    let (url, host) = serve().await;
    let res = reqwest::Client::new()
        .post(&url)
        .bearer_auth("bad")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
    let init=rpc(&url,"good","initialize",json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}})).await;
    assert!(init.get("result").is_some(), "{init}");
    let list = rpc(&url, "good", "tools/list", json!({})).await;
    let names: Vec<_> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["goat_describe", "goat_call"]);
    assert_eq!(
        call(&url, "good", "goat_describe", json!({})).await["value"]["depth"],
        "surface"
    );
    assert_eq!(
        call(
            &url,
            "good",
            "goat_describe",
            json!({"path":"thread.start"})
        )
        .await["value"]["entry"]["name"],
        "goat_thread_start"
    );
    assert_eq!(
        call(
            &url,
            "good",
            "goat_describe",
            json!({"query":"thread.start"})
        )
        .await["value"]["mode"],
        "exact"
    );
    let bad = call(
        &url,
        "good",
        "goat_call",
        json!({"path":"thread.start","args":{}}),
    )
    .await;
    assert_eq!(bad["error"]["reason"], "invalid_params");
    assert!(
        bad["error"]["details"]["expectedSignature"]
            .as_str()
            .unwrap()
            .contains(":task")
    );
    let args = json!({"path":"thread.start","args":{"task":"one","clientRequestId":"x"}});
    let first = call(&url, "good", "goat_call", args.clone()).await;
    assert_eq!(first["value"]["threadId"], "good");
    assert_eq!(first, call(&url, "good", "goat_call", args).await);
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
    let conflict = call(
        &url,
        "good",
        "goat_call",
        json!({"path":"goat_thread_start","args":{"task":"two","clientRequestId":"x"}}),
    )
    .await;
    assert_eq!(conflict["error"]["reason"], "idempotency_conflict");
    let refused = call(
        &url,
        "inactive",
        "goat_call",
        json!({"path":"thread.start","args":{"task":"one"}}),
    )
    .await;
    assert_eq!(refused["error"]["reason"], "no_active_run");
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
}
#[test]
fn registry_rules_and_examples() {
    for e in registry() {
        assert!(e["description"].as_str().unwrap().chars().count() <= 400);
        if e["effect"] != "read" {
            assert!(e.get("idempotency").is_some() || e.get("idempotencyReason").is_some())
        }
        for example in e["examples"].as_array().unwrap() {
            let a = example["args"].clone();
            let decoded: Result<(), _> = match e["path"].as_str().unwrap() {
                "thread.start" => serde_json::from_value::<api::ThreadStartArgs>(a).map(|_| ()),
                "thread.send" => serde_json::from_value::<api::ThreadSendArgs>(a).map(|_| ()),
                "thread.read" => serde_json::from_value::<api::ThreadReadArgs>(a).map(|_| ()),
                "thread.list" => serde_json::from_value::<api::ThreadListArgs>(a).map(|_| ()),
                "thread.wait" => serde_json::from_value::<api::ThreadWaitArgs>(a).map(|_| ()),
                "thread.stop" => serde_json::from_value::<api::ThreadStopArgs>(a).map(|_| ()),
                "thread.report_result" => {
                    serde_json::from_value::<api::ReportResultArgs>(a).map(|_| ())
                }
                "user.send" => serde_json::from_value::<api::UserSendArgs>(a).map(|_| ()),
                "request.ask" => serde_json::from_value::<api::RequestAskArgs>(a).map(|_| ()),
                _ => Ok(()),
            };
            assert!(decoded.is_ok(), "{}: {decoded:?}", e["path"]);
        }
    }
}

#[test]
fn registry_schema_fields_match_structs() {
    fn fields<T: serde::de::DeserializeOwned + serde::Serialize>(e: &Value) {
        let value: T = serde_json::from_value(e["examples"][0]["args"].clone()).unwrap();
        let serialized = serde_json::to_value(value).unwrap();
        let actual: std::collections::BTreeSet<_> =
            serialized.as_object().unwrap().keys().cloned().collect();
        let expected: std::collections::BTreeSet<_> = e["inputSchema"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(actual, expected, "{}", e["path"]);
    }
    for e in registry() {
        match e["path"].as_str().unwrap() {
            "thread.start" => fields::<api::ThreadStartArgs>(e),
            "thread.send" => fields::<api::ThreadSendArgs>(e),
            "thread.read" => fields::<api::ThreadReadArgs>(e),
            "thread.list" => fields::<api::ThreadListArgs>(e),
            "thread.wait" => fields::<api::ThreadWaitArgs>(e),
            "thread.stop" => fields::<api::ThreadStopArgs>(e),
            "thread.report_result" => fields::<api::ReportResultArgs>(e),
            "user.send" => fields::<api::UserSendArgs>(e),
            "request.ask" => fields::<api::RequestAskArgs>(e),
            _ => (),
        }
    }
}

#[tokio::test]
async fn concurrent_reservations_and_retryable_release() {
    let (url, host) = serve().await;
    let args = json!({"path":"thread.start","args":{"task":"parallel","clientRequestId":"same"}});
    let (a, b) = tokio::join!(
        call(&url, "good", "goat_call", args.clone()),
        call(&url, "good", "goat_call", args)
    );
    assert_eq!(a, b);
    assert_eq!(a["status"], "ok");
    assert_eq!(host.calls.load(Ordering::SeqCst), 1);
    let (url, host) = serve().await;
    let args = json!({"path":"thread.start","args":{"task":"retry","clientRequestId":"again"}});
    assert_eq!(
        call(&url, "good", "goat_call", args.clone()).await["error"]["retryable"],
        true
    );
    assert_eq!(call(&url, "good", "goat_call", args).await["status"], "ok");
    assert_eq!(host.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn discovery_pages_and_method_authentication() {
    let (url, _) = serve().await;
    let client = reqwest::Client::new();
    for response in [
        client.get(&url).bearer_auth("bad").send().await.unwrap(),
        client.delete(&url).bearer_auth("bad").send().await.unwrap(),
    ] {
        assert_eq!(response.status(), 401);
    }
    let first = call(
        &url,
        "good",
        "goat_describe",
        json!({"query":"thread","limit":1}),
    )
    .await;
    assert_eq!(first["value"]["truncated"], true);
    let cursor = first["value"]["nextCursor"].as_str().unwrap();
    let second = call(
        &url,
        "good",
        "goat_describe",
        json!({"query":"thread","limit":1,"cursor":cursor}),
    )
    .await;
    assert_ne!(
        first["value"]["entries"][0]["path"],
        second["value"]["entries"][0]["path"]
    );
    let stale = call(
        &url,
        "good",
        "goat_describe",
        json!({"query":"other","cursor":cursor}),
    )
    .await;
    assert_eq!(stale["error"]["reason"], "invalid_params");
    let paths = call(
        &url,
        "good",
        "goat_describe",
        json!({"paths":["thread.start","thread.missing"]}),
    )
    .await;
    assert_eq!(paths["value"]["entries"][0]["path"], "thread.start");
    assert_eq!(paths["value"]["missing"][0]["path"], "thread.missing");
    assert!(
        !paths["value"]["missing"][0]["nearest"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
