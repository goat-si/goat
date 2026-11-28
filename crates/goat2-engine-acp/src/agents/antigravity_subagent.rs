//! Antigravity's native subagents as child work.
//!
//! v1 at 916b5ccc1b2: `AntigravityAdapterV2.ts:113-141` (`extractAntigravitySubagentUpdate`),
//! `AntigravityProtocol.ts:694-736` (subagent titles, classification, output),
//! `AntigravitySwarmProtocol.ts:1-120, 238-255` (`swarm` tool identity, added worker's model and
//! conversation), `AntigravityChildWork.ts:44-83` (launch text) and `AntigravitySwarmWork.ts:10-64`
//! (`swarm` `add` launches). Transcripts and children still at work read the runtime's profile
//! database in v1 and are not carried.

use goat2_contracts::TurnItemStatus;
use serde_json::Value;

use super::antigravity_protocol::bound_text;
use crate::{flavor::SubagentToolUpdate, items::ToolState};

/// v1 `ANTIGRAVITY_SUBAGENT_BATCH_TITLE` (AntigravityChildWork.ts:47-48).
pub const ANTIGRAVITY_SUBAGENT_BATCH_TITLE: &str = "Antigravity subagent batch";
const TOOL_TEXT_LIMIT: usize = 8_000;
/// v1 `MAX_SWARM_ADD_LAUNCHES` (AntigravitySwarmWork.ts:25-26).
const MAX_SWARM_ADD_LAUNCHES: i64 = 64;

/// v1 `ANTIGRAVITY_SUBAGENT_TITLES` (AntigravityProtocol.ts:694-701).
const SUBAGENT_TITLES: [&str; 5] = [
    "Running start_subagent",
    "Run start_subagent?",
    "Running invoke_subagent",
    "Run invoke_subagent?",
    // agy 1.5 auto-approved calls.
    "Run invoke_subagent",
];

const SWARM_TOOLS: [&str; 4] = ["swarm", "post_message", "read_board", "swarm_wait"];

/// v1 `LEGACY_SWARM_TITLE_TO_TOOL` (AntigravitySwarmProtocol.ts:14-27).
fn legacy_swarm_tool(title: &str) -> Option<&'static str> {
    SWARM_TOOLS.into_iter().find(|tool| {
        title == format!("Running {tool}")
            || title == format!("Run {tool}?")
            || title == format!("Run {tool}")
    })
}

struct SwarmCall {
    tool: &'static str,
    action: Option<String>,
    mcp: bool,
}

/// v1 `identifyAntigravitySwarmToolCall` (AntigravitySwarmProtocol.ts:41-120).
fn identify_swarm_tool_call(tool: &ToolState) -> Option<SwarmCall> {
    let meta = tool.meta.as_ref();
    let mcp = meta
        .and_then(|m| m.get("is_mcp_tool_call"))
        .and_then(Value::as_bool)
        == Some(true);
    let swarm_meta = meta.and_then(|m| m.pointer("/antigravity/swarm"));
    let meta_tool = swarm_meta
        .and_then(|s| s.get("tool"))
        .and_then(Value::as_str)
        .and_then(|t| SWARM_TOOLS.into_iter().find(|known| *known == t));
    let name = meta_tool.or_else(|| {
        tool.title
            .as_deref()
            .and_then(|t| legacy_swarm_tool(t.trim()))
    })?;
    let kind = tool.kind.as_deref();
    let allowed = match name {
        "swarm" | "post_message" => kind.is_none_or(|k| k == "other"),
        "read_board" => kind.is_none_or(|k| k == "other" || k == "read"),
        _ => kind.is_none_or(|k| k == "other" || k == "think"),
    };
    if !allowed {
        return None;
    }
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let action = text(swarm_meta.and_then(|s| s.get("action")))
        .or_else(|| text(tool.raw_input.as_ref().and_then(|i| i.get("action"))));
    Some(SwarmCall {
        tool: name,
        action,
        mcp,
    })
}

/// v1 `classifyAntigravitySubagentToolCall` (AntigravityProtocol.ts:703-720): true for a native
/// subagent or `swarm` worker launch (MCP calls with the same names are not).
pub fn is_subagent_tool_call(tool: &ToolState) -> bool {
    if tool.kind.as_deref().is_some_and(|k| k != "other") {
        return false;
    }
    if let Some(swarm) = identify_swarm_tool_call(tool) {
        return swarm.tool == "swarm"
            && !swarm.mcp
            && swarm.action.is_some_and(|a| a.eq_ignore_ascii_case("add"));
    }
    if !tool
        .title
        .as_deref()
        .is_some_and(|t| SUBAGENT_TITLES.contains(&t))
    {
        return false;
    }
    tool.meta
        .as_ref()
        .and_then(|m| m.get("is_mcp_tool_call"))
        .and_then(Value::as_bool)
        != Some(true)
}

/// v1 `AntigravityChildLaunch`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildLaunch {
    pub role: String,
    pub prompt: String,
}

/// v1 `swarmAddLaunches` (AntigravitySwarmWork.ts:28-64).
fn swarm_add_launches(input: &Value) -> Option<Vec<ChildLaunch>> {
    let text = |key: &str| -> Result<Option<String>, ()> {
        match input.get(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(()),
        }
    };
    let action = input.get("action")?.as_str()?;
    let (Ok(name), Ok(role), Ok(brief)) = (text("name"), text("role"), text("brief")) else {
        return None;
    };
    let tasks: Vec<String> = match input.get("tasks") {
        None => Vec::new(),
        Some(Value::Array(list)) => list
            .iter()
            .map(|t| t.as_str().map(str::to_owned))
            .collect::<Option<_>>()?,
        Some(_) => return None,
    };
    let n = match input.get("n") {
        None => 0,
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|f| f.is_finite())
            .map_or(0, |f| f.trunc() as i64),
        Some(_) => return None,
    };
    if !action.trim().eq_ignore_ascii_case("add") {
        return None;
    }
    let base = name.as_deref().map(str::trim).unwrap_or_default();
    let base = base.strip_prefix('@').unwrap_or(base);
    let brief = brief.as_deref().map(str::trim).unwrap_or_default();
    let count = (tasks.len() as i64).max(n).clamp(1, MAX_SWARM_ADD_LAUNCHES) as usize;
    let suffix = match role.as_deref() {
        Some(r) if !r.trim().is_empty() && r != "worker" => format!(" ({})", r.trim()),
        _ => String::new(),
    };
    let join = |task: &str, single: bool| {
        if !brief.is_empty() && !task.is_empty() {
            format!("{brief}\n\n{task}")
        } else if single {
            if brief.is_empty() {
                task.to_owned()
            } else {
                brief.to_owned()
            }
        } else if task.is_empty() {
            brief.to_owned()
        } else {
            task.to_owned()
        }
    };
    if count == 1 {
        let task = tasks.first().map(|t| t.trim()).unwrap_or_default();
        return Some(vec![ChildLaunch {
            role: if base.is_empty() {
                format!("Swarm worker{suffix}")
            } else {
                format!("@{base}{suffix}")
            },
            prompt: join(task, true),
        }]);
    }
    Some(
        (0..count)
            .map(|index| {
                let task = tasks.get(index).map(|t| t.trim()).unwrap_or_default();
                ChildLaunch {
                    role: if base.is_empty() {
                        format!("Swarm worker {}{suffix}", index + 1)
                    } else {
                        format!("@{base}-{}{suffix}", index + 1)
                    },
                    prompt: join(task, false),
                }
            })
            .collect(),
    )
}

/// v1 `antigravitySubagentLaunches` (AntigravityChildWork.ts:50-69): agy 1.5 launches one child per
/// call with a flat input; earlier releases send a `Subagents` batch; `swarm` `add` workers.
pub fn subagent_launches(input: &Value) -> Option<Vec<ChildLaunch>> {
    let launch = |entry: &Value| {
        Some(ChildLaunch {
            role: entry.get("Role")?.as_str()?.to_owned(),
            prompt: entry.get("Prompt")?.as_str()?.to_owned(),
        })
    };
    if let Some(Value::Array(batch)) = input.get("Subagents")
        && !batch.is_empty()
        && let Some(launches) = batch.iter().map(launch).collect::<Option<Vec<_>>>()
    {
        return Some(launches);
    }
    launch(input)
        .map(|single| vec![single])
        .or_else(|| swarm_add_launches(input))
}

/// v1 `describeAntigravitySubagentLaunches` (AntigravityChildWork.ts:71-83): (title, prompt).
pub fn describe_launches(launches: &[ChildLaunch]) -> (String, String) {
    match launches {
        [only] => (only.role.clone(), only.prompt.clone()),
        _ => (
            launches
                .iter()
                .map(|l| l.role.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            launches
                .iter()
                .map(|l| format!("{}\n{}", l.role, l.prompt))
                .collect::<Vec<_>>()
                .join("\n\n"),
        ),
    }
}

fn output_field(tool: &ToolState, key: &str) -> Option<String> {
    tool.raw_output
        .as_ref()?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// v1 `antigravitySwarmAddModel` (AntigravitySwarmProtocol.ts:245-255).
fn swarm_add_model(tool: &ToolState) -> Option<String> {
    output_field(tool, "model").or_else(|| {
        tool.raw_input
            .as_ref()?
            .get("model")?
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    })
}

/// v1 `antigravitySubagentOutput` (AntigravityProtocol.ts:733-736).
fn subagent_output(tool: &ToolState) -> Option<String> {
    match &tool.raw_output {
        Some(Value::String(s)) if !s.trim().is_empty() => {
            Some(bound_text(s.trim(), TOOL_TEXT_LIMIT))
        }
        _ => None,
    }
}

/// v1 `extractAntigravitySubagentUpdate` (AntigravityAdapterV2.ts:113-141): native subagent tools
/// report no child session ids except `swarm` adds, so children stay read-only.
pub fn subagent_update(tool: &ToolState) -> Option<SubagentToolUpdate> {
    if !is_subagent_tool_call(tool) {
        return None;
    }
    let status = match tool.status.as_deref() {
        Some("failed") => TurnItemStatus::Failed,
        Some("pending") => TurnItemStatus::Pending,
        _ => TurnItemStatus::Running,
    };
    let launch = tool
        .raw_input
        .as_ref()
        .and_then(subagent_launches)
        .map(|launches| describe_launches(&launches));
    let output = subagent_output(tool);
    Some(SubagentToolUpdate {
        native_task_id: tool.tool_call_id.clone(),
        child_session_id: output_field(tool, "conversation_id"),
        prompt: launch
            .as_ref()
            .map(|(_, prompt)| prompt.clone())
            .or_else(|| output.clone())
            .or_else(|| tool.title.clone())
            .unwrap_or_else(|| ANTIGRAVITY_SUBAGENT_BATCH_TITLE.to_owned()),
        title: Some(
            launch
                .map(|(title, _)| title)
                .unwrap_or_else(|| ANTIGRAVITY_SUBAGENT_BATCH_TITLE.to_owned()),
        ),
        model: swarm_add_model(tool),
        status,
        result: if status == TurnItemStatus::Failed {
            output
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(title: &str, input: Value) -> ToolState {
        ToolState {
            tool_call_id: "t1".into(),
            title: Some(title.into()),
            status: Some("in_progress".into()),
            raw_input: Some(input),
            ..Default::default()
        }
    }

    #[test]
    fn invoke_subagent_and_batches() {
        let single = subagent_update(&tool(
            "Run invoke_subagent",
            json!({"Role": "reviewer", "Prompt": "Check it"}),
        ))
        .unwrap();
        assert_eq!(
            (single.title.as_deref(), single.prompt.as_str()),
            (Some("reviewer"), "Check it")
        );
        let batch = subagent_update(&tool(
            "Running start_subagent",
            json!({"Subagents": [{"Role": "a", "Prompt": "x"}, {"Role": "b", "Prompt": "y"}]}),
        ))
        .unwrap();
        assert_eq!(batch.title.as_deref(), Some("a, b"));
        assert_eq!(batch.prompt, "a\nx\n\nb\ny");
        let mut mcp = tool("Run invoke_subagent", json!({}));
        mcp.meta = Some(json!({"is_mcp_tool_call": true}));
        assert!(subagent_update(&mcp).is_none());
        let mut executed = tool("Run invoke_subagent", json!({}));
        executed.kind = Some("execute".into());
        assert!(subagent_update(&executed).is_none());
    }

    #[test]
    fn swarm_add_workers() {
        let mut add = tool(
            "Run swarm",
            json!({"action": "add", "name": "@fix", "role": "tester", "brief": "Brief", "tasks": ["one", "two"], "model": "m"}),
        );
        add.raw_output = Some(json!({"conversation_id": "c1"}));
        let update = subagent_update(&add).unwrap();
        assert_eq!(
            update.title.as_deref(),
            Some("@fix-1 (tester), @fix-2 (tester)")
        );
        assert_eq!(
            update.prompt,
            "@fix-1 (tester)\nBrief\n\none\n\n@fix-2 (tester)\nBrief\n\ntwo"
        );
        assert_eq!(update.child_session_id.as_deref(), Some("c1"));
        assert_eq!(update.model.as_deref(), Some("m"));
        assert!(subagent_update(&tool("Run swarm", json!({"action": "list"}))).is_none());
        let single = swarm_add_launches(&json!({"action": "add", "brief": "Only brief"})).unwrap();
        assert_eq!(
            single,
            [ChildLaunch {
                role: "Swarm worker".into(),
                prompt: "Only brief".into()
            }]
        );
        assert_eq!(
            swarm_add_launches(&json!({"action": "add", "n": 1e9}))
                .unwrap()
                .len(),
            64
        );
    }

    #[test]
    fn failed_subagent_carries_its_output() {
        let mut failed = tool("Run invoke_subagent?", json!({"Role": "r", "Prompt": "p"}));
        failed.status = Some("failed".into());
        failed.raw_output = Some(json!(" child crashed "));
        let update = subagent_update(&failed).unwrap();
        assert_eq!(update.status, TurnItemStatus::Failed);
        assert_eq!(update.result.as_deref(), Some("child crashed"));
    }
}
