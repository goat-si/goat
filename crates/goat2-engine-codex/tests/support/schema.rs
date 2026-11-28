//! Shared by tests and `examples/record_codex.rs`: validate frames against the pinned codex
//! 0.167.0 schema bundle.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;

use goat2_engine_codex::transcript::{Entry, Transcript};
use serde_json::{Value, json};

pub fn bundle_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("schema/codex-0.167.0/codex_app_server_protocol.schemas.json")
}

/// Compiled validators keyed by definition path (`ClientRequest`, `v2/TurnStartResponse`, ...).
pub struct SchemaBook {
    root: Value,
    cache: HashMap<String, jsonschema::Validator>,
}

impl SchemaBook {
    pub fn load() -> Self {
        let text = std::fs::read_to_string(bundle_path()).expect("read pinned schema bundle");
        Self {
            root: serde_json::from_str(&text).expect("parse pinned schema bundle"),
            cache: HashMap::new(),
        }
    }

    /// Validate `value` against `#/definitions/<def>`.
    pub fn validate(&mut self, def: &str, value: &Value) -> Result<(), String> {
        if !self.cache.contains_key(def) {
            let mut root = self.root.clone();
            let exists = def
                .split('/')
                .try_fold(&root["definitions"], |node, part| node.get(part))
                .is_some();
            if !exists {
                return Err(format!("schema has no definition {def}"));
            }
            root["$ref"] = json!(format!("#/definitions/{def}"));
            let validator =
                jsonschema::draft7::new(&root).map_err(|e| format!("compile {def}: {e}"))?;
            self.cache.insert(def.to_string(), validator);
        }
        let validator = &self.cache[def];
        let errors: Vec<String> = validator
            .iter_errors(value)
            .take(3)
            .map(|e| {
                let text = e.to_string();
                format!("{} at {}", &text[..text.len().min(200)], e.instance_path())
            })
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

/// Response definition for a GOAT request method.
pub fn response_def_for_client_method(method: &str) -> Option<&'static str> {
    Some(match method {
        "initialize" => "InitializeResponse",
        "thread/start" => "v2/ThreadStartResponse",
        "thread/resume" => "v2/ThreadResumeResponse",
        "thread/turns/list" => "v2/ThreadTurnsListResponse",
        "turn/start" => "v2/TurnStartResponse",
        "turn/steer" => "v2/TurnSteerResponse",
        "turn/interrupt" => "v2/TurnInterruptResponse",
        "config/read" => "v2/ConfigReadResponse",
        _ => return None,
    })
}

/// Response definition for a Codex server request method.
pub fn response_def_for_server_method(method: &str) -> Option<&'static str> {
    Some(match method {
        "item/commandExecution/requestApproval" => "CommandExecutionRequestApprovalResponse",
        "item/fileChange/requestApproval" => "FileChangeRequestApprovalResponse",
        "item/permissions/requestApproval" => "PermissionsRequestApprovalResponse",
        "item/tool/requestUserInput" => "ToolRequestUserInputResponse",
        "mcpServer/elicitation/request" => "McpServerElicitationRequestResponse",
        _ => return None,
    })
}

/// Counts of validated frames by kind.
#[derive(Debug, Default, Clone)]
pub struct Counts {
    pub client_requests: usize,
    pub client_notifications: usize,
    pub client_responses: usize,
    pub server_notifications: usize,
    pub server_requests: usize,
    pub server_responses: usize,
    pub errors: usize,
}

/// Validate every frame of a transcript; returns the failures (with entry index) and counts.
pub fn check_transcript(book: &mut SchemaBook, transcript: &Transcript) -> (Vec<String>, Counts) {
    let mut failures = Vec::new();
    let mut counts = Counts::default();
    let mut client_methods: HashMap<String, String> = HashMap::new();
    let mut server_methods: HashMap<String, String> = HashMap::new();
    for (index, entry) in transcript.entries.iter().enumerate() {
        let (outbound, frame) = match entry {
            Entry::ExpectOutbound { frame, .. } => (true, frame),
            Entry::EmitInbound { frame, .. } => (false, frame),
            Entry::RuntimeExit { .. } => continue,
        };
        let id = frame.get("id").map(Value::to_string);
        let method = frame.get("method").and_then(Value::as_str);
        let check = match (outbound, &id, method) {
            (true, Some(id), Some(method)) => {
                client_methods.insert(id.clone(), method.to_string());
                counts.client_requests += 1;
                Some(("ClientRequest".to_string(), frame.clone()))
            }
            (true, None, Some(_)) => {
                counts.client_notifications += 1;
                Some(("ClientNotification".to_string(), frame.clone()))
            }
            (true, Some(id), None) => {
                if let Some(result) = frame.get("result") {
                    counts.client_responses += 1;
                    match server_methods
                        .get(id)
                        .and_then(|m| response_def_for_server_method(m))
                    {
                        Some(def) => Some((def.to_string(), result.clone())),
                        None => {
                            failures.push(format!(
                                "{}#{index}: response to unknown server request {id}",
                                transcript.scenario
                            ));
                            None
                        }
                    }
                } else {
                    counts.errors += 1;
                    Some(("JSONRPCError".to_string(), frame.clone()))
                }
            }
            (false, Some(id), Some(method)) => {
                server_methods.insert(id.clone(), method.to_string());
                counts.server_requests += 1;
                Some(("ServerRequest".to_string(), frame.clone()))
            }
            (false, None, Some(_)) => {
                counts.server_notifications += 1;
                Some(("ServerNotification".to_string(), frame.clone()))
            }
            (false, Some(id), None) => {
                if let Some(result) = frame.get("result") {
                    counts.server_responses += 1;
                    match client_methods
                        .get(id)
                        .and_then(|m| response_def_for_client_method(m))
                    {
                        Some(def) => Some((def.to_string(), result.clone())),
                        None => {
                            failures.push(format!(
                                "{}#{index}: response to unknown request {id}",
                                transcript.scenario
                            ));
                            None
                        }
                    }
                } else {
                    counts.errors += 1;
                    Some(("JSONRPCError".to_string(), frame.clone()))
                }
            }
            _ => {
                failures.push(format!(
                    "{}#{index}: unclassifiable frame {frame}",
                    transcript.scenario
                ));
                None
            }
        };
        if let Some((def, value)) = check
            && let Err(error) = book.validate(&def, &value)
        {
            failures.push(format!("{}#{index} ({def}): {error}", transcript.scenario));
        }
    }
    (failures, counts)
}
