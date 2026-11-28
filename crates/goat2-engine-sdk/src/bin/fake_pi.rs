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
    let mut structured = false;
    let mut batch = false;
    let mut batch_answers: Vec<String> = Vec::new();
    let mut model_provider = "fake".to_owned();
    let mut model_id = "fake-model".to_owned();
    let mut thinking = "off".to_owned();
    let mut tier = "default".to_owned();
    let mut recover_compaction = 0;
    let mut background = "";
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = request["type"].as_str().unwrap_or("");
        match kind {
            "get_state" => {
                if recover_compaction == 4 {
                    emit(json!({"type":"agent_start"}));
                }
                response(
                    &request,
                    json!({"sessionId":"fake-session", "sessionFile":session, "isStreaming":if recover_compaction > 0 { false } else { active }, "isCompacting":recover_compaction == 1, "pendingMessageCount":if recover_compaction == 2 { 1 } else { 0 }, "model":{"provider":model_provider, "id":model_id}, "thinkingLevel":thinking}),
                );
                if recover_compaction > 0 {
                    if recover_compaction != 3 && recover_compaction != 4 {
                        emit(json!({"type":"compaction_start", "reason":"auto"}));
                    }
                    let resumed_agent = recover_compaction == 4;
                    recover_compaction = 0;
                    if !resumed_agent {
                        emit(json!({"type":"compaction_end", "reason":"auto", "willRetry":true}));
                        emit(json!({"type":"agent_start"}));
                    }
                    finish("recovered", false);
                    active = false;
                }
                if background == "subagent" {
                    let snapshot = json!({"runs":[{"id":"run-1","state":"complete","children":[{"id":"child-1","kind":"step","agent":"worker","state":"complete"}]}]});
                    emit(
                        json!({"type":"extension_ui_request","method":"setWidget","widgetKey":"subagent-async","widgetLines":[format!("PI_SUBAGENT_ASYNC_JSON:{snapshot}")]}),
                    );
                    background = "";
                } else if background == "dialog" {
                    emit(
                        json!({"type":"extension_ui_request","id":"background-1","method":"confirm","title":"Background approval"}),
                    );
                    background = "";
                }
            }
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
                if request["message"] == "crash-steer" {
                    std::process::exit(23);
                }
                if request["message"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("inspect-steer"))
                    && (request["images"]
                        != json!([{"type":"image","data":"AAEC/w==","mimeType":"image/png"}])
                        || !request["message"]
                            .as_str()
                            .unwrap_or("")
                            .contains("[Attached image \"image.dat\" is saved at: /"))
                {
                    emit(
                        json!({"type":"response","id":request["id"],"command":"prompt","success":false,"error":"invalid steer images"}),
                    );
                } else if request["message"] == "decline-steer" {
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
                if text == "/consumed-no-disposition" {
                    response(&request, json!({}));
                    continue;
                }
                if [
                    "compaction-recovery",
                    "pending-recovery",
                    "stale-recovery",
                    "stale-agent-recovery",
                ]
                .contains(&text)
                {
                    response(&request, json!({}));
                    active = true;
                    emit(json!({"type":"agent_start"}));
                    emit(json!({"type":"agent_settled"}));
                    recover_compaction = if text == "pending-recovery" {
                        2
                    } else if text == "stale-recovery" {
                        3
                    } else if text == "stale-agent-recovery" {
                        4
                    } else {
                        1
                    };
                    if recover_compaction == 3 {
                        emit(json!({"type":"compaction_start", "reason":"auto"}));
                    }
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
                    text if text.starts_with("inspect-attachments") => {
                        finish(
                            &json!({"message":text,"images":request["images"]}).to_string(),
                            false,
                        );
                        active = false;
                    }
                    "hang" => {}
                    "structured-batch" => {
                        batch = true;
                        pending = true;
                        emit(
                            json!({"type":"tool_execution_start","toolCallId":"batch-ask","toolName":"ask_user_question","args":{"questions":[{"question":"Pick","header":"H","options":[{"label":"A","description":"Alpha"}]}]}}),
                        );
                        for n in 0..9 {
                            emit(
                                json!({"type":"extension_ui_request","id":format!("select-{n}"),"method":"select","title":"[H] Pick","options":["1. A — Alpha","2. Type something."]}),
                            );
                        }
                        emit(
                            json!({"type":"extension_ui_request","id":"release","method":"input","title":"Release"}),
                        );
                    }
                    "structured" => {
                        structured = true;
                        pending = true;
                        emit(
                            json!({"type":"tool_execution_start","toolCallId":"ask-1","toolName":"ask_user_question","args":{"questions":"[{\"question\":\"Pick\",\"header\":\"H\",\"options\":\"[{\\\"label\\\":\\\"A\\\",\\\"description\\\":\\\"Alpha\\\"}]\"}]"}}),
                        );
                        emit(
                            json!({"type":"extension_ui_request","id":"dialog-1","method":"select","title":"[H] Pick","options":["1. A — Alpha","2. Type something."]}),
                        );
                    }
                    "hang-reject-abort" => {
                        reject_abort = true;
                    }
                    "question" | "approval" | "approval-expire" => {
                        pending = true;
                        let method = if text == "question" {
                            "input"
                        } else {
                            "confirm"
                        };
                        emit(
                            json!({"type":"extension_ui_request", "id":"dialog-1", "method":method, "title":if text == "question" {"Choose a color"} else {"Approve action?"}, "message":"Please respond", "timeout":if text == "approval-expire" {-1} else {0}}),
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
                        background = "subagent";
                    }
                    "background-dialog" => {
                        finish("done", false);
                        active = false;
                        background = "dialog";
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
                if batch {
                    let id = request["id"].as_str().unwrap_or("");
                    if id.starts_with("select-") {
                        assert_eq!(request["value"], "2. Type something.");
                        continue;
                    }
                    let title = "[H] Pick\n\n1. A — Alpha\n\nEnter custom";
                    match id {
                        "release" => emit(
                            json!({"type":"extension_ui_request","id":"other-placeholder","method":"input","title":title,"placeholder":"not empty"}),
                        ),
                        "other-placeholder" => emit(
                            json!({"type":"extension_ui_request","id":"other-method","method":"editor","title":title,"placeholder":""}),
                        ),
                        "other-method" => emit(
                            json!({"type":"extension_ui_request","id":"missing-placeholder","method":"input","title":title}),
                        ),
                        "missing-placeholder" => emit(
                            json!({"type":"extension_ui_request","id":"follow-0","method":"input","title":title,"placeholder":""}),
                        ),
                        "checkpoint" => {
                            for n in 1..9 {
                                emit(
                                    json!({"type":"extension_ui_request","id":format!("follow-{n}"),"method":"input","title":title,"placeholder":""}),
                                );
                            }
                        }
                        _ if id.starts_with("follow-") => {
                            batch_answers
                                .push(request["value"].as_str().unwrap_or("<missing>").to_owned());
                            if id == "follow-0" {
                                emit(
                                    json!({"type":"extension_ui_request","id":"checkpoint","method":"input","title":"Checkpoint"}),
                                );
                            } else if batch_answers.len() == 9 {
                                finish(&format!("batch: {}", batch_answers.join(",")), false);
                                active = false;
                                pending = false;
                                batch = false;
                            }
                        }
                        _ => panic!("unexpected batch reply {id}"),
                    }
                    continue;
                }
                if structured
                    && request["id"] == "dialog-1"
                    && request["value"] == "2. Type something."
                {
                    emit(
                        json!({"type":"extension_ui_request","id":"custom-1","method":"input","title":"[H] Pick\n\n1. A — Alpha\n\nEnter custom","placeholder":""}),
                    );
                    continue;
                }
                if structured && request["id"] == "custom-1" {
                    structured = false;
                    pending = false;
                    finish(
                        &format!(
                            "custom: {}",
                            request["value"].as_str().unwrap_or("<missing>")
                        ),
                        false,
                    );
                    active = false;
                    continue;
                }
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
