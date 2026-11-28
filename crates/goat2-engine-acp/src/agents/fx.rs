//! fx (`fx acp`).
//!
//! v1 at 916b5ccc1b2: `packages/provider-fx/src/server/acpSupport.ts` (mode policy, the always-sent
//! first mode write, model and effort writes, launch), `adapter.ts:51-76` (capabilities),
//! `adapter.ts:78-152` (`subagent` tool calls as child work), `adapter.ts:180-221` (the flavor:
//! `ownedModelOptionIds: ["mode"]`, `lockSessionModeToPolicy`), `src/settings.ts` (binary path)
//! and `driver.ts:108-112` (home expansion of the binary path).

use goat2_contracts::{
    EngineDriver, ModelSelection, ProviderCapabilities, ProviderOptionSelectionValue, RuntimeMode,
    TurnItemStatus,
};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::Value;

use super::antigravity::selection_option_writes;
use crate::{
    capabilities::acp_base_capabilities,
    flavor::{
        AcpFlavor, ConfigWrite, LaunchCommand, ModeContext, ModeWrite, ModelWrite,
        SubagentToolUpdate, runtime_set_mode,
    },
    items::ToolState,
    policy::{self, Disposition, RuntimePolicy},
    wire::{ModeState, SessionSetup, config_option_id, select_values},
};

/// v1 `FX_DEFAULT_MODEL_SLUG` (acpSupport.ts:26-27): "Default" is the model `fx status` reports.
pub const FX_DEFAULT_MODEL_SLUG: &str = "default";
const FX_MODEL_CONFIG_ID: &str = "model";
const FX_MODE_CONFIG_ID: &str = "mode";
const FX_EFFORT_CONFIG_ID: &str = "effort";
const FX_DEFAULT_EFFORT: &str = "medium";
/// v1 `FX_EFFORT_LABELS` (:33-40); `medium` is the default (:42-51).
pub const FX_EFFORT_LABELS: [(&str, &str); 6] = [
    ("auto", "Auto"),
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("xhigh", "Extra High"),
    ("max", "Max"),
];
/// v1 `FX_SUPPORTED_RUNTIME_MODES` (:53-56).
pub const FX_SUPPORTED_RUNTIME_MODES: [RuntimeMode; 2] =
    [RuntimeMode::ApprovalRequired, RuntimeMode::Auto];
/// v1 `FX_FULL_ACCESS_MODE_ID` (:57).
pub const FX_FULL_ACCESS_MODE_ID: &str = "full-access";

/// v1 `fxSessionModeForPolicy` (:61-68). GOAT 2 policies carry no approval or sandbox policy.
pub fn fx_session_mode_for_policy(mode: RuntimeMode) -> &'static str {
    match mode {
        RuntimeMode::Auto => "auto",
        RuntimeMode::FullAccess => FX_FULL_ACCESS_MODE_ID,
        _ => "ask",
    }
}

/// v1 `fxModeId` (:84-98): fx 0.0.13 calls automatic review `code`, later fx `auto`; the first
/// advertised match wins.
pub fn fx_mode_id(requested: &str, advertised: &[String]) -> Option<String> {
    let candidates: &[&str] = match requested {
        "ask" => &["ask"],
        FX_FULL_ACCESS_MODE_ID => &[FX_FULL_ACCESS_MODE_ID],
        "auto" | "code" => &["auto", "code"],
        _ => &[],
    };
    candidates
        .iter()
        .find(|id| advertised.iter().any(|a| a == *id))
        .map(|id| (*id).to_owned())
}

/// v1 `expandHomePath` (provider-core pathExpansion.ts) for the binary path setting.
fn expand_home(path: &str) -> String {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    match (path, home) {
        ("~", Some(home)) => home,
        (p, Some(home)) if p.starts_with("~/") || p.starts_with("~\\") => {
            format!("{home}{}", &p[1..])
        }
        (p, _) => p.to_owned(),
    }
}

/// v1 `fxSubagentOutcome` (adapter.ts:105-125): fx clips tool results to 199 bytes, so a long reply
/// arrives as cut-off `{"ok":…,"result":"…` JSON; keeps the readable prefix and marks the cut.
pub fn fx_subagent_outcome(text: &str) -> Option<(bool, Option<String>)> {
    if let Ok(whole) = serde_json::from_str::<Value>(text)
        && let Some(ok) = whole.get("ok").and_then(Value::as_bool)
    {
        match whole.get("result") {
            Some(Value::String(result)) => return Some((ok, Some(result.clone()))),
            Some(Value::Null) => return Some((ok, None)),
            _ => {}
        }
    }
    let (ok, rest) = if let Some(rest) = text.strip_prefix(r#"{"ok":true,"result":""#) {
        (true, rest)
    } else if let Some(rest) = text.strip_prefix(r#"{"ok":false,"result":""#) {
        (false, rest)
    } else {
        return None;
    };
    // The fragment runs to the first unescaped quote.
    let mut end = rest.len();
    let mut escaped = false;
    for (index, c) in rest.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            end = index;
            break;
        }
    }
    let fragment = &rest[..end];
    let cut = !rest[end..].starts_with('"');
    let decode = |s: &str| serde_json::from_str::<String>(&format!("\"{s}\"")).ok();
    let prefix = decode(fragment).or_else(|| {
        // A \uXXXX escape cut short.
        let trimmed = fragment
            .rfind("\\u")
            .filter(|i| fragment.len() - i < 6)
            .map(|i| &fragment[..i])?;
        decode(trimmed)
    });
    Some((
        ok,
        prefix.map(|p| format!("{p}{}", if cut { "…" } else { "" })),
    ))
}

/// v1 `extractFxSubagentUpdate` (adapter.ts:127-152): fx streams no child frames, so each
/// `subagent` call becomes a child holding its task and reply.
pub fn fx_subagent_update(tool: &ToolState) -> Option<SubagentToolUpdate> {
    if tool.name.as_deref() != Some("subagent") {
        return None;
    }
    let input = tool.raw_input.as_ref()?;
    // fx 0.0.14 wraps the arguments in `request`; later fx sends them flat.
    let request = match input.get("request") {
        Some(request) if request.is_object() => request,
        _ => input,
    };
    let text_of = |key: &str| request.get(key).and_then(Value::as_str).map(str::to_owned);
    let (prompt, title) = match request.get("action").and_then(Value::as_str) {
        Some("run") => (text_of("task")?, None),
        Some("message") => (text_of("message")?, Some(text_of("agent")?)),
        _ => return None,
    };
    let text = tool
        .content
        .as_ref()
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|entry| entry.pointer("/content/text"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let outcome = text.as_deref().and_then(fx_subagent_outcome);
    let status = match tool.status.as_deref() {
        Some("completed") if outcome.as_ref().is_some_and(|(ok, _)| !ok) => TurnItemStatus::Failed,
        Some("completed") => TurnItemStatus::Completed,
        Some("failed") => TurnItemStatus::Failed,
        _ => TurnItemStatus::Running,
    };
    let result = if status == TurnItemStatus::Running {
        None
    } else {
        outcome.and_then(|(_, result)| result).or(text)
    };
    Some(SubagentToolUpdate {
        native_task_id: tool.tool_call_id.clone(),
        child_session_id: None,
        prompt,
        title,
        model: text_of("model"),
        status,
        result,
    })
}

#[derive(Debug, Default)]
pub struct Fx {
    /// v1 `FxSettings.binaryPath`; empty runs `fx` from PATH. All instances share its fx login.
    pub binary_path: Option<String>,
    /// v1 `defaultModel`: fx's id for "Default", from `fx status`.
    pub default_model: Option<String>,
}

impl AcpFlavor for Fx {
    fn driver(&self) -> &str {
        "fx"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::Fx
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let mut c = acp_base_capabilities();
        c.sessions.supports_model_switch_in_session = true;
        c.threads.can_read_thread_snapshot = true;
        c.tools.supports_mcp_tools = true;
        c.checkpointing.provider_can_read_conversation_snapshot = true;
        c.subagents.supports_subagents = true;
        c.subagents.emits_subagent_lifecycle = true;
        c
    }
    /// v1 `makeFxAcpRuntime` (acpSupport.ts:216-238): `<binaryPath || fx> acp`.
    fn launch(&self, _: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        let program = self
            .binary_path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(expand_home)
            .unwrap_or_else(|| "fx".to_owned());
        Ok(LaunchCommand::new(program, ["acp"]))
    }
    fn session_mode_for(&self, mode: RuntimeMode, modes: Option<&ModeState>) -> Option<String> {
        let requested = fx_session_mode_for_policy(mode);
        let advertised: Vec<String> = modes
            .map(|m| m.available.iter().map(|(id, _)| id.clone()).collect())
            .unwrap_or_default();
        Some(fx_mode_id(requested, &advertised).unwrap_or_else(|| requested.to_owned()))
    }
    /// v1 `withFxSessionMode` (acpSupport.ts:100-157): fx 0.0.13 reports `ask` on a new or loaded
    /// session but enforces its saved default until a client writes the mode, so the first write
    /// after start or load always goes out, even when it matches the reported mode. A mode fx
    /// does not advertise fails before anything is sent.
    fn mode_write(&self, mode: RuntimeMode, context: &ModeContext<'_>) -> ModeWrite {
        let requested = fx_session_mode_for_policy(mode);
        let advertised: Vec<String> = context
            .modes
            .map(|m| m.available.iter().map(|(id, _)| id.clone()).collect())
            .unwrap_or_default();
        let Some(target) = fx_mode_id(requested, &advertised) else {
            return ModeWrite::Unavailable(format!(
                "fx cannot run in mode \"{requested}\"; it advertises {}.",
                if advertised.is_empty() {
                    "no modes".to_owned()
                } else {
                    advertised.join(", ")
                }
            ));
        };
        if context.first_write && context.modes.is_some_and(|m| m.current_mode_id == target) {
            return ModeWrite::Config(
                ConfigWrite::new(FX_MODE_CONFIG_ID, target)
                    .allow_unlisted()
                    .resend_current(),
            );
        }
        runtime_set_mode(&target, context)
    }
    /// v1 `fxPermissionDisposition` (acpSupport.ts:70-82).
    fn permission_disposition(&self, p: &RuntimePolicy, r: &Value) -> Disposition {
        let tool_call = r.get("toolCall").unwrap_or(&Value::Null);
        match fx_session_mode_for_policy(p.runtime_mode) {
            "auto" => Disposition::Ask,
            FX_FULL_ACCESS_MODE_ID => policy::permission_disposition(p, tool_call),
            _ => {
                let mut ask = p.clone();
                ask.runtime_mode = RuntimeMode::ApprovalRequired;
                policy::permission_disposition(&ask, tool_call)
            }
        }
    }
    /// v1 `applyFxModelSelection` + `applyFxEffortDefault` (acpSupport.ts:159-206) and the option
    /// loop without the owned `mode` option and mode options (`lockSessionModeToPolicy`).
    /// "Default" picks fx's status model only when the session lists it; a picked model is sent
    /// even unlisted, since fx's backends accept or refuse it themselves.
    fn model_write(&self, selection: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        let options = &setup.config_options;
        let option = options.iter().find(|o| {
            config_option_id(o) == Some(FX_MODEL_CONFIG_ID)
                && o.get("type").and_then(Value::as_str) == Some("select")
        });
        let current = option
            .and_then(|o| o.get("currentValue"))
            .and_then(Value::as_str);
        let requested = selection.model.trim();
        let is_default = requested.is_empty() || requested == FX_DEFAULT_MODEL_SLUG;
        let target = if is_default {
            self.default_model.as_deref()
        } else {
            Some(requested)
        };
        let mut writes = Vec::new();
        if let Some(target) = target
            && Some(target) != current
            // The status default can belong to another fx backend; then the session's model stands.
            && (!is_default
                || option.is_some_and(|o| select_values(o).iter().any(|(v, _)| v == target)))
        {
            writes.push(ConfigWrite::new(FX_MODEL_CONFIG_ID, target).allow_unlisted());
        }
        let has_effort = selection.options.iter().flatten().any(|o| {
            o.id == FX_EFFORT_CONFIG_ID
                && matches!(&o.value, ProviderOptionSelectionValue::Text(t) if !t.trim().is_empty())
        });
        if !has_effort {
            writes.push(ConfigWrite::new(FX_EFFORT_CONFIG_ID, FX_DEFAULT_EFFORT).optional());
        }
        writes.extend(selection_option_writes(
            selection,
            options,
            &[FX_MODE_CONFIG_ID],
        ));
        if writes.is_empty() {
            ModelWrite::Keep
        } else {
            ModelWrite::ConfigOptions(writes)
        }
    }
    fn subagent_update(&self, tool: &ToolState) -> Option<SubagentToolUpdate> {
        fx_subagent_update(tool)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use goat2_contracts::ProviderOptionSelection;
    use serde_json::json;

    fn modes(current: &str, ids: &[&str]) -> ModeState {
        ModeState {
            current_mode_id: current.into(),
            available: ids.iter().map(|id| ((*id).into(), (*id).into())).collect(),
        }
    }

    #[test]
    fn first_mode_write_always_goes_out() {
        let fx = Fx::default();
        let state = modes("ask", &["ask", "code"]);
        let first = ModeContext {
            modes: Some(&state),
            config_options: &[],
            first_write: true,
        };
        assert_eq!(
            fx.mode_write(RuntimeMode::ApprovalRequired, &first),
            ModeWrite::Config(
                ConfigWrite::new("mode", "ask")
                    .allow_unlisted()
                    .resend_current()
            )
        );
        assert_eq!(
            fx.mode_write(RuntimeMode::Auto, &first),
            ModeWrite::SetMode("code".into())
        );
        let later = ModeContext {
            first_write: false,
            ..first
        };
        assert_eq!(
            fx.mode_write(RuntimeMode::ApprovalRequired, &later),
            ModeWrite::Keep
        );
        assert_eq!(
            fx.mode_write(RuntimeMode::FullAccess, &later),
            ModeWrite::Unavailable(
                "fx cannot run in mode \"full-access\"; it advertises ask, code.".into()
            )
        );
        let none = ModeContext {
            modes: None,
            config_options: &[],
            first_write: true,
        };
        assert_eq!(
            fx.mode_write(RuntimeMode::Auto, &none),
            ModeWrite::Unavailable(
                "fx cannot run in mode \"auto\"; it advertises no modes.".into()
            )
        );
    }

    #[test]
    fn model_and_effort_writes() {
        let setup = SessionSetup {
            config_options: vec![
                json!({"id":"model","type":"select","currentValue":"a","options":[{"value":"a"},{"value":"b"}]}),
                json!({"id":"effort","type":"select","currentValue":"high","options":[{"value":"medium"},{"value":"high"}]}),
                json!({"id":"mode","category":"mode","type":"select","currentValue":"ask","options":[{"value":"ask"}]}),
            ],
            ..Default::default()
        };
        let selection =
            |model: &str, options: Option<Vec<ProviderOptionSelection>>| ModelSelection {
                instance_id: "fx".into(),
                model: model.into(),
                options,
            };
        assert_eq!(
            Fx::default().model_write(&selection("zz", None), &setup),
            ModelWrite::ConfigOptions(vec![
                ConfigWrite::new("model", "zz").allow_unlisted(),
                ConfigWrite::new("effort", "medium").optional()
            ])
        );
        let with_default = Fx {
            default_model: Some("c".into()),
            ..Default::default()
        };
        let effort = Some(vec![
            ProviderOptionSelection {
                id: "effort".into(),
                value: ProviderOptionSelectionValue::Text("high".into()),
            },
            ProviderOptionSelection {
                id: "mode".into(),
                value: ProviderOptionSelectionValue::Text("code".into()),
            },
        ]);
        assert_eq!(
            with_default.model_write(&selection("default", effort), &setup),
            ModelWrite::ConfigOptions(vec![ConfigWrite::new("effort", "high").optional()])
        );
    }

    #[test]
    fn subagent_calls_become_child_work() {
        assert_eq!(
            fx_subagent_outcome(r#"{"ok":true,"result":"done"}"#),
            Some((true, Some("done".into())))
        );
        assert_eq!(
            fx_subagent_outcome(r#"{"ok":false,"result":"long repl"#),
            Some((false, Some("long repl…".into())))
        );
        assert_eq!(
            fx_subagent_outcome(r#"{"ok":true,"result":"caf\u00"#),
            Some((true, Some("caf…".into())))
        );
        assert_eq!(fx_subagent_outcome("plain"), None);
        let tool = ToolState {
            tool_call_id: "t1".into(),
            name: Some("subagent".into()),
            status: Some("completed".into()),
            raw_input: Some(
                json!({"request": {"action": "message", "agent": "rev", "message": "check it", "model": "m"}}),
            ),
            content: Some(
                json!([{"type": "content", "content": {"type": "text", "text": "{\"ok\":false,\"result\":\"nope\"}"}}]),
            ),
            ..Default::default()
        };
        let update = fx_subagent_update(&tool).unwrap();
        assert_eq!(update.status, TurnItemStatus::Failed);
        assert_eq!(update.title.as_deref(), Some("rev"));
        assert_eq!(update.prompt, "check it");
        assert_eq!(update.result.as_deref(), Some("nope"));
        assert_eq!(update.model.as_deref(), Some("m"));
    }
}
