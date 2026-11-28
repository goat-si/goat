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
//! - `GOAT_ACP_MCP_ACP=1` (GOAT 2): advertise `mcpCapabilities.acp`; with `GOAT_ACP_EMIT_MCP_OVER_ACP=1` a prompt runs
//!   `mcp/connect`, `initialize`, `tools/list` and `mcp/disconnect` over ACP and prints `mcp tools: <names>`.
//!   `GOAT_ACP_MCP_CALL_RESULT_PATH=<file>` (GOAT 2) instead makes a `tools/call`, writes what came back to the
//!   file, then waits for `session/cancel`. `GOAT_ACP_MCP_DISCONNECT_TWICE=1` (GOAT 2) disconnects, lists tools
//!   again and disconnects again, printing `mcp disconnect: <a> | <tools> | <b>`.
//! - `GOAT_ACP_AUTH_METHOD_ID=<id>`: advertise an agent auth method; `session/new` answers -32000
//!   until `authenticate` with it.
//! - `GOAT_ACP_SYSTEM_PROMPT=1` (GOAT 2): advertise `sessionCapabilities.systemPrompt`.
//! - `GOAT_ACP_LOAD_SESSION=0` (GOAT 2): do not advertise `loadSession`; `GOAT_ACP_RESUME_SESSION=1`
//!   advertises `sessionCapabilities.resume`.
//! - `GOAT_ACP_SESSION_DELETE=1` (GOAT 2): advertise `sessionCapabilities.delete` and answer `session/delete`.
//! - `GOAT_ACP_EMIT_COMMANDS=1` (GOAT 2): send `available_commands_update` (`/review`) right after `session/new`.
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
//! - `GOAT_ACP_URL_ELICITATION_ON_NEW=1` (GOAT 2): `session/new` first sends a url-mode sign-in elicitation and
//!   records the answer in `GOAT_ACP_ELICITATION_RESPONSE_LOG_PATH`, then answers -32000.
//! - `GOAT_ACP_EMIT_NOTICE=1`: the v1 notice list (valid, malformed and blank).
//! - `GOAT_ACP_HANG_PROMPT_FOREVER=1`: `partial before stall`, then wait for `session/cancel`.
//! - `GOAT_ACP_EXIT_ON_CANCEL=1`: exit on `session/cancel` instead of answering.
//! - `GOAT_ACP_IGNORE_CANCEL=1` (GOAT 2): ignore `session/cancel` (a wedged prompt).
//! - `GOAT_ACP_FAIL_PROMPT=1`: answer `session/prompt` with an error.
//! - `GOAT_ACP_CRASH_PROMPT=1`: exit during the prompt. (GOAT 2) `GOAT_ACP_CRASH_STDERR=<text>` is printed on stderr
//!   first; with `GOAT_ACP_CRASH_STDERR_PARTIAL=1` (GOAT 2) without a newline.
//! - `GOAT_ACP_STDERR_HOLDER=1` (GOAT 2): start a child of the agent that keeps its stderr open and never exits
//!   (it ends with the process group), so the agent's exit does not close stderr.
//! - `GOAT_ACP_FLOOD_STDOUT_BYTE=<0-255>` (GOAT 2): flood with this byte instead of `x`.
//! - `GOAT_ACP_FLOOD_STDOUT=<bytes>` (GOAT 2): print this many `x` on stdout without a newline at start, then
//!   work normally.
//! - `GOAT_ACP_URL_ELICITATION_ONCE_PATH=<file>` (GOAT 2): with `GOAT_ACP_URL_ELICITATION_ON_NEW=1`, only a
//!   `session/new` while this file does not exist asks for the sign-in (and creates it); later ones succeed.
//! - `GOAT_ACP_FLOOD_STDERR=<bytes>` (GOAT 2): print this many `x` on stderr without a newline at start,
//!   then work normally.
//! - `GOAT_ACP_STOP_REASON=<reason>` (GOAT 2): stop reason of a finished prompt.
//! - `GOAT_ACP_EMIT_LOAD_REPLAY=1`: `session/load` replays history before answering.
//! - `GOAT_ACP_STEERS_WITH_PROMPT=1` (GOAT 2): a prompt sent while one runs ends the running one
//!   with `end_turn` and carries on (Antigravity 1.5 behaviour).
//! - `GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG=1`: send `_x.ai/session/prompt_complete` with
//!   the prompt's `_meta.promptId`, then never answer `session/prompt`. (GOAT 2) `GOAT_ACP_XAI_STOP_REASON`
//!   (default `end_turn`) and `GOAT_ACP_XAI_AGENT_RESULT` set its `stopReason` and `agentResult`.
//! - `GOAT_ACP_STDERR_LINE=<text>` (GOAT 2): print this line on stderr at start.
//! - `GOAT_ACP_STDOUT_LINE=<text>` (GOAT 2): print this non-JSON line on stdout at start.
//! - `GOAT_ACP_SCRIPT=<file>` (GOAT 2): JSON lines the agent plays at the start of every prompt,
//!   for agent-specific traffic recorded from v1's per-agent tests. `$SESSION` in a line is the
//!   prompt's session id. Each line is one step:
//!   `{"update": {..}, "sessionId"?: ".."}` a `session/update` (default: the prompt's session);
//!   `{"notify": "<method>", "params": {..}}` an extension notification;
//!   `{"request": "<method>", "params": {..}, "log"?: "<file>"}` a client request, its answer
//!   appended to `log` and echoed as `<method>: <answer>` in a message chunk;
//!   `{"appendFile": "<file>", "lines": [..]}` append JSON lines to a file (an agent's own log);
//!   `{"error": {"code", "message", "data"?}}` answer the prompt with this error and stop;
//!   `{"hang": true}` stop and answer only `session/cancel`.
//!
//! Provider probe scenarios (GOAT 2, for `src/probe*.rs`):
//! - `GOAT_ACP_EXIT_AT_START=<code>`: exit with this code before reading stdin (after the stderr line).
//! - `GOAT_ACP_ARGV_LOG_PATH=<file>`: write `{"argv": [...], "patch": <--patch file contents>}` at start.
//! - `GOAT_ACP_ENV_LOG_PATH=<file>` (GOAT 2): write the variables named in `GOAT_ACP_ENV_LOG_NAMES`
//!   (comma separated) as a JSON object at start, `null` for an unset one.
//! - `GOAT_ACP_INITIALIZE_META=<json>`: the `initialize` result's `_meta` (Grok `modelState`).
//! - `GOAT_ACP_AUTH_METHODS=<json>`: the raw `authMethods` (env-var and terminal methods); with
//!   `GOAT_ACP_AUTH_METHOD_ID` unset, `GOAT_ACP_AUTH_REQUIRED=1` makes `session/new` answer -32000.
//! - `GOAT_ACP_LOGOUT=1`: advertise `agentCapabilities.auth.logout`.
//! - `GOAT_ACP_SESSION_MODELS=<json>`: `models` of the `session/new` answer (ACP session models).
//! - `GOAT_ACP_NO_MODEL_OPTION=1`: no model select among the config options.
//! - `GOAT_ACP_MODEL_VALUES=<a,b,..>` (GOAT 2): the model select's values, the first current at
//!   start (default `mock-default,mock-fast`).
//! - `GOAT_ACP_SET_CONFIG_BARE=1` (GOAT 2): `session/set_config_option` applies the value and
//!   answers `{}` without the options, as a switch that landed without the client seeing it.
//! - `GOAT_ACP_THOUGHT_LEVEL=1`: a `thought_level` option whose levels depend on the current model.
//! - `GOAT_ACP_LATE_MODELS=1`: answer `session/new` without config options, then send them in a
//!   `config_option_update`.
//! - `GOAT_ACP_MOCK_CLI=1`: behave as a provider CLI for `--version` (`GOAT_ACP_MOCK_CLI_VERSION`,
//!   default `mock-cli 1.2.3`; exit `GOAT_ACP_MOCK_CLI_VERSION_EXIT`), `models`
//!   (`GOAT_ACP_MOCK_CLI_MODELS`; `GOAT_ACP_MOCK_CLI_MODELS_2` from the second call, counted in
//!   `GOAT_ACP_MOCK_CLI_LOG_PATH`) and `status --json` (`GOAT_ACP_MOCK_CLI_STATUS`); any other
//!   arguments run the ACP agent. `GOAT_ACP_MOCK_CLI_LOG_PATH` records one line per CLI call.
//! - Antigravity and fx profiles: see `mock_flavors/antigravity_fx.rs`.
//! - `GOAT_ACP_GROK_SCENARIO=<name>` (GOAT 2): xAI Grok flows that end with
//!   `_x.ai/session/prompt_complete` and leave `session/prompt` open, as Grok does (frame shapes from
//!   v1 `xaiAcpExtension.test.ts`): `subagent-hydrate`, `subagent-finished`, `subagent-notice`,
//!   `background`, `wake`, `monitor`, `monitor-persistent`, `hold`, `plan-file`, `tools`.
//! - `GOAT_ACP_GROK_KILL_TASK_SHAPE=<shape>`: v1 `emitGrokKillTaskScenario` (`acpMockGrokScenarios.ts`),
//!   shapes `killed`, `already_exited`, `known_failure`, `output_only`, `variant_only`.
//! - `GOAT_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL=1`: v1's structured Monitor, prompt completion, then a
//!   `TaskOutput` poll that ends it (v1 waits 120 ms before the poll; GOAT 2 sends it at once).
//! - `GOAT_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED=1` / `GOAT_ACP_GROK_BACKGROUND_TASK_COMPLETION=poll`:
//!   v1's `BackgroundTaskStarted` command, optionally polled to completion and finished by a
//!   `turn_completed` on `_x.ai/session/update`.
//! - `GOAT_ACP_GROK_MODELS=1` (GOAT 2 switch for v1's `grokAcpModels`): session setup reports v1's Grok
//!   models (`GOAT_ACP_GROK_MODEL`, default `grok-4.6`, efforts xhigh/high/low; `grok-mock-alt`);
//!   `GOAT_ACP_REJECT_SET_MODEL_META=1` (GOAT 2) answers a `session/set_model` with `_meta` with an
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

#[path = "mock_flavors/antigravity_fx.rs"]
mod antigravity_fx;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// `GOAT_ACP_MODEL_VALUES` (GOAT 2), never empty.
fn model_values() -> Vec<String> {
    let values: Vec<String> = env("GOAT_ACP_MODEL_VALUES")
        .unwrap_or_else(|| "mock-default,mock-fast".into())
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .collect();
    if values.is_empty() {
        vec!["mock-default".into()]
    } else {
        values
    }
}

fn flag(name: &str) -> bool {
    env(name).as_deref() == Some("1")
}

/// `GOAT_ACP_URL_ELICITATION_ONCE_PATH`: the first `session/new` asks for the sign-in, later ones do not.
fn sign_in_pending() -> bool {
    match env("GOAT_ACP_URL_ELICITATION_ONCE_PATH") {
        None => true,
        Some(path) if std::path::Path::new(&path).exists() => false,
        Some(path) => std::fs::write(path, "asked").is_ok(),
    }
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
        let model = self.model.lock().unwrap().clone();
        let mut options = Vec::new();
        if !flag("GOAT_ACP_NO_MODEL_OPTION") {
            let values: Vec<Value> = model_values()
                .iter()
                .map(|value| match value.as_str() {
                    "mock-default" => json!({"value": value, "name": "Mock Default"}),
                    "mock-fast" => json!({"value": value, "name": "Mock Fast"}),
                    _ => json!({"value": value, "name": value}),
                })
                .collect();
            options.push(json!({
                "id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": model,
                "options": values
            }));
        }
        if flag("GOAT_ACP_THOUGHT_LEVEL") {
            let levels: &[&str] = if model == "mock-fast" {
                &["minimal"]
            } else {
                &["low", "high"]
            };
            options.push(json!({
                "id": "effort", "name": "Effort", "category": "thought_level", "type": "select",
                "currentValue": levels[0],
                "options": levels.iter().map(|l| json!({"value": l, "name": l.to_uppercase()})).collect::<Vec<_>>()
            }));
        }
        Value::Array(options)
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
    if antigravity_fx::handle_request(&agent, &id, &method, &params) {
        return;
    }
    match method.as_str() {
        "initialize" => {
            let mut caps = json!({
                "loadSession": env("GOAT_ACP_LOAD_SESSION").as_deref() != Some("0"),
                "promptCapabilities": {"image": true, "embeddedContext": true},
                "mcpCapabilities": {"http": flag("GOAT_ACP_MCP_HTTP"), "acp": flag("GOAT_ACP_MCP_ACP")},
                "sessionCapabilities": {}
            });
            if flag("GOAT_ACP_SYSTEM_PROMPT") {
                caps["sessionCapabilities"]["systemPrompt"] = json!({});
            }
            if flag("GOAT_ACP_RESUME_SESSION") {
                caps["sessionCapabilities"]["resume"] = json!({});
            }
            if flag("GOAT_ACP_SESSION_DELETE") {
                caps["sessionCapabilities"]["delete"] = json!({});
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
            if let Some(methods) = env("GOAT_ACP_AUTH_METHODS")
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            {
                result["authMethods"] = methods;
            }
            if let Some(meta) = env("GOAT_ACP_INITIALIZE_META")
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            {
                result["_meta"] = meta;
            }
            if flag("GOAT_ACP_LOGOUT") {
                result["agentCapabilities"]["auth"] = json!({"logout": {}});
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
        "session/new" if flag("GOAT_ACP_URL_ELICITATION_ON_NEW") && sign_in_pending() => {
            let agent2 = Arc::clone(&agent);
            std::thread::spawn(move || {
                let answer = agent2.request("elicitation/create", json!({"mode": "url", "elicitationId": "login-1", "message": "Sign in", "url": "https://example.invalid/login"}));
                if let Some(path) = env("GOAT_ACP_ELICITATION_RESPONSE_LOG_PATH") {
                    let _ = std::fs::write(path, answer.to_string());
                }
                agent2.error(&id, -32000, "Authentication required");
            });
        }
        "session/new" => {
            if (env("GOAT_ACP_AUTH_METHOD_ID").is_some() || flag("GOAT_ACP_AUTH_REQUIRED"))
                && !agent.authenticated.load(Ordering::SeqCst)
            {
                agent.error(&id, -32000, "Authentication required");
                return;
            }
            let mut result = json!({
                "sessionId": "mock-session-1",
                "modes": agent.modes(),
                "configOptions": if flag("GOAT_ACP_LATE_MODELS") { json!([]) } else { agent.model_options() }
            });
            if let Some(models) = env("GOAT_ACP_SESSION_MODELS")
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            {
                result["models"] = models;
            }
            if flag("GOAT_ACP_GROK_MODELS") {
                // v1 acp-mock-agent.ts:431-461 (grokAcpModels / modelState).
                let model = env("GOAT_ACP_GROK_MODEL").unwrap_or_else(|| "grok-4.6".into());
                let context: u64 = env("GOAT_ACP_GROK_CONTEXT_TOKENS")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(500_000);
                let effort =
                    env("GOAT_ACP_INITIAL_GROK_REASONING_EFFORT").unwrap_or_else(|| "high".into());
                // v1 modelState (acp-mock-agent.ts:451-461) keeps a chosen Grok model current
                // (round 7 part 8b.3).
                let chosen = agent.model.lock().unwrap().clone();
                let current = if chosen == model || chosen == "grok-mock-alt" {
                    chosen
                } else {
                    model.clone()
                };
                result["models"] = json!({"currentModelId": current, "availableModels": [
                    {"modelId": model, "name": "Grok 4.6", "_meta": {
                        "totalContextTokens": context, "contextWindows": [256000, 500000],
                        "supportsReasoningEffort": true, "reasoningEffort": effort,
                        "reasoningEfforts": [
                            {"id": "xhigh", "value": "xhigh", "label": "Extra High Effort", "default": false},
                            {"id": "high", "value": "high", "label": "High Effort", "default": true},
                            {"id": "low", "value": "low", "label": "Low Effort", "default": false}
                        ]}},
                    {"modelId": "grok-mock-alt", "name": "Grok Mock Alt"}
                ]});
            }
            agent.respond(&id, result);
            if flag("GOAT_ACP_LATE_MODELS") {
                agent.update("mock-session-1", json!({"sessionUpdate": "config_option_update", "configOptions": agent.model_options()}));
            }
            if flag("GOAT_ACP_EMIT_COMMANDS") {
                agent.update("mock-session-1", json!({"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "review", "description": "Review the diff"}]}));
            }
        }
        "session/delete" if flag("GOAT_ACP_SESSION_DELETE") => agent.respond(&id, json!({})),
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
            if flag("GOAT_ACP_SET_CONFIG_BARE") {
                agent.respond(&id, json!({}));
            } else {
                agent.respond(&id, json!({"configOptions": agent.model_options()}));
            }
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

/// v1 `emitGrokKillTaskScenario` (acpMockGrokScenarios.ts:6-69).
fn grok_kill_task_scenario(agent: &Agent, session: &str, prompt_id: Option<&str>, shape: &str) {
    let task_id = "call-fb9d0000-0000-0000-0000-000000000026-29";
    let outcome = if shape == "already_exited" || shape == "known_failure" {
        "already_exited"
    } else {
        "killed"
    };
    agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "kill-target-command",
        "title": "run_terminal_command", "kind": "execute", "status": "in_progress", "rawInput": {"command": "sleep 40"}}));
    agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "kill-target-command", "status": "completed",
        "rawOutput": {"type": "BackgroundTaskStarted", "task_id": task_id, "task_type": "bash", "command": "sleep 40"}}));
    if shape == "known_failure" {
        agent.notify("_x.ai/task_completed", json!({"sessionId": session, "update": {"sessionUpdate": "task_completed",
            "task_snapshot": {"task_id": task_id, "kind": "bash", "exit_code": 7, "output": "known failure\n"}}}));
    }
    let mut raw_input = json!({"task_id": task_id});
    if shape != "output_only" {
        raw_input["variant"] = json!("KillTask");
    }
    let mut update = json!({"sessionUpdate": "tool_call_update", "toolCallId": "kill-command",
        "title": format!("kill {task_id} ({outcome})"), "kind": "other", "status": "completed", "rawInput": raw_input});
    if shape != "variant_only" {
        update["rawOutput"] = json!({"type": "KillTask", "outcome": outcome});
    }
    agent.update(session, update);
    agent.notify(
        "_x.ai/session/prompt_complete",
        json!({"sessionId": session, "promptId": prompt_id,
        "stopReason": "end_turn", "agentResult": null}),
    );
}

/// v1 `emitGrokMonitorPostTurnPoll` (acp-mock-agent.ts:1836-1898).
fn grok_monitor_post_turn_poll(agent: &Agent, session: &str, prompt_id: Option<&str>) {
    let task_id = "01a05f41-5107-7550-821e-79e8d1cd7687";
    let description = "Watch count-sheet Typst unit until done";
    agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "call-monitor-1", "title": "monitor",
        "kind": "other", "status": "pending", "rawInput": {"description": description},
        "_meta": {"x.ai/tool": {"version": 1, "name": "monitor", "kind": "task", "namespace": "grok_build"}}}));
    agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "call-monitor-1", "status": "completed",
        "rawInput": {"description": description}, "rawOutput": {"type": "Monitor", "taskId": task_id, "timeoutMs": 36_000_000}}));
    agent.notify("_x.ai/session/prompt_complete", json!({"sessionId": session,
        "promptId": prompt_id.unwrap_or("mock-xai-prompt-1"), "stopReason": "end_turn", "agentResult": null}));
    agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "call-monitor-poll-1",
        "title": "get_command_or_subagent_output", "kind": "other", "status": "completed",
        "rawInput": {"variant": "TaskOutput", "task_ids": [task_id], "timeout_ms": 0},
        "rawOutput": {"type": "TaskOutput", "Result": {"task_id": task_id, "command": format!("[monitor] {description}"),
            "status": "completed", "exit_code": 0, "output": "Monitor finished."}}}));
}

/// v1 `emitGrokBackgroundTaskStarted` / `emitGrokBackgroundTaskPoll` (acp-mock-agent.ts:1900-1980).
fn grok_background_task_started(agent: &Agent, session: &str, prompt_id: Option<&str>, poll: bool) {
    let tool_call_id = if poll {
        "call-fb9d0000-0000-0000-0000-000000000026-29"
    } else {
        "call-fb9d0000-0000-0000-0000-000000000026"
    };
    let command = "sleep 40; echo done-a";
    agent.update(session, json!({"sessionUpdate": if poll { "tool_call_update" } else { "tool_call" },
        "toolCallId": tool_call_id, "title": "run_terminal_command", "kind": "execute", "status": "in_progress",
        "rawInput": {"command": command}}));
    agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": tool_call_id, "status": "completed",
        "rawOutput": {"type": "BackgroundTaskStarted", "task_id": tool_call_id, "task_type": "bash", "status": "running", "command": command}}));
    if poll {
        agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "call-background-poll",
            "title": "get_command_or_subagent_output", "kind": "other", "status": "completed",
            "rawOutput": {"type": "TaskOutput", "Result": {"task_id": tool_call_id, "command": command,
                "status": "completed", "exit_code": 0, "output": "done-a"}}}));
        text_chunk(agent, session, "The background command finished.");
        // Neither the prompt RPC nor the process ends, matching the Grok incident.
        agent.notify(
            "_x.ai/session/update",
            json!({"sessionId": session, "update": {"sessionUpdate": "turn_completed",
            "prompt_id": prompt_id, "stop_reason": "end_turn"}}),
        );
        return;
    }
    agent.notify("_x.ai/session/prompt_complete", json!({"sessionId": session,
        "promptId": prompt_id.unwrap_or("mock-xai-prompt-1"), "stopReason": "end_turn", "agentResult": null}));
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

    if antigravity_fx::prompt(&agent, &session) {
        // Left open on purpose (a wedged harness); cancel still answers it.
        if cancel_rx.recv().is_ok() {
            agent.respond(&id, json!({"stopReason": "cancelled"}));
        }
        return;
    }
    if flag("GOAT_ACP_CRASH_PROMPT") {
        if let Some(text) = env("GOAT_ACP_CRASH_STDERR") {
            if flag("GOAT_ACP_CRASH_STDERR_PARTIAL") {
                eprint!("{text}");
                let _ = std::io::stderr().flush();
            } else {
                eprintln!("{text}");
            }
        }
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "about to crash"}}));
        std::thread::sleep(Duration::from_millis(50));
        std::process::exit(3);
    }
    if flag("GOAT_ACP_FAIL_PROMPT") {
        agent.error(&id, -32603, "Mock prompt failure");
        return;
    }
    if let Some(path) = env("GOAT_ACP_SCRIPT")
        && !play_script(&agent, &id, &session, &path, &cancel_rx)
    {
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
    if let (true, Some(path)) = (
        flag("GOAT_ACP_EMIT_MCP_OVER_ACP"),
        env("GOAT_ACP_MCP_CALL_RESULT_PATH"),
    ) {
        let connected = agent.request("mcp/connect", json!({"serverId": "goat"}));
        let connection = connected["connectionId"].clone();
        let _ = agent.request("mcp/message", json!({"connectionId": connection, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "mock", "version": "0"}}}));
        let called = agent.request("mcp/message", json!({"connectionId": connection, "method": "tools/call", "params": {"name": "goat_call", "arguments": {}}}));
        let _ = std::fs::write(path, called.to_string());
        let _ = cancel_rx.recv();
        agent.running.lock().unwrap().remove(&session);
        agent.respond(&id, json!({"stopReason": "cancelled"}));
        return;
    }
    if flag("GOAT_ACP_EMIT_MCP_OVER_ACP") {
        let connected = agent.request("mcp/connect", json!({"serverId": "goat"}));
        let connection = connected["connectionId"].clone();
        let init = agent.request("mcp/message", json!({"connectionId": connection, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "mock", "version": "0"}}}));
        let _ = init;
        let listed = agent.request(
            "mcp/message",
            json!({"connectionId": connection, "method": "tools/list"}),
        );
        let names: Vec<String> = listed["tools"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|t| t["name"].as_str().map(str::to_owned))
            .collect();
        if flag("GOAT_ACP_MCP_DISCONNECT_TWICE") {
            let first = agent.request("mcp/disconnect", json!({"connectionId": connection}));
            let again = agent.request(
                "mcp/message",
                json!({"connectionId": connection, "method": "tools/list"}),
            );
            let second = agent.request("mcp/disconnect", json!({"connectionId": connection}));
            let tools = again["tools"].as_array().map(|t| t.len()).unwrap_or(0);
            agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("mcp disconnect: {first} | {tools} | {second}\n")}}));
        } else {
            let _ = agent.request("mcp/disconnect", json!({"connectionId": connection}));
        }
        agent.update(&session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("mcp tools: {}\n", names.join(","))}}));
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
    if let Some(shape) = env("GOAT_ACP_GROK_KILL_TASK_SHAPE") {
        grok_kill_task_scenario(&agent, &session, prompt_id.as_deref(), &shape);
        let _ = cancel_rx.recv();
        return;
    }
    if flag("GOAT_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL") {
        grok_monitor_post_turn_poll(&agent, &session, prompt_id.as_deref());
        let _ = cancel_rx.recv();
        return;
    }
    let background_poll =
        env("GOAT_ACP_GROK_BACKGROUND_TASK_COMPLETION").as_deref() == Some("poll");
    if flag("GOAT_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED") || background_poll {
        grok_background_task_started(&agent, &session, prompt_id.as_deref(), background_poll);
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

/// Play `GOAT_ACP_SCRIPT`. Returns false when a step answered the prompt.
fn play_script(
    agent: &Arc<Agent>,
    id: &Value,
    session: &str,
    path: &str,
    cancel_rx: &std::sync::mpsc::Receiver<()>,
) -> bool {
    let script = std::fs::read_to_string(path).unwrap_or_default();
    for line in script.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(step) = serde_json::from_str::<Value>(&line.replace("$SESSION", session)) else {
            continue;
        };
        if let Some(update) = step.get("update") {
            let target = step
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or(session);
            agent.update(target, update.clone());
        } else if let Some(method) = step.get("notify").and_then(Value::as_str) {
            agent.notify(method, step.get("params").cloned().unwrap_or(Value::Null));
        } else if let Some(method) = step.get("request").and_then(Value::as_str) {
            let answer = agent.request(method, step.get("params").cloned().unwrap_or(Value::Null));
            if let Some(log) = step.get("log").and_then(Value::as_str)
                && let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log)
            {
                let _ = writeln!(file, "{answer}");
            }
            agent.update(session, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("{method}: {answer}\n")}}));
        } else if let Some(file) = step.get("appendFile").and_then(Value::as_str) {
            if let Ok(mut out) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(file)
            {
                for entry in step
                    .get("lines")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let _ = writeln!(out, "{entry}");
                }
            }
        } else if let Some(error) = step.get("error") {
            agent.cancelled.lock().unwrap().remove(session);
            agent.write(json!({"jsonrpc": "2.0", "id": id, "error": error}));
            return false;
        } else if step.get("hang") == Some(&Value::Bool(true)) {
            if cancel_rx.recv().is_ok() {
                agent.respond(id, json!({"stopReason": "cancelled"}));
            }
            return false;
        }
    }
    true
}

fn main() {
    // The stderr holder (`GOAT_ACP_STDERR_HOLDER`): keeps the inherited stderr open until killed.
    if flag("GOAT_ACP_PARK") {
        loop {
            std::thread::park();
        }
    }
    if flag("GOAT_ACP_MOCK_CLI") && mock_cli() {
        return;
    }
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
        model: Mutex::new(model_values().remove(0)),
        mode: Mutex::new("ask".into()),
    });
    if let Some(line) = env("GOAT_ACP_STDERR_LINE") {
        eprintln!("{line}");
    }
    if flag("GOAT_ACP_STDERR_HOLDER")
        && let Ok(exe) = std::env::current_exe()
    {
        let _ = std::process::Command::new(exe)
            .env("GOAT_ACP_PARK", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn();
    }
    if let Some(bytes) = env("GOAT_ACP_FLOOD_STDERR").and_then(|v| v.parse::<usize>().ok()) {
        let mut err = std::io::stderr().lock();
        let block = vec![b'x'; 64 * 1024];
        let mut left = bytes;
        while left > 0 {
            let n = left.min(block.len());
            let _ = err.write_all(&block[..n]);
            left -= n;
        }
        let _ = err.flush();
    }
    if let Some(path) = env("GOAT_ACP_ENV_LOG_PATH") {
        let names = env("GOAT_ACP_ENV_LOG_NAMES").unwrap_or_default();
        let seen: serde_json::Map<String, Value> = names
            .split(',')
            .filter(|n| !n.is_empty())
            .map(|n| {
                (
                    n.to_owned(),
                    std::env::var(n).map_or(Value::Null, Value::from),
                )
            })
            .collect();
        let _ = std::fs::write(path, Value::Object(seen).to_string());
    }
    if let Some(path) = env("GOAT_ACP_ARGV_LOG_PATH") {
        let argv: Vec<String> = std::env::args().skip(1).collect();
        let patch = argv
            .iter()
            .position(|a| a == "--patch")
            .and_then(|i| argv.get(i + 1))
            .and_then(|p| std::fs::read_to_string(p).ok());
        let _ = std::fs::write(path, json!({"argv": argv, "patch": patch}).to_string());
    }
    if let Some(code) = env("GOAT_ACP_EXIT_AT_START") {
        let _ = std::io::stderr().flush();
        std::process::exit(code.parse().unwrap_or(1));
    }
    if let Some(bytes) = env("GOAT_ACP_FLOOD_STDOUT").and_then(|v| v.parse::<usize>().ok()) {
        let mut out = agent.out.lock().unwrap();
        let byte = env("GOAT_ACP_FLOOD_STDOUT_BYTE")
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(b'x');
        let block = vec![byte; 64 * 1024];
        let mut left = bytes;
        while left > 0 {
            let n = left.min(block.len());
            if out.write_all(&block[..n]).is_err() {
                break;
            }
            left -= n;
        }
        let _ = out.flush();
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

/// Provider CLI behaviour (`GOAT_ACP_MOCK_CLI=1`). True when the arguments were a CLI call.
fn mock_cli() -> bool {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let log = env("GOAT_ACP_MOCK_CLI_LOG_PATH");
    let previous_calls = |name: &str| {
        log.as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .map(|text| text.lines().filter(|line| line.starts_with(name)).count())
            .unwrap_or(0)
    };
    let record = |line: &str| {
        if let Some(path) = &log
            && let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    };
    match args.first().map(String::as_str) {
        Some("--version") => {
            record("--version");
            println!(
                "{}",
                env("GOAT_ACP_MOCK_CLI_VERSION").unwrap_or_else(|| "mock-cli 1.2.3".into())
            );
            let code = env("GOAT_ACP_MOCK_CLI_VERSION_EXIT")
                .and_then(|c| c.parse().ok())
                .unwrap_or(0);
            std::process::exit(code);
        }
        Some("models") => {
            let output = if previous_calls("models") >= 1 {
                env("GOAT_ACP_MOCK_CLI_MODELS_2").or_else(|| env("GOAT_ACP_MOCK_CLI_MODELS"))
            } else {
                env("GOAT_ACP_MOCK_CLI_MODELS")
            };
            record(&format!("models {}", args[1..].join(" ")));
            println!("{}", output.unwrap_or_default());
            true
        }
        Some("status") => {
            record("status");
            println!("{}", env("GOAT_ACP_MOCK_CLI_STATUS").unwrap_or_default());
            true
        }
        _ => {
            record(&format!("acp {}", args.join(" ")));
            false
        }
    }
}
