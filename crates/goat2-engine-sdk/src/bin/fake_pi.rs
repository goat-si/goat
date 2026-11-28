//! Deterministic Pi RPC peer for integration tests. Never connects to a provider.
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

fn emit(value: Value) {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &value).unwrap();
    writeln!(out).unwrap();
    out.flush().unwrap();
}

fn response(request: &Value, data: Value) {
    emit(
        json!({"type":"response", "id":request["id"], "command":request["type"], "success":true, "data":data}),
    );
}

fn finish(text: &str, aborted: bool) {
    let message = json!({"role":"assistant", "content":[{"type":"text", "text":text}], "stopReason":if aborted {"aborted"} else {"stop"}, "timestamp":1});
    if !text.is_empty() {
        emit(json!({"type":"message_start", "message":message}));
        emit(
            json!({"type":"message_update", "message":message, "assistantMessageEvent":{"type":"text_delta", "contentIndex":0, "delta":text}}),
        );
        emit(json!({"type":"message_end", "message":message}));
    }
    emit(json!({"type":"agent_end", "messages":[message]}));
    emit(json!({"type":"agent_settled", "aborted":aborted}));
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("0.0.0-fake");
        return;
    }
    let session = args
        .windows(2)
        .find(|w| w[0] == "--session")
        .map(|w| w[1].clone())
        .unwrap_or_else(|| "/tmp/fake-pi-session.jsonl".into());
    let mut active = false;
    let mut pending = false;
    let mut pending_prompt = None::<Value>;
    let mut reject_abort = false;
    let mut model_provider = "fake".to_owned();
    let mut model_id = "fake-model".to_owned();
    let mut thinking = "off".to_owned();
    let mut tier = "default".to_owned();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = request["type"].as_str().unwrap_or("");
        match kind {
            "get_state" => response(
                &request,
                json!({"sessionId":"fake-session", "sessionFile":session, "isStreaming":active, "isCompacting":false, "model":{"provider":model_provider, "id":model_id}, "thinkingLevel":thinking}),
            ),
            "get_available_models" => response(
                &request,
                json!({"models":[{"provider":"fake", "id":"fake-model", "name":"Fake model", "reasoning":false}, {"provider":"vendor/nested", "id":"custom/model", "name":"Slash model"}]}),
            ),
            "get_commands" => response(&request, json!({"commands":[]})),
            "set_model" => {
                model_provider = request["provider"].as_str().unwrap_or("").to_owned();
                model_id = request["modelId"].as_str().unwrap_or("").to_owned();
                response(&request, json!({}));
            }
            "set_thinking_level" => {
                thinking = request["level"].as_str().unwrap_or("").to_owned();
                response(&request, json!({}));
            }
            "clear_queue" => response(&request, json!({})),
            "prompt" if active && request["streamingBehavior"] == "steer" => {
                if request["message"] == "decline-steer" {
                    emit(
                        json!({"type":"response","id":request["id"],"command":"prompt","success":false,"error":"steer refused"}),
                    );
                } else {
                    response(&request, json!({}));
                }
            }
            "steer" => response(&request, json!({})),
            "prompt" => {
                let text = request["message"].as_str().unwrap_or("");
                if text == "crash" {
                    std::process::exit(23);
                }
                if text == "command-only" || text == "/computer off" {
                    response(&request, json!({"disposition":"handled"}));
                    continue;
                }
                if text.starts_with("/goat-service-tier") {
                    tier = text
                        .strip_prefix("/goat-service-tier ")
                        .unwrap_or("default")
                        .to_owned();
                    response(&request, json!({"disposition":"handled"}));
                    continue;
                }
                if text == "late-ack" {
                    emit(json!({"type":"agent_start"}));
                    finish("late", false);
                    response(&request, json!({}));
                    continue;
                }
                if text == "dialog-before-ack" {
                    active = true;
                    pending = true;
                    pending_prompt = Some(request.clone());
                    emit(
                        json!({"type":"extension_ui_request", "id":"dialog-1", "method":"input", "title":"Question"}),
                    );
                    continue;
                }
                response(&request, json!({}));
                active = true;
                emit(json!({"type":"agent_start"}));
                emit(json!({"type":"turn_start"}));
                match text {
                    "hang" => {}
                    "hang-reject-abort" => {
                        reject_abort = true;
                    }
                    "question" | "approval" => {
                        pending = true;
                        let method = if text == "question" {
                            "input"
                        } else {
                            "confirm"
                        };
                        emit(
                            json!({"type":"extension_ui_request", "id":"dialog-1", "method":method, "title":if text == "question" {"Choose a color"} else {"Approve action?"}, "message":"Please respond"}),
                        );
                    }
                    "tool" => {
                        emit(
                            json!({"type":"tool_execution_start", "toolCallId":"tool-1", "toolName":"read", "args":{"path":"example.txt"}}),
                        );
                        emit(
                            json!({"type":"tool_execution_end", "toolCallId":"tool-1", "toolName":"read", "result":{"content":[{"type":"text", "text":"file contents"}]}, "isError":false}),
                        );
                        finish("tool complete", false);
                        active = false;
                    }
                    "async-subagent" => {
                        emit(
                            json!({"type":"tool_execution_start","toolCallId":"sub-1","toolName":"subagent","args":{}}),
                        );
                        emit(
                            json!({"type":"tool_execution_end","toolCallId":"sub-1","toolName":"subagent","result":{"details":{"results":[],"asyncId":"run-1"}},"isError":false}),
                        );
                        finish("spawned", false);
                        active = false;
                        let snapshot = json!({"runs":[{"id":"run-1","state":"complete","children":[{"id":"child-1","kind":"step","agent":"worker","state":"complete"}]}]});
                        emit(
                            json!({"type":"extension_ui_request","method":"setWidget","widgetKey":"subagent-async","widgetLines":[format!("PI_SUBAGENT_ASYNC_JSON:{snapshot}")]}),
                        );
                    }
                    "background-dialog" => {
                        finish("done", false);
                        active = false;
                        emit(
                            json!({"type":"extension_ui_request","id":"background-1","method":"confirm","title":"Background approval"}),
                        );
                    }
                    "inspect-launch" => {
                        let extension = args
                            .windows(2)
                            .find(|w| w[0] == "--extension" || w[0] == "-e")
                            .map(|w| &w[1]);
                        let good = std::env::var("GOAT_MCP_URL").ok().as_deref()
                            == Some("http://127.0.0.1:9/mcp")
                            && std::env::var("GOAT_MCP_BEARER_TOKEN").ok().as_deref()
                                == Some("test-token")
                            && extension.is_some_and(|path| {
                                std::fs::read_to_string(path).is_ok_and(|source| {
                                    source.contains("GOAT_MCP_BEARER_TOKEN")
                                        && source.contains("registerTool")
                                })
                            });
                        finish(if good { "launch-ok" } else { "launch-invalid" }, false);
                        active = false;
                    }
                    "inspect-omo" => {
                        let good = std::env::var("SENPI_RPC_HOST_IDLE_EXIT_MS").ok().as_deref()
                            == Some("1")
                            && std::env::var("SENPI_RPC_HOST_EMPTY_EXIT_MS")
                                .ok()
                                .as_deref()
                                == Some("1")
                            && std::env::var("GOAT_PI_PROFILE").ok().as_deref() == Some("omo");
                        finish(if good { "omo-ok" } else { "omo-invalid" }, false);
                        active = false;
                    }
                    "inspect-config" => {
                        finish(
                            &format!("{model_provider}|{model_id}:{thinking}:{tier}"),
                            false,
                        );
                        active = false;
                    }
                    _ => {
                        finish(&format!("echo: {text}"), false);
                        active = false;
                    }
                }
            }
            "extension_ui_response" => {
                if pending && request["id"] == "dialog-1" {
                    pending = false;
                    if let Some(prompt) = pending_prompt.take() {
                        response(&prompt, json!({}));
                    }
                    let answer = request
                        .get("value")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            request
                                .get("confirmed")
                                .map(Value::to_string)
                                .unwrap_or_else(|| "cancelled".into())
                        });
                    finish(&format!("answer: {answer}"), false);
                    active = false;
                }
            }
            "abort" => {
                if reject_abort {
                    reject_abort = false;
                    emit(
                        json!({"type":"response","id":request["id"],"command":"abort","success":false,"error":"abort refused"}),
                    );
                    finish("still running", false);
                    active = false;
                    continue;
                }
                response(&request, json!({}));
                if active {
                    finish("", true);
                    active = false;
                    pending = false;
                }
            }
            _ => emit(
                json!({"type":"response", "id":request["id"], "command":kind, "success":false, "error":"unsupported fake command"}),
            ),
        }
    }
}
