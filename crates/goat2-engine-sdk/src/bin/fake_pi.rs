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
    let mut model_provider = "fake".to_owned();
    let mut model_id = "fake-model".to_owned();
    let mut thinking = "off".to_owned();
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
                json!({"models":[{"provider":"fake", "id":"fake-model", "name":"Fake model", "reasoning":false}]}),
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
                response(&request, json!({}))
            }
            "steer" => response(&request, json!({})),
            "prompt" => {
                let text = request["message"].as_str().unwrap_or("");
                if text == "crash" {
                    std::process::exit(23);
                }
                response(&request, json!({}));
                active = true;
                emit(json!({"type":"agent_start"}));
                emit(json!({"type":"turn_start"}));
                match text {
                    "hang" => {}
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
                                std::fs::metadata(path).is_ok_and(|m| m.len() > 0)
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
                        finish(&format!("{model_provider}/{model_id}:{thinking}"), false);
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
