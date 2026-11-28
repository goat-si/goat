//! A fake ACP agent for tests: newline-delimited JSON-RPC on stdio, scenarios chosen by
//! environment variables.
//!
//! Ported from GOAT v1 `apps/server/scripts/acp-mock-agent.ts` (origin/dev 916b5ccc) and its helpers
//! (`acpMockPrompt.ts`, `acpMockNotices.ts`, `acpMockGrokScenarios.ts`, `acp-mock-prompt-crash.ts`,
//! `acp-mock-load-replay.ts`). Variable names are v1's where v1 has the scenario; GOAT 2 additions
//! are marked "(GOAT 2)". v1 spoke ACP v2 through effect-acp; this agent speaks ACP v1 on the wire,
//! which is what the Rust driver negotiates.
//!
//! - `GOAT_ACP_AGENT_VERSION`: `agentInfo.version` (default `0.0.0`).
//! - `GOAT_ACP_MCP_HTTP=1`: advertise `mcpCapabilities.http`.
//! - `GOAT_ACP_AUTH_METHOD_ID=<id>`: advertise an agent auth method; `session/new` answers -32000
//!   until `authenticate` with it.
//! - `GOAT_ACP_SYSTEM_PROMPT=1` (GOAT 2): advertise `sessionCapabilities.systemPrompt`.
//! - `GOAT_ACP_LOAD_SESSION=0` (GOAT 2): do not advertise `loadSession`; `GOAT_ACP_RESUME_SESSION=1`
//!   advertises `sessionCapabilities.resume`.
//! - `GOAT_ACP_REQUEST_LOG_PATH=<file>` (GOAT 2): append every inbound message as a JSON line.
//! - `GOAT_ACP_PROMPT_RESPONSE_TEXT`: the reply text (default `hello from mock`).
//! - `GOAT_ACP_EMIT_TOOL_CALLS=1`: `before tool`, an `echo hello` command, `after tool`.
//! - `GOAT_ACP_PERMISSION_REQUEST_COUNT=<n>`: ask permission n times for `cat server/package.json`.
//! - `GOAT_ACP_OMIT_ALLOW_ALWAYS=1`: permission options without `allow_always`.
//! - `GOAT_ACP_EMIT_ELICITATION=1` with `GOAT_ACP_ELICITATION_SCHEMA=<json>`: `elicitation/create`;
//!   `GOAT_ACP_ELICITATION_RESPONSE_LOG_PATH` records the answer.
//! - `GOAT_ACP_EMIT_XAI_ASK_USER_QUESTION=1` (GOAT 2): `_x.ai/ask_user_question` (one question, Red/Blue), the
//!   reply printed as `xai question: <json>`.
//! - `GOAT_ACP_EMIT_XAI_EXIT_PLAN_MODE=1` (GOAT 2): `_x.ai/exit_plan_mode` with `# Plan`, the reply printed as
//!   `xai plan: <json>`.
//! - `GOAT_ACP_EMIT_URL_ELICITATION=1`: a url-mode elicitation.
//! - `GOAT_ACP_EMIT_NOTICE=1`: the v1 notice list (valid, malformed and blank).
//! - `GOAT_ACP_HANG_PROMPT_FOREVER=1`: `partial before stall`, then wait for `session/cancel`.
//! - `GOAT_ACP_EXIT_ON_CANCEL=1`: exit on `session/cancel` instead of answering.
//! - `GOAT_ACP_IGNORE_CANCEL=1` (GOAT 2): ignore `session/cancel` (a wedged prompt).
//! - `GOAT_ACP_FAIL_PROMPT=1`: answer `session/prompt` with an error.
//! - `GOAT_ACP_CRASH_PROMPT=1`: exit during the prompt.
//! - `GOAT_ACP_STOP_REASON=<reason>` (GOAT 2): stop reason of a finished prompt.
//! - `GOAT_ACP_EMIT_LOAD_REPLAY=1`: `session/load` replays history before answering.
//! - `GOAT_ACP_STEERS_WITH_PROMPT=1` (GOAT 2): a prompt sent while one runs ends the running one
//!   with `end_turn` and carries on (Antigravity 1.5 behaviour).
//! - `GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG=1`: send `_x.ai/session/prompt_complete` with
//!   the prompt's `_meta.promptId`, then never answer `session/prompt`. (GOAT 2) `GOAT_ACP_XAI_STOP_REASON`
//!   (default `end_turn`) and `GOAT_ACP_XAI_AGENT_RESULT` set its `stopReason` and `agentResult`.
//! - `GOAT_ACP_STDERR_LINE=<text>` (GOAT 2): print this line on stderr at start.
//! - `GOAT_ACP_STDOUT_LINE=<text>` (GOAT 2): print this non-JSON line on stdout at start.
//! - `GOAT_ACP_GROK_SCENARIO=<name>` (GOAT 2): xAI Grok flows that end with
//!   `_x.ai/session/prompt_complete` and leave `session/prompt` open, as Grok does (frame shapes from
//!   v1 `xaiAcpExtension.test.ts` and `acpMockGrokScenarios.ts`): `subagent-hydrate`,
//!   `subagent-finished`, `subagent-notice`, `background`, `wake`, `monitor`, `monitor-persistent`,
//!   `kill`, `hold`, `plan-file`, `tools`.
//! - `GOAT_ACP_GROK_MODELS=1` (GOAT 2): session setup reports Grok session models (`grok-4`, efforts
//!   low/high); `GOAT_ACP_REJECT_SET_MODEL_META=1` answers a `session/set_model` with `_meta` with an
//!   error.
//! - `inspect --json` arguments (GOAT 2): print `GOAT_ACP_GROK_INSPECT_JSON` (default no skills) and
//!   exit, like `grok inspect --json`.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn flag(name: &str) -> bool {
    env(name).as_deref() == Some("1")
}

struct Agent {
    out: Mutex<std::io::Stdout>,
    next_id: AtomicU64,
    waiting: Mutex<HashMap<u64, Sender<Value>>>,
    authenticated: AtomicBool,
    cancelled: Mutex<HashMap<String, Sender<()>>>,
    /// The running prompt's request id per session (steering ends it).
    running: Mutex<HashMap<String, Value>>,
    model: Mutex<String>,
    mode: Mutex<String>,
}

impl Agent {
    fn write(&self, message: Value) {
        let mut out = self.out.lock().unwrap();
        let _ = writeln!(out, "{message}");
        let _ = out.flush();
    }

    fn notify(&self, method: &str, params: Value) {
        self.write(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    fn update(&self, session: &str, update: Value) {
        self.notify(
            "session/update",
            json!({"sessionId": session, "update": update}),
        );
    }

    fn respond(&self, id: &Value, result: Value) {
        self.write(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn error(&self, id: &Value, code: i64, message: &str) {
        self.write(
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
        );
    }

    /// Send a request to the client and wait for its result.
    fn request(&self, method: &str, params: Value) -> Value {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1000;
        let (tx, rx) = channel();
        self.waiting.lock().unwrap().insert(id, tx);
        self.write(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        rx.recv().unwrap_or(Value::Null)
    }

    fn model_options(&self) -> Value {
        json!([{
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": *self.model.lock().unwrap(),
            "options": [{"value": "mock-default", "name": "Mock Default"}, {"value": "mock-fast", "name": "Mock Fast"}]
        }])
    }

    fn modes(&self) -> Value {
        json!({"currentModeId": *self.mode.lock().unwrap(), "availableModes": [
            {"id": "ask", "name": "Ask", "description": "Request permission before making any changes"},
            {"id": "architect", "name": "Architect"},
            {"id": "code", "name": "Code"}
        ]})
    }
}

fn log_inbound(message: &Value) {
    if let Some(path) = env("GOAT_ACP_REQUEST_LOG_PATH")
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = writeln!(file, "{message}");
    }
}

fn handle_request(agent: Arc<Agent>, id: Value, method: String, params: Value) {
    match method.as_str() {
        "initialize" => {
            let mut caps = json!({
                "loadSession": env("GOAT_ACP_LOAD_SESSION").as_deref() != Some("0"),
                "promptCapabilities": {"image": true, "embeddedContext": true},
                "mcpCapabilities": {"http": flag("GOAT_ACP_MCP_HTTP")},
                "sessionCapabilities": {}
            });
            if flag("GOAT_ACP_SYSTEM_PROMPT") {
                caps["sessionCapabilities"]["systemPrompt"] = json!({});
            }
            if flag("GOAT_ACP_RESUME_SESSION") {
                caps["sessionCapabilities"]["resume"] = json!({});
            }
            let mut result = json!({
                "protocolVersion": 1,
                "agentCapabilities": caps,
                "agentInfo": {"name": "t3-acp-mock-agent", "version": env("GOAT_ACP_AGENT_VERSION").unwrap_or_else(|| "0.0.0".into())},
                "authMethods": []
            });
            if let Some(method_id) = env("GOAT_ACP_AUTH_METHOD_ID") {
                result["authMethods"] =
                    json!([{"id": method_id, "name": "Mock agent authentication"}]);
            }
            agent.respond(&id, result);
        }
        "authenticate" => {
            let wanted = env("GOAT_ACP_AUTH_METHOD_ID");
            let got = params
                .get("methodId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if wanted.as_deref().is_some_and(|w| w != got) {
                agent.error(
                    &id,
                    -32602,
                    &format!("Unknown mock authentication method: {got}"),
                );
            } else {
                agent.authenticated.store(true, Ordering::SeqCst);
                agent.respond(&id, json!({}));
            }
        }
        "session/new" => {
            if env("GOAT_ACP_AUTH_METHOD_ID").is_some()
                && !agent.authenticated.load(Ordering::SeqCst)
            {
                agent.error(&id, -32000, "Authentication required");
                return;
            }
            let mut result = json!({
                "sessionId": "mock-session-1",
                "modes": agent.modes(),
                "configOptions": agent.model_options()
            });
            if flag("GOAT_ACP_GROK_MODELS") {
                result["models"] = json!({"currentModelId": "grok-4", "availableModels": [
                    {"modelId": "grok-4", "name": "Grok 4", "_meta": {"reasoningEffort": "low",
                        "reasoningEfforts": [{"value": "low"}, {"value": "high"}]}}
                ]});
            }
            agent.respond(&id, result);
        }
        "session/load" | "session/resume" => {
            let session = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("mock-session-1")
                .to_owned();
            if method == "session/load" && flag("GOAT_ACP_EMIT_LOAD_REPLAY") {
                agent.update(&session, json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "earlier question"}}));
                agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "replay"}}));
            }
            agent.respond(
                &id,
                json!({"modes": agent.modes(), "configOptions": agent.model_options()}),
            );
        }
        "session/set_mode" => {
            if let Some(mode) = params.get("modeId").and_then(Value::as_str) {
                *agent.mode.lock().unwrap() = mode.to_owned();
            }
            agent.respond(&id, json!({}));
        }
        "session/set_config_option" => {
            if params.get("configId").and_then(Value::as_str) == Some("model")
                && let Some(value) = params.get("value").and_then(Value::as_str)
            {
                *agent.model.lock().unwrap() = value.to_owned();
            }
            agent.respond(&id, json!({"configOptions": agent.model_options()}));
        }
        "session/set_model" => {
            if flag("GOAT_ACP_REJECT_SET_MODEL_META") && params.get("_meta").is_some() {
                agent.error(&id, -32602, "Unsupported reasoning effort");
                return;
            }
            if let Some(value) = params.get("modelId").and_then(Value::as_str) {
                *agent.model.lock().unwrap() = value.to_owned();
            }
            agent.respond(&id, json!({}));
        }
        "session/prompt" => prompt(agent, id, params),
        _ => agent.error(&id, -32601, &format!("Method not found: {method}")),
    }
}

const GROK_TASK: &str = "11111111-2222-3333-4444-555555555555";

fn text_chunk(agent: &Agent, session: &str, text: &str) {
    agent.update(
        session,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}),
    );
}

fn user_chunk(agent: &Agent, session: &str, text: &str) {
    agent.update(
        session,
        json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": text}}),
    );
}

/// A Grok subagent spawn that returns at once (v1 `isXAiAsyncSpawnAck`).
fn grok_spawn(agent: &Agent, session: &str) {
    agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "spawn-1", "title": "Task", "status": "pending",
        "rawInput": {"prompt": "Count the files", "description": "File counter"}}));
    agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "spawn-1", "status": "completed",
        "rawOutput": {"text": format!("Subagent started in background.\nsubagent_id: {GROK_TASK}")}}));
}

/// A background shell command (`BackgroundTaskStarted`, task `call-1-0`).
fn grok_background_command(agent: &Agent, session: &str) {
    agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "bg-1", "title": "Terminal", "kind": "execute",
        "status": "pending", "rawInput": {"command": "npm run build"}}));
    agent.update(
        session,
        json!({"sessionUpdate": "tool_call_update", "toolCallId": "bg-1", "status": "completed",
        "rawOutput": {"type": "BackgroundTaskStarted", "task_id": "call-1-0"}}),
    );
}

fn grok_task_completed(agent: &Agent, session: &str, task_id: &str, output: &str) {
    agent.notify(
        "x.ai/task_completed",
        json!({"sessionId": session, "update": {"sessionUpdate": "task_completed",
        "task_snapshot": {"task_id": task_id, "output": output, "exit_code": 0, "kind": "bash"}}}),
    );
}

fn grok_prompt_complete(agent: &Agent, session: &str, prompt_id: Option<&str>) {
    agent.notify(
        "_x.ai/session/prompt_complete",
        json!({"sessionId": session, "promptId": prompt_id, "stopReason": "end_turn"}),
    );
}

/// `GOAT_ACP_GROK_SCENARIO` (GOAT 2).
fn grok_scenario(agent: &Agent, session: &str, prompt_id: Option<&str>, scenario: &str) {
    match scenario {
        "subagent-hydrate" => {
            grok_spawn(agent, session);
            agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "poll-1",
                "title": "get_command_or_subagent_output", "status": "completed", "rawInput": {"task_ids": [GROK_TASK]},
                "rawOutput": {"Result": {"task_id": GROK_TASK, "status": "completed", "output": "42 files"}}}));
            text_chunk(agent, session, "counted");
            grok_prompt_complete(agent, session, prompt_id);
        }
        "subagent-finished" => {
            grok_spawn(agent, session);
            text_chunk(agent, session, "spawned");
            grok_prompt_complete(agent, session, prompt_id);
            text_chunk(agent, session, "after answer");
            agent.notify("_x.ai/session_notification", json!({"sessionId": session, "update": {
                "sessionUpdate": "subagent_finished", "child_session_id": GROK_TASK, "status": "completed", "output": "done counting"}}));
        }
        "subagent-notice" => {
            grok_spawn(agent, session);
            user_chunk(
                agent,
                session,
                &format!("Background subagent {GROK_TASK} (File counter) completed successfully"),
            );
            grok_prompt_complete(agent, session, prompt_id);
        }
        "background" => {
            grok_background_command(agent, session);
            text_chunk(agent, session, "build started");
            grok_prompt_complete(agent, session, prompt_id);
            text_chunk(agent, session, "after answer");
            grok_task_completed(agent, session, "call-1-0", "build ok");
        }
        "wake" => {
            grok_background_command(agent, session);
            grok_prompt_complete(agent, session, prompt_id);
            grok_task_completed(agent, session, "call-1-0", "build ok");
            agent.notify("session/update", json!({"sessionId": session, "_meta": {"promptId": "task-completed-call-1-0"},
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "wake report"}}}));
        }
        "monitor" | "monitor-persistent" => {
            let persistent = scenario == "monitor-persistent";
            agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "monitor-1", "title": "Tool", "status": "completed",
                "rawInput": {"variant": "Monitor", "description": "watch build", "persistent": persistent},
                "rawOutput": {"text": format!("Monitor started (task {GROK_TASK})")}}));
            user_chunk(
                agent,
                session,
                &format!("<monitor-event task_id=\"{GROK_TASK}\">build ok</monitor-event>"),
            );
            grok_prompt_complete(agent, session, prompt_id);
            text_chunk(agent, session, "after answer");
            if !persistent {
                grok_task_completed(agent, session, GROK_TASK, "monitor done");
            }
        }
        "kill" => {
            grok_background_command(agent, session);
            agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "kill-1", "title": "kill_command_or_subagent",
                "status": "completed", "rawInput": {"variant": "KillTask", "task_ids": ["call-1-0"]},
                "rawOutput": {"type": "KillTask", "Result": {"outcome": "killed"}}}));
            grok_prompt_complete(agent, session, prompt_id);
        }
        "hold" => {
            grok_background_command(agent, session);
            grok_prompt_complete(agent, session, prompt_id);
            text_chunk(agent, session, "waiting");
        }
        "plan-file" => {
            agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "write-plan", "title": "Write plan.md",
                "kind": "edit", "status": "completed",
                "rawInput": {"file_path": "/tmp/mock-home/.grok/sessions/s1/plan.md", "content": "# File plan\n\n- step one\n"}}));
            let reply = agent.request(
                "_x.ai/exit_plan_mode",
                json!({"sessionId": session, "toolCallId": "plan-2", "planContent": null}),
            );
            text_chunk(agent, session, &format!("xai plan: {reply}\n"));
            grok_prompt_complete(agent, session, prompt_id);
        }
        "tools" => {
            let command = format!("echo {}", "a".repeat(100));
            agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "long-1", "title": "Terminal", "kind": "execute",
                "status": "completed", "rawInput": {"command": command}, "rawOutput": {"exitCode": 0, "stdout": "a"}}));
            agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "mcp-1", "title": "use_tool", "status": "pending",
                "_meta": {"x.ai/tool": {"name": "use_tool"}}}));
            agent.update(
                session,
                json!({"sessionUpdate": "tool_call_update", "toolCallId": "mcp-1",
                "rawInput": {"tool_name": "goat__thread_read", "tool_input": {"id": "t1"}}}),
            );
            agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "mcp-1", "status": "completed",
                "rawOutput": {"type": "MCP", "output": {"OkayOutput": "read ok"}}}));
            grok_prompt_complete(agent, session, prompt_id);
        }
        other => text_chunk(agent, session, &format!("unknown grok scenario {other}")),
    }
}

fn prompt(agent: Arc<Agent>, id: Value, params: Value) {
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let prompt_id = params
        .get("_meta")
        .and_then(|m| m.get("promptId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if flag("GOAT_ACP_STEERS_WITH_PROMPT") {
        let previous = agent
            .running
            .lock()
            .unwrap()
            .insert(session.clone(), id.clone());
        if let Some(previous) = previous {
            // The steer ends the running prompt; the turn carries on under this one.
            if let Some(tx) = agent.cancelled.lock().unwrap().remove(&session) {
                drop(tx);
            }
            agent.respond(&previous, json!({"stopReason": "end_turn"}));
            let text = params["prompt"][0]["text"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("steered: {text}")}}));
            agent.running.lock().unwrap().remove(&session);
            agent.respond(&id, json!({"stopReason": "end_turn"}));
            return;
        }
    }
    let (cancel_tx, cancel_rx) = channel::<()>();
    agent
        .cancelled
        .lock()
        .unwrap()
        .insert(session.clone(), cancel_tx);
    let was_cancelled = |rx: &std::sync::mpsc::Receiver<()>| rx.try_recv().is_ok();

    if flag("GOAT_ACP_CRASH_PROMPT") {
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "about to crash"}}));
        std::thread::sleep(Duration::from_millis(50));
        std::process::exit(3);
    }
    if flag("GOAT_ACP_FAIL_PROMPT") {
        agent.error(&id, -32603, "Mock prompt failure");
        return;
    }
    if flag("GOAT_ACP_EMIT_NOTICE") {
        for notice in [
            json!({"sessionUpdate": "notice", "severity": "info", "title": 42}),
            json!({"sessionUpdate": "notice", "severity": "warning", "title": "Optional integration unavailable", "description": "Continuing without the integration."}),
            json!({"sessionUpdate": "notice", "severity": "info", "title": " \n\t "}),
        ] {
            agent.update(&session, notice);
        }
    }
    if flag("GOAT_ACP_EMIT_XAI_EXIT_PLAN_MODE") {
        let reply = agent.request("_x.ai/exit_plan_mode", json!({"sessionId": session, "toolCallId": "plan-1", "planContent": "# Plan\n\n1. Do it"}));
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("xai plan: {reply}\n")}}));
    }
    if flag("GOAT_ACP_EMIT_XAI_ASK_USER_QUESTION") {
        let reply = agent.request("_x.ai/ask_user_question", json!({"sessionId": session, "toolCallId": "ask-1", "questions": [{"question": "Which color?", "options": [{"label": "Red"}, {"label": "Blue"}]}]}));
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("xai question: {reply}\n")}}));
    }
    if let Some(scenario) = env("GOAT_ACP_GROK_SCENARIO") {
        grok_scenario(&agent, &session, prompt_id.as_deref(), &scenario);
        let _ = cancel_rx.recv();
        return;
    }
    if flag("GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG") {
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "hello from grok"}}));
        agent.notify("_x.ai/session/prompt_complete", json!({"sessionId": session, "promptId": prompt_id, "stopReason": env("GOAT_ACP_XAI_STOP_REASON").unwrap_or_else(|| "end_turn".into()), "agentResult": env("GOAT_ACP_XAI_AGENT_RESULT")}));
        let _ = cancel_rx.recv();
        return;
    }
    if flag("GOAT_ACP_HANG_PROMPT_FOREVER") {
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "partial before stall"}}));
        agent.update(&session, json!({"sessionUpdate": "tool_call", "toolCallId": "stalled-tool", "title": "sleep 40", "kind": "execute", "status": "in_progress", "rawInput": {"command": "sleep 40"}}));
        if flag("GOAT_ACP_STEERS_WITH_PROMPT") {
            // Wait for the steer (which answers this prompt) or a cancel.
            let _ = cancel_rx.recv();
            if agent.running.lock().unwrap().get(&session) == Some(&id) {
                agent.running.lock().unwrap().remove(&session);
                agent.respond(&id, json!({"stopReason": "cancelled"}));
            }
            return;
        }
        if cancel_rx.recv().is_ok() {
            agent.respond(&id, json!({"stopReason": "cancelled"}));
        }
        return;
    }
    if flag("GOAT_ACP_EMIT_TOOL_CALLS") {
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "before tool"}}));
        agent.update(&session, json!({"sessionUpdate": "tool_call", "toolCallId": "tool-call-1", "title": "Terminal", "kind": "execute", "status": "pending", "rawInput": {"command": ["echo", "hello"]}}));
        agent.update(&session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "tool-call-1", "status": "completed", "rawOutput": {"exitCode": 0, "stdout": "hello", "stderr": ""}}));
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "after tool"}}));
    }
    let mut cancelled = false;
    let count: usize = env("GOAT_ACP_PERMISSION_REQUEST_COUNT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut options =
        vec![json!({"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"})];
    if flag("GOAT_ACP_DEVIN_PLAN_BYPASS") {
        options.insert(
            0,
            json!({"optionId": "plan_bypass", "name": "Bypass plan", "kind": "allow_once"}),
        );
    }
    if !flag("GOAT_ACP_OMIT_ALLOW_ALWAYS") {
        options.push(
            json!({"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"}),
        );
    }
    options.push(json!({"optionId": "reject-once", "name": "Reject", "kind": "reject_once"}));
    for index in 0..count {
        let command = "cat server/package.json";
        let tool_call_id = if index == 0 {
            "tool-call-1".to_owned()
        } else {
            format!("tool-call-1-{}", index + 1)
        };
        let answer = agent.request("session/request_permission", json!({
            "sessionId": session,
            "toolCall": {
                "toolCallId": tool_call_id, "title": format!("`{command}`"), "kind": "execute", "status": "pending",
                "rawInput": {"variant": "Bash", "command": command, "description": "Read package metadata"},
                "content": [{"type": "content", "content": {"type": "text", "text": format!("Not in allowlist: {command}")}}]
            },
            "options": options
        }));
        let outcome = answer.get("outcome").cloned().unwrap_or(Value::Null);
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("permission: {outcome}\n")}}));
        if was_cancelled(&cancel_rx)
            || outcome.get("outcome").and_then(Value::as_str) == Some("cancelled")
        {
            cancelled = true;
            break;
        }
        if outcome.get("optionId").and_then(Value::as_str) == Some("reject-once") {
            break;
        }
        agent.update(&session, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "title": "Terminal", "kind": "execute", "status": "completed", "rawOutput": {"exitCode": 0, "stdout": "{ \"name\": \"t3\" }", "stderr": ""}}));
    }
    if flag("GOAT_ACP_EMIT_ELICITATION") && !cancelled {
        let schema: Value = env("GOAT_ACP_ELICITATION_SCHEMA")
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({"type": "object", "properties": {"choice": {"type": "string", "title": "Pick", "enum": ["alpha", "beta"]}}, "required": ["choice"]}));
        let answer = agent.request("elicitation/create", json!({"sessionId": session, "mode": "form", "message": "Which one?", "requestedSchema": schema}));
        if let Some(path) = env("GOAT_ACP_ELICITATION_RESPONSE_LOG_PATH") {
            let _ = std::fs::write(path, answer.to_string());
        }
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("elicitation: {answer}\n")}}));
    }
    if flag("GOAT_ACP_EMIT_URL_ELICITATION") && !cancelled {
        let answer = agent.request("elicitation/create", json!({"sessionId": session, "mode": "url", "elicitationId": "url-1", "message": "Sign in to continue", "url": "https://example.invalid/sign-in"}));
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("url elicitation: {answer}\n")}}));
    }
    agent.update(&session, json!({"sessionUpdate": "plan", "entries": [{"content": "Answer the user", "priority": "high", "status": "completed"}]}));
    let text = env("GOAT_ACP_PROMPT_RESPONSE_TEXT").unwrap_or_else(|| "hello from mock".into());
    agent.update(
        &session,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}),
    );
    agent.cancelled.lock().unwrap().remove(&session);
    let stop = if cancelled {
        "cancelled".to_owned()
    } else {
        env("GOAT_ACP_STOP_REASON").unwrap_or_else(|| "end_turn".into())
    };
    agent.respond(&id, json!({"stopReason": stop}));
}

fn main() {
    // `grok inspect --json` (GOAT 2): the skill catalog for the prompt rewrite.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["inspect", "--json"] {
        println!(
            "{}",
            env("GOAT_ACP_GROK_INSPECT_JSON").unwrap_or_else(|| "{\"skills\": []}".into())
        );
        return;
    }
    let agent = Arc::new(Agent {
        out: Mutex::new(std::io::stdout()),
        next_id: AtomicU64::new(0),
        waiting: Mutex::new(HashMap::new()),
        authenticated: AtomicBool::new(false),
        cancelled: Mutex::new(HashMap::new()),
        running: Mutex::new(HashMap::new()),
        model: Mutex::new("mock-default".into()),
        mode: Mutex::new("ask".into()),
    });
    if let Some(line) = env("GOAT_ACP_STDERR_LINE") {
        eprintln!("{line}");
    }
    if let Some(line) = env("GOAT_ACP_STDOUT_LINE") {
        let mut out = agent.out.lock().unwrap();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        log_inbound(&message);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let id = message.get("id").cloned();
        match (method, id) {
            (Some(method), Some(id)) => {
                let agent = Arc::clone(&agent);
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                std::thread::spawn(move || handle_request(agent, id, method, params));
            }
            (Some(method), None) if method == "session/cancel" => {
                if flag("GOAT_ACP_EXIT_ON_CANCEL") {
                    std::process::exit(0);
                }
                if flag("GOAT_ACP_IGNORE_CANCEL") {
                    continue;
                }
                let session = message["params"]["sessionId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                if let Some(tx) = agent.cancelled.lock().unwrap().get(&session) {
                    let _ = tx.send(());
                }
            }
            (None, Some(id)) => {
                if let Some(numeric) = id.as_u64()
                    && let Some(tx) = agent.waiting.lock().unwrap().remove(&numeric)
                {
                    let _ = tx.send(
                        message
                            .get("result")
                            .cloned()
                            .unwrap_or_else(|| json!({"error": message.get("error")})),
                    );
                }
            }
            _ => {}
        }
    }
}
