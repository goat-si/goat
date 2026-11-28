//! Pure scenario-to-host translation and replay preparation for the GOAT 2 runner.
use std::collections::BTreeMap;

use goat2_contracts::{
    card::ThreadKind,
    ids::{InputId, ThreadId},
    log::InputMode,
    model::{ModelSelection, RuntimeMode},
    subscribe::ClientFrame,
};
use serde_json::Value;

use crate::scenario::{SendMode, Step};

/// Replace placeholders in JSON frame values only, retaining all other record metadata.
pub fn materialize_transcript(bytes: &[u8], workspace: &str) -> Result<Vec<u8>, String> {
    fn replace(value: &mut Value, workspace: &str) {
        match value {
            Value::String(s) => *s = s.replace("<workspace>", workspace),
            Value::Array(values) => values.iter_mut().for_each(|v| replace(v, workspace)),
            Value::Object(values) => values.values_mut().for_each(|v| replace(v, workspace)),
            _ => {}
        }
    }
    crate::transcript::parse(bytes).map_err(|e| e.to_string())?;
    let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in text.lines() {
        let mut record: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if let Some(frame) = record.get_mut("frame") {
            replace(frame, workspace);
        }
        serde_json::to_writer(&mut out, &record).map_err(|e| e.to_string())?;
        out.push(b'\n');
    }
    Ok(out)
}

/// Translate a command step using IDs previously observed in the host log.
/// Await and unsupported control steps are handled by the driver, not this function.
pub fn command_for_step(
    step: &Step,
    thread_id: Option<&ThreadId>,
    inputs: &BTreeMap<String, InputId>,
    workspace: &str,
    model: &str,
) -> Result<Option<ClientFrame>, String> {
    let thread = || {
        thread_id
            .cloned()
            .ok_or_else(|| "thread has not started".to_owned())
    };
    let input_id = |alias: &str| {
        inputs
            .get(alias)
            .cloned()
            .ok_or_else(|| format!("input {alias} has not been accepted"))
    };
    let frame = match step {
        Step::Send {
            id,
            input,
            text,
            mode,
            ..
        } => {
            if let Some(thread_id) = thread_id {
                ClientFrame::SendInput {
                    req_id: id.clone(),
                    client_request_id: input.clone(),
                    thread_id: thread_id.clone(),
                    text: text.clone(),
                    mode: match mode {
                        SendMode::Start | SendMode::Queue => InputMode::Followup,
                        SendMode::Steer => InputMode::Steer,
                        SendMode::Interrupt => InputMode::Interrupt,
                    },
                    attachments: None,
                }
            } else {
                ClientFrame::StartThread {
                    req_id: id.clone(),
                    client_request_id: input.clone(),
                    kind: ThreadKind::User,
                    title: None,
                    bot_id: None,
                    parent: None,
                    model_selection: ModelSelection {
                        instance_id: "codex".into(),
                        model: model.into(),
                        options: None,
                    },
                    runtime_mode: Some(RuntimeMode::FullAccess),
                    cwd: Some(workspace.into()),
                    text: Some(text.clone()),
                    mode: None,
                }
            }
        }
        Step::Interrupt { id, .. } => ClientFrame::StopThread {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
        },
        Step::QueueEdit {
            id, input, text, ..
        } => ClientFrame::EditQueued {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_id: input_id(input)?,
            text: text.clone(),
        },
        Step::QueueCancel { id, input, .. } => ClientFrame::CancelQueued {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_id: input_id(input)?,
        },
        Step::QueuePromote { id, input, .. } => ClientFrame::PromoteToSteer {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_id: input_id(input)?,
        },
        Step::QueueReorder { id, order, .. } => ClientFrame::ReorderQueued {
            req_id: id.clone(),
            client_request_id: id.clone(),
            thread_id: thread()?,
            input_ids: order
                .iter()
                .map(|s| input_id(s))
                .collect::<Result<_, _>>()?,
        },
        Step::Await { .. } => return Ok(None),
        Step::Mcp { .. }
        | Step::AwaitCall { .. }
        | Step::RestartHost { .. }
        | Step::AdvanceClock { .. }
        | Step::ReleaseGate { .. } => {
            return Err("step is not supported by the GOAT 2 runner".into());
        }
    };
    Ok(Some(frame))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn materializes_nested_frames_without_touching_metadata() {
        let source = b"{\"type\":\"transcript_start\",\"provider\":\"codex\",\"protocol\":\"p\",\"version\":\"1\",\"scenario\":\"s\",\"metadata\":{\"description\":\"<workspace>\"}}\n{\"type\":\"expect_outbound\",\"frame\":{\"a\":[\"<workspace>/x\",{\"b\":\"<workspace>\"}]}}\n{\"type\":\"runtime_exit\",\"status\":\"success\"}\n";
        let result = materialize_transcript(source, "/tmp/a\"b").unwrap();
        let lines: Vec<Value> = std::str::from_utf8(&result)
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(lines[0]["metadata"]["description"], "<workspace>");
        assert_eq!(
            lines[1]["frame"],
            json!({"a":["/tmp/a\"b/x",{"b":"/tmp/a\"b"}]})
        );
        crate::transcript::parse(&result).unwrap();
    }

    #[test]
    fn translates_start_followup_and_queue_actions() {
        let send = Step::Send {
            id: "s".into(),
            thread: "t".into(),
            input: "i".into(),
            text: "hi".into(),
            mode: SendMode::Queue,
            run: None,
        };
        let start = command_for_step(&send, None, &BTreeMap::new(), "/work", "model")
            .unwrap()
            .unwrap();
        let wire = serde_json::to_value(start).unwrap();
        assert_eq!(wire["type"], "start_thread");
        assert_eq!(wire["clientRequestId"], "i");
        assert_eq!(
            wire["modelSelection"],
            json!({"instanceId":"codex", "model":"model"})
        );
        assert_eq!(wire["runtimeMode"], "full-access");
        let thread = ThreadId::from("thread");
        let followup = command_for_step(&send, Some(&thread), &BTreeMap::new(), "/work", "model")
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(followup).unwrap()["mode"], "followup");
        let edit = Step::QueueEdit {
            id: "e".into(),
            thread: "t".into(),
            input: "i".into(),
            text: "new".into(),
        };
        assert!(
            command_for_step(&edit, Some(&thread), &BTreeMap::new(), "/work", "model").is_err()
        );
        let inputs = BTreeMap::from([("i".into(), InputId::from("host-input"))]);
        let wire = serde_json::to_value(
            command_for_step(&edit, Some(&thread), &inputs, "/work", "model")
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(wire["inputId"], "host-input");
        assert_eq!(wire["text"], "new");
    }
}
