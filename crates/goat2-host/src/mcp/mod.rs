//! Authenticated agent MCP endpoint and its Part 1 registry.
use crate::api::{self, ErrorCode, McpGrant, McpHost, SurfaceResult};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::Response,
};
use rmcp::{
    ErrorData, ServerHandler,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::{RequestContext, RoleServer},
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::never::NeverSessionManager,
    },
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, OnceLock},
};
use tokio::sync::{Mutex, watch};

const REGISTRY: &str = include_str!("registry.json");
fn registry() -> &'static Vec<Value> {
    static VALUE: OnceLock<Vec<Value>> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(REGISTRY).expect("valid embedded registry"))
}
fn entry(name: &str) -> Option<&'static Value> {
    registry()
        .iter()
        .find(|e| e["path"] == name || e["name"] == name)
}
fn version() -> String {
    let mut h = 0x811c9dc5u32;
    for b in REGISTRY.bytes() {
        h = (h ^ u32::from(b)).wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}
fn nearest(name: &str) -> Vec<&'static str> {
    let first = name.split(['.', '_']).next().unwrap_or("");
    registry()
        .iter()
        .filter_map(|e| e["path"].as_str())
        .filter(|p| !first.is_empty() && p.contains(first))
        .take(3)
        .collect()
}
fn describe(args: &Value) -> SurfaceResult {
    let entries = registry();
    if let Some(paths) = args.get("paths").and_then(Value::as_array) {
        let mut found = Vec::new();
        let mut missing = Vec::new();
        for p in paths {
            if let Some(s) = p.as_str() {
                if let Some(e) = entry(s) {
                    if !found.contains(e) {
                        found.push(e.clone());
                    }
                } else {
                    missing.push(json!({"path":s,"nearest":nearest(s)}));
                }
            }
        }
        return SurfaceResult::ok(json!({"depth":"paths","entries":found,"missing":missing}));
    }
    if let Some(q) = args.get("query").and_then(Value::as_str) {
        let words: Vec<_> = q.split_whitespace().map(str::to_lowercase).collect();
        let mut matches = Vec::new();
        for e in entries {
            if let Some(resource) = args.get("path").and_then(Value::as_str)
                && e["path"]
                    .as_str()
                    .is_none_or(|p| p.split('.').next() != Some(resource))
            {
                continue;
            }
            let text = format!(
                "{} {} {} {}",
                e["path"], e["name"], e["summary"], e["description"]
            )
            .to_lowercase();
            let matched: Vec<_> = words
                .iter()
                .filter(|w| text.contains(w.as_str()))
                .cloned()
                .collect();
            let exact = e["path"]
                .as_str()
                .is_some_and(|p| p.eq_ignore_ascii_case(q))
                || e["name"]
                    .as_str()
                    .is_some_and(|p| p.eq_ignore_ascii_case(q));
            if exact || !matched.is_empty() {
                let mut x = e.clone();
                x["match"] = json!(if exact {
                    "exact"
                } else if matched.len() == words.len() {
                    "all"
                } else {
                    "partial"
                });
                x["matchedWords"] = json!(matched);
                matches.push(x);
            }
        }
        let mode = if matches.iter().any(|e| e["match"] == "exact") {
            "exact"
        } else if matches.iter().any(|e| e["match"] == "all") {
            "all"
        } else if matches.is_empty() {
            "none"
        } else {
            "partial"
        };
        matches.retain(|e| e["match"] == mode);
        let total = matches.len();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(10)
            .clamp(1, 50) as usize;
        let offset = if let Some(cursor) = args.get("cursor").and_then(Value::as_str) {
            let Ok(c) = serde_json::from_str::<Value>(cursor) else {
                return invalid(
                    entry("surface.describe").expect("registry entry"),
                    "Invalid cursor".into(),
                );
            };
            if c["version"] != version()
                || c["query"] != q
                || c["path"] != args.get("path").cloned().unwrap_or(Value::Null)
            {
                return invalid(
                    entry("surface.describe").expect("registry entry"),
                    "Cursor belongs to another search".into(),
                );
            }
            match c["offset"].as_u64().and_then(|n| usize::try_from(n).ok()) {
                Some(n) if n < total => n,
                _ => {
                    return invalid(
                        entry("surface.describe").expect("registry entry"),
                        "Invalid cursor offset".into(),
                    );
                }
            }
        } else {
            0
        };
        let page: Vec<_> = matches.into_iter().skip(offset).take(limit).collect();
        let next = offset + page.len();
        let mut result = json!({"depth":"search","surfaceVersion":version(),"query":q,"mode":mode,"returned":page.len(),"total":total,"truncated":next<total,"entries":page});
        if next < total {
            result["nextCursor"] = json!(
                json!({"version":version(),"query":q,"path":args.get("path"),"offset":next})
                    .to_string()
            );
        }
        return SurfaceResult::ok(result);
    }
    if let Some(path) = args.get("path").and_then(Value::as_str) {
        if let Some(e) = entry(path) {
            return SurfaceResult::ok(json!({"depth":"path","entry":e}));
        }
        let selected: Vec<_> = entries
            .iter()
            .filter(|e| {
                e["path"]
                    .as_str()
                    .is_some_and(|p| p.split('.').next() == Some(path))
            })
            .collect();
        return SurfaceResult::ok(json!({"depth":"resource","resource":path,"entries":selected}));
    }
    let mut resources: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for e in entries {
        if let Some((r, v)) = e["path"].as_str().and_then(|s| s.split_once('.')) {
            resources.entry(r).or_default().push(v);
        }
    }
    let resources: Vec<_> = resources
        .into_iter()
        .map(|(r, v)| json!({"resource":r,"verbs":v}))
        .collect();
    SurfaceResult::ok(
        json!({"depth":"surface","surfaceVersion":version(),"resources":resources,"next":"Pass a resource, path, paths, or query to goat_describe."}),
    )
}

type Reservation = (Value, watch::Receiver<Option<SurfaceResult>>);
type Reservations = Arc<Mutex<HashMap<(String, String, String), Reservation>>>;
#[derive(Clone)]
struct Service {
    host: Arc<dyn McpHost>,
    reservations: Reservations,
}
async fn auth(
    axum::extract::State(host): axum::extract::State<Arc<dyn McpHost>>,
    mut req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let grant = host.grant(token).ok_or(StatusCode::UNAUTHORIZED)?;
    req.extensions_mut().insert(grant);
    Ok(next.run(req).await)
}
/// Build the authenticated streamable HTTP MCP router.
pub fn router(host: Arc<dyn McpHost>) -> Router {
    let server = Service {
        host: host.clone(),
        reservations: Arc::new(Mutex::new(HashMap::new())),
    };
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(NeverSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .enforce_origin_validation(),
    );
    Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(host, auth))
}
fn signature(e: &Value) -> String {
    let schema = &e["inputSchema"];
    let required = schema["required"].as_array();
    let mut s = format!("({}", e["path"].as_str().unwrap_or(""));
    if let Some(props) = schema["properties"].as_object() {
        for k in props.keys() {
            let needed = required.is_some_and(|r| r.contains(&json!(k)));
            s.push_str(&format!(" :{k}{}", if needed { "" } else { "?" }));
        }
    }
    s.push(')');
    s
}
fn invalid(e: &Value, message: String) -> SurfaceResult {
    let mut err =
        api::SurfaceError::new(ErrorCode::InvalidRequest, "invalid_params", message, false);
    err.details = Some(json!({"expectedSignature":signature(e)}));
    err.into()
}
macro_rules! decode {
    ($args:expr,$entry:expr,$ty:ty) => {
        match serde_json::from_value::<$ty>($args.clone()) {
            Ok(v) => v,
            Err(e) => return invalid($entry, e.to_string()),
        }
    };
}
async fn dispatch(
    host: &dyn McpHost,
    caller: &api::Caller,
    path: &str,
    args: Value,
    e: &Value,
) -> SurfaceResult {
    match path {
        "thread.start" => {
            let a = decode!(args, e, api::ThreadStartArgs);
            if a.timeout_ms.is_some_and(|n| n > 60000) {
                return invalid(e, "timeoutMs exceeds 60000".into());
            }
            host.thread_start(caller, a).await
        }
        "thread.send" => {
            host.thread_send(caller, decode!(args, e, api::ThreadSendArgs))
                .await
        }
        "thread.read" => {
            host.thread_read(caller, decode!(args, e, api::ThreadReadArgs))
                .await
        }
        "thread.list" => {
            host.thread_list(caller, decode!(args, e, api::ThreadListArgs))
                .await
        }
        "thread.wait" => {
            let a = decode!(args, e, api::ThreadWaitArgs);
            if a.timeout_ms.is_some_and(|n| n > 60000) {
                return invalid(e, "timeoutMs exceeds 60000".into());
            }
            match tokio::time::timeout(
                std::time::Duration::from_secs(60),
                host.thread_wait(caller, a),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => SurfaceResult::err(
                    ErrorCode::Timeout,
                    "wait_timeout",
                    "Thread wait exceeded 60 seconds",
                    true,
                ),
            }
        }
        "thread.stop" => {
            host.thread_stop(caller, decode!(args, e, api::ThreadStopArgs))
                .await
        }
        "thread.report_result" => {
            host.report_result(caller, decode!(args, e, api::ReportResultArgs))
                .await
        }
        "user.send" => {
            host.user_send(caller, decode!(args, e, api::UserSendArgs))
                .await
        }
        "request.ask" => {
            let a = decode!(args, e, api::RequestAskArgs);
            if a.kind == api::AskKind::Decision && a.options.is_empty() {
                return invalid(e, "decision requires options".into());
            }
            host.request_ask(caller, a).await
        }
        "surface.describe" => describe(&args),
        _ => SurfaceResult::err(
            ErrorCode::InvalidRequest,
            "unknown_path",
            "Unknown path",
            false,
        ),
    }
}
impl Service {
    async fn call(&self, grant: McpGrant, path: &str, args: Value) -> SurfaceResult {
        let Some(e) = entry(path) else {
            return SurfaceResult::err(
                ErrorCode::InvalidRequest,
                "unknown_path",
                "Unknown path",
                false,
            );
        };
        let path = e["path"].as_str().unwrap_or("");
        // Decode before reserving: invalid calls must never hold a key.
        let valid = match path {
            "thread.start" => {
                serde_json::from_value::<api::ThreadStartArgs>(args.clone()).map(|_| ())
            }
            "thread.send" => {
                serde_json::from_value::<api::ThreadSendArgs>(args.clone()).map(|_| ())
            }
            "thread.read" => {
                serde_json::from_value::<api::ThreadReadArgs>(args.clone()).map(|_| ())
            }
            "thread.list" => {
                serde_json::from_value::<api::ThreadListArgs>(args.clone()).map(|_| ())
            }
            "thread.wait" => {
                serde_json::from_value::<api::ThreadWaitArgs>(args.clone()).map(|_| ())
            }
            "thread.stop" => {
                serde_json::from_value::<api::ThreadStopArgs>(args.clone()).map(|_| ())
            }
            "thread.report_result" => {
                serde_json::from_value::<api::ReportResultArgs>(args.clone()).map(|_| ())
            }
            "user.send" => serde_json::from_value::<api::UserSendArgs>(args.clone()).map(|_| ()),
            "request.ask" => {
                serde_json::from_value::<api::RequestAskArgs>(args.clone()).map(|_| ())
            }
            _ => Ok(()),
        };
        if let Err(err) = valid {
            return invalid(e, err.to_string());
        }
        let caller = match self.host.caller(&grant).await {
            Ok(c) => c,
            Err(err) => return err.into(),
        };
        if path == "thread.report_result" && caller.kind != goat2_contracts::ThreadKind::Worker {
            return SurfaceResult::err(
                ErrorCode::PermissionDenied,
                "worker_only",
                "Only worker threads can report results",
                false,
            );
        }
        if path == "surface.call" {
            let Some(nested) = args.get("path").and_then(Value::as_str) else {
                return invalid(e, "Missing path".into());
            };
            return Box::pin(self.call(
                grant,
                nested,
                args.get("args").cloned().unwrap_or_else(|| json!({})),
            ))
            .await;
        }
        if (path == "thread.start" || path == "thread.wait")
            && args
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .is_some_and(|n| n > 60000)
        {
            return invalid(e, "timeoutMs exceeds 60000".into());
        }
        if path == "request.ask"
            && args.get("kind") == Some(&json!("decision"))
            && args
                .get("options")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        {
            return invalid(e, "decision requires options".into());
        }
        if e["idempotency"] == "key"
            && let Some(id) = args.get("clientRequestId").and_then(Value::as_str)
        {
            let key = (caller.thread_id.to_string(), path.to_owned(), id.to_owned());
            let mut map = self.reservations.lock().await;
            if let Some((old, rx)) = map.get(&key) {
                if old != &args {
                    return SurfaceResult::err(
                        ErrorCode::Conflict,
                        "idempotency_mismatch",
                        "Key already used with different arguments",
                        false,
                    );
                }
                let mut rx = rx.clone();
                drop(map);
                loop {
                    if let Some(result) = rx.borrow().clone() {
                        return result;
                    }
                    if rx.changed().await.is_err() {
                        return SurfaceResult::err(
                            ErrorCode::UnknownOutcome,
                            "outcome_unknown",
                            "The original call did not complete",
                            false,
                        );
                    }
                }
            }
            let (tx, mut rx) = watch::channel(None);
            map.insert(key.clone(), (args.clone(), rx.clone()));
            drop(map);
            let svc = self.clone();
            let path = path.to_owned();
            tokio::spawn(async move {
                let result = dispatch(svc.host.as_ref(), &caller, &path, args, e).await;
                if matches!(&result,SurfaceResult::Error{error} if error.retryable) {
                    svc.reservations.lock().await.remove(&key);
                }
                tx.send_replace(Some(result));
            });
            loop {
                if let Some(result) = rx.borrow().clone() {
                    return result;
                }
                if rx.changed().await.is_err() {
                    return SurfaceResult::err(
                        ErrorCode::UnknownOutcome,
                        "outcome_unknown",
                        "The original call did not complete",
                        false,
                    );
                }
            }
        }
        dispatch(self.host.as_ref(), &caller, path, args, e).await
    }
}
impl ServerHandler for Service {
    fn get_info(&self) -> ServerConfig {
        {
            let mut info = ServerConfig::default();
            info.capabilities = ServerCapabilities::builder().enable_tools().build();
            info
        }
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = registry()
            .iter()
            .take(2)
            .map(|e| {
                Tool::new(
                    e["name"].as_str().unwrap_or("").to_owned(),
                    e["description"].as_str().unwrap_or("").to_owned(),
                    e["inputSchema"].as_object().cloned().unwrap_or_default(),
                )
            })
            .collect();
        Ok(ListToolsResult::with_all_items(tools))
    }
    async fn call_tool(
        &self,
        req: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let grant = ctx
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|p| p.extensions.get::<McpGrant>())
            .cloned()
            .ok_or_else(|| ErrorData::internal_error("Missing authenticated grant", None))?;
        let args = Value::Object(req.arguments.unwrap_or_default());
        let result = match req.name.as_ref() {
            "goat_describe" => match self.host.caller(&grant).await {
                Ok(_) => describe(&args),
                Err(e) => e.into(),
            },
            "goat_call" => {
                if let Some(path) = args.get("path").and_then(Value::as_str) {
                    self.call(
                        grant,
                        path,
                        args.get("args").cloned().unwrap_or_else(|| json!({})),
                    )
                    .await
                } else {
                    invalid(
                        entry("surface.call").expect("registry has surface.call"),
                        "Missing path".into(),
                    )
                }
            }
            _ => return Err(ErrorData::invalid_params("Unknown tool", None)),
        };
        let is_error = matches!(result, SurfaceResult::Error { .. });
        let value = serde_json::to_value(result)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let mut output = CallToolResult::success(vec![ContentBlock::text(value.to_string())]);
        output.structured_content = Some(value);
        output.is_error = Some(is_error);
        Ok(output.into())
    }
}

#[cfg(test)]
mod tests;
