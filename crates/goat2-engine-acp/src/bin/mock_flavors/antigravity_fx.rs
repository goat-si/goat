//! Antigravity and fx profiles of the fake ACP agent.
//!
//! Antigravity from v1 `apps/server/scripts/acp-mock-agent.ts` (`GOAT_ACP_ANTIGRAVITY`, :45,
//! :158-224, :392-401, :537-557, :628-652, :820-844), `acpMockAntigravityThoughtLevel.ts` and
//! `acpMockHarnessFailure.ts` at 916b5ccc1b2; fx (GOAT 2) from what `provider-fx/src/server/acpSupport.ts`
//! says fx 0.0.13 does: `ask`/`code` modes reported as `ask`, `model` and `effort` options.
//!
//! - `GOAT_ACP_ANTIGRAVITY=1`: the Antigravity profile: its four auth methods (`authenticate` takes
//!   `oauth-personal`, or `gemini-api-key` with `GEMINI_API_KEY` set), models
//!   `gemini-test-low`/`gemini-test-high`, a `mode` option `default`/`auto_edit`/`yolo`
//!   (`GOAT_ACP_INITIAL_MODE`), `agentInfo.version` from `GOAT_ACP_AGENT_VERSION` (default 1.5.1).
//! - `GOAT_ACP_ANTIGRAVITY_THOUGHT_LEVEL=1`: a `thought_level` option the model write resets.
//! - `GOAT_ACP_ANTIGRAVITY_APPEND=1` (GOAT 2): advertise `_meta.antigravity.systemPrompt.append`.
//! - `GOAT_ACP_ANTIGRAVITY_AUTH_ERROR=no-browser` (GOAT 2): `authenticate` fails as the 1.5 CLI
//!   does without a display.
//! - `GOAT_ACP_ANTIGRAVITY_HARNESS_FAILURE=pending`: print the harness failure on stderr during
//!   the prompt and never answer it.
//! - `GOAT_ACP_ANTIGRAVITY_INTERACTION=1` (GOAT 2): ask an `interaction_` permission question,
//!   the reply printed as `interaction: <json>`.
//! - `GOAT_ACP_ANTIGRAVITY_GOAT_MCP=1` (GOAT 2): ask permission for `Run mcp_goat_goat_thread_read?`,
//!   the reply printed as `goat mcp: <json>`.
//! - `GOAT_ACP_ANTIGRAVITY_SECURITY_WARNING=1` (GOAT 2): ask permission for a shell command whose
//!   `allow_always` carries `agy.security.warning`, the reply printed as `shell: <json>`.
//! - `GOAT_ACP_ANTIGRAVITY_UPDATE_STEPS=1` (GOAT 2): report a checklist as `update_steps` calls.
//! - `GOAT_ACP_ANTIGRAVITY_CLIENT_READ=<path>` (GOAT 2): a `client_view_file` call, an
//!   `fs/read_text_file` request for the path (reply printed as `read: <json>`), then the call
//!   failed with an unrelated step error.
//! - `GOAT_ACP_ANTIGRAVITY_COMMAND=1` (GOAT 2): a `run_command` call naming `CommandLine`.
//! - `GOAT_ACP_FX=1` (GOAT 2): the fx profile; `GOAT_ACP_FX_MODES` lists the modes (default
//!   `ask,code`), the session reports `ask`.
//! - `GOAT_ACP_FX_SUBAGENT=1` (GOAT 2): a `subagent` call whose clipped reply says it failed.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

use super::{Agent, env, flag};

struct Profile {
    model: String,
    mode: String,
    thought: String,
    effort: String,
}

static STATE: Mutex<Option<Profile>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut Profile) -> T) -> T {
    let mut state = STATE.lock().unwrap();
    let profile = state.get_or_insert_with(|| Profile {
        model: if antigravity() {
            "gemini-test-low".into()
        } else {
            "fx-default".into()
        },
        mode: if antigravity() {
            env("GOAT_ACP_INITIAL_MODE").unwrap_or_else(|| "default".into())
        } else {
            "ask".into()
        },
        thought: "high".into(),
        effort: "high".into(),
    });
    f(profile)
}

fn antigravity() -> bool {
    flag("GOAT_ACP_ANTIGRAVITY")
}

fn fx() -> bool {
    flag("GOAT_ACP_FX")
}

fn antigravity_config_options() -> Value {
    with_state(|s| {
        let mut options = vec![
            json!({"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": s.model,
                   "options": [{"value": "gemini-test-low", "name": "Gemini Test Low"}, {"value": "gemini-test-high", "name": "Gemini Test High"}]}),
            json!({"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": s.mode,
                   "options": [{"value": "default", "name": "Default"}, {"value": "auto_edit", "name": "Auto edit"}, {"value": "yolo", "name": "YOLO"}]}),
        ];
        if flag("GOAT_ACP_ANTIGRAVITY_THOUGHT_LEVEL") {
            let mut levels = vec![
                json!({"value": "low", "name": "Low"}),
                json!({"value": "medium", "name": "Medium"}),
                json!({"value": "high", "name": "High"}),
            ];
            if s.model != "gemini-test-high" {
                levels.push(json!({"value": "xhigh", "name": "Extra"}));
            }
            options.push(json!({"id": "thought_level", "name": "Thinking Level", "category": "thought_level", "type": "select", "currentValue": s.thought, "options": levels}));
        }
        Value::Array(options)
    })
}

fn fx_modes() -> Value {
    let ids = env("GOAT_ACP_FX_MODES").unwrap_or_else(|| "ask,code".into());
    with_state(
        |s| json!({"currentModeId": s.mode, "availableModes": ids.split(',').map(|id| json!({"id": id, "name": id})).collect::<Vec<_>>()}),
    )
}

fn fx_config_options() -> Value {
    let efforts: Vec<Value> = ["auto", "low", "medium", "high", "xhigh", "max"]
        .iter()
        .map(|v| json!({"value": v, "name": v}))
        .collect();
    with_state(|s| {
        json!([
            {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": s.model,
             "options": [{"value": "fx-default", "name": "fx default"}, {"value": "fx-fast", "name": "fx fast"}]},
            {"id": "effort", "name": "Effort", "category": "thought_level", "type": "select", "currentValue": s.effort,
             "options": efforts}
        ])
    })
}

/// A request of the active profile; false leaves it to the shared agent.
pub fn handle_request(agent: &Arc<Agent>, id: &Value, method: &str, params: &Value) -> bool {
    if antigravity() {
        match method {
            "initialize" => {
                let mut caps = json!({
                    "loadSession": true,
                    "promptCapabilities": {"image": true, "audio": true, "embeddedContext": true},
                    "mcpCapabilities": {"http": true, "sse": true},
                    "sessionCapabilities": {"resume": {}}
                });
                if flag("GOAT_ACP_ANTIGRAVITY_APPEND") {
                    caps["_meta"] = json!({"antigravity": {"systemPrompt": {"append": true}}});
                }
                agent.respond(id, json!({
                    "protocolVersion": 1,
                    "agentCapabilities": caps,
                    "authMethods": [
                        {"id": "oauth-personal", "name": "Log in with Google"},
                        {"id": "oauth-business", "name": "Log in with Gemini Enterprise"},
                        {"id": "gemini-api-key", "name": "Gemini API key"},
                        {"id": "agent-platform", "name": "Gemini Enterprise Agent Platform"}
                    ],
                    "agentInfo": {"name": "antigravity-acp", "title": "Google Antigravity", "version": env("GOAT_ACP_AGENT_VERSION").unwrap_or_else(|| "1.5.1".into())}
                }));
            }
            "authenticate" => {
                let method_id = params
                    .get("methodId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if env("GOAT_ACP_ANTIGRAVITY_AUTH_ERROR").as_deref() == Some("no-browser") {
                    agent.error(
                        id,
                        -32603,
                        "No browser is available here. Run agy acp --login in a terminal.",
                    );
                } else if method_id != "oauth-personal"
                    && !(method_id == "gemini-api-key" && env("GEMINI_API_KEY").is_some())
                {
                    agent.error(
                        id,
                        -32602,
                        &format!("Mock Antigravity rejected auth method {method_id}."),
                    );
                } else {
                    agent.respond(id, json!({}));
                }
            }
            "session/new" => {
                agent.respond(id, json!({"sessionId": "mock-session-1", "configOptions": antigravity_config_options()}));
            }
            "session/resume" | "session/load" => {
                let modes = with_state(|s| {
                    json!({"currentModeId": s.mode, "availableModes": [
                    {"id": "default", "name": "Default"}, {"id": "auto_edit", "name": "Auto edit"}, {"id": "yolo", "name": "YOLO"}]})
                });
                agent.respond(
                    id,
                    json!({"modes": modes, "configOptions": antigravity_config_options()}),
                );
            }
            "session/set_config_option" => {
                let value = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                with_state(|s| match params.get("configId").and_then(Value::as_str) {
                    Some("mode") => s.mode = value,
                    Some("model") => {
                        if flag("GOAT_ACP_ANTIGRAVITY_THOUGHT_LEVEL") {
                            s.thought = if value == "gemini-test-high" {
                                "medium"
                            } else {
                                "high"
                            }
                            .into();
                        }
                        s.model = value;
                    }
                    Some("thought_level") => s.thought = value,
                    _ => {}
                });
                agent.respond(id, json!({"configOptions": antigravity_config_options()}));
            }
            "session/set_mode" => {
                let mode = params
                    .get("modeId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                with_state(|s| s.mode = mode);
                agent.respond(id, json!({}));
            }
            _ => return false,
        }
        return true;
    }
    if fx() {
        match method {
            "session/new" | "session/load" => {
                agent.respond(id, json!({"sessionId": params.get("sessionId").cloned().unwrap_or(json!("mock-session-1")), "modes": fx_modes(), "configOptions": fx_config_options()}));
            }
            "session/set_config_option" => {
                let value = params
                    .get("value")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                with_state(|s| match params.get("configId").and_then(Value::as_str) {
                    Some("mode") => s.mode = value,
                    Some("model") => s.model = value,
                    Some("effort") => s.effort = value,
                    _ => {}
                });
                agent.respond(id, json!({"configOptions": fx_config_options()}));
            }
            "session/set_mode" => {
                let mode = params
                    .get("modeId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                with_state(|s| s.mode = mode);
                agent.respond(id, json!({}));
            }
            _ => return false,
        }
        return true;
    }
    false
}

fn say(agent: &Agent, session: &str, text: String) {
    agent.update(
        session,
        json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}),
    );
}

fn permission(agent: &Agent, session: &str, tool_call: Value, options: Value) -> Value {
    let answer = agent.request(
        "session/request_permission",
        json!({"sessionId": session, "toolCall": tool_call, "options": options}),
    );
    answer.get("outcome").cloned().unwrap_or(answer)
}

/// Prompt-time scenarios of the profiles, before the shared reply. True when the prompt is
/// answered (or deliberately left open) here.
pub fn prompt(agent: &Arc<Agent>, session: &str) -> bool {
    if env("GOAT_ACP_ANTIGRAVITY_HARNESS_FAILURE").as_deref() == Some("pending") {
        say(agent, session, "working".into());
        eprintln!(
            "I1022 11:04:37.910207 1865358 local_connection.py:551] harness stderr: Agent run failed: failed to handle call hook response: no pending hook for ID hook_request_2"
        );
        return true;
    }
    if flag("GOAT_ACP_ANTIGRAVITY_INTERACTION") {
        let outcome = permission(
            agent,
            session,
            json!({"toolCallId": "interaction_1", "title": "Which file should I edit?", "status": "pending"}),
            json!([{"optionId": "opt-a", "name": "src/a.rs", "kind": "allow_once"}, {"optionId": "opt-b", "name": "src/b.rs", "kind": "allow_once"}]),
        );
        say(agent, session, format!("interaction: {outcome}\n"));
    }
    if flag("GOAT_ACP_ANTIGRAVITY_GOAT_MCP") {
        let outcome = permission(
            agent,
            session,
            json!({"toolCallId": "goat-1", "title": "Run mcp_goat_goat_thread_read?", "kind": "other", "status": "pending", "rawInput": {"threadId": "t"}}),
            json!([{"optionId": "once", "name": "Allow", "kind": "allow_once"}, {"optionId": "no", "name": "Deny", "kind": "reject_once"}]),
        );
        say(agent, session, format!("goat mcp: {outcome}\n"));
    }
    if flag("GOAT_ACP_ANTIGRAVITY_SECURITY_WARNING") {
        let outcome = permission(
            agent,
            session,
            json!({"toolCallId": "shell-1", "title": "Run command?", "kind": "execute", "status": "pending", "rawInput": {"CommandLine": "npm test"}}),
            json!([
                {"optionId": "once", "name": "Allow", "kind": "allow_once"},
                {"optionId": "always", "name": "Always", "kind": "allow_always", "_meta": {"agy.security.warning": {"title": "Shell", "message": "Allows any npm command in this conversation."}}},
                {"optionId": "no", "name": "Deny", "kind": "reject_once"}
            ]),
        );
        say(agent, session, format!("shell: {outcome}\n"));
    }
    if flag("GOAT_ACP_ANTIGRAVITY_UPDATE_STEPS") {
        agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "steps-1", "title": "Run update_steps", "status": "pending",
            "rawInput": {"steps": [{"title": "Read the code", "status": "done"}, {"title": "Fix it", "status": "in_progress"}]}}));
        agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "steps-1", "status": "completed"}));
    }
    if let Some(path) = env("GOAT_ACP_ANTIGRAVITY_CLIENT_READ") {
        agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "read-1", "title": "Running client_view_file", "kind": "read", "status": "in_progress", "locations": [{"path": path}]}));
        let reply = agent.request(
            "fs/read_text_file",
            json!({"sessionId": session, "path": path, "line": 2, "limit": 1}),
        );
        say(agent, session, format!("read: {reply}\n"));
        agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "read-1", "status": "failed", "rawOutput": "step 7 failed: unrelated"}));
    }
    if flag("GOAT_ACP_ANTIGRAVITY_COMMAND") {
        agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "cmd-1", "title": "run_command", "status": "pending", "rawInput": {"CommandLine": "cargo test", "Cwd": "/w"}}));
        agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "cmd-1", "status": "completed", "rawOutput": {"exitCode": 0, "combinedOutput": "ok\n"}}));
    }
    if flag("GOAT_ACP_FX_SUBAGENT") {
        agent.update(session, json!({"sessionUpdate": "tool_call", "toolCallId": "sub-1", "name": "subagent", "title": "subagent", "status": "in_progress",
            "rawInput": {"action": "run", "task": "Review the diff"}}));
        agent.update(session, json!({"sessionUpdate": "tool_call_update", "toolCallId": "sub-1", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "{\"ok\":false,\"result\":\"the review found two prob"}}]}));
    }
    false
}
