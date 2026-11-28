//! v1 AntigravityAcpSupport.ts:66-110,119-160,189-210 and
//! Adapters/AntigravityAdapterV2.ts:67-84 at 916b5ccc1b2.
use crate::{
    capabilities::acp_base_capabilities,
    flavor::{AcpFlavor, AuthPolicy, LaunchCommand, ResumeMethod},
    policy::{self, Disposition, RuntimePolicy},
    wire::{InitializeInfo, ModeState},
};
use goat2_contracts::{EngineDriver, ProviderCapabilities, RuntimeMode};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::{Map, Value, json};
#[derive(Debug, Default)]
pub struct Antigravity {
    pub auth_method: Option<String>,
}
fn version(s: Option<&str>) -> Option<(u64, u64, u64)> {
    let s = s?
        .trim()
        .strip_prefix("agy_acp_server_")
        .or_else(|| s?.trim().strip_prefix('v'))
        .unwrap_or(s?.trim());
    let mut p = s.split('.');
    let a = p.next()?.parse().ok()?;
    let b = p.next()?.parse().ok()?;
    let c = p
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()?;
    Some((a, b, c))
}
fn appends(i: &InitializeInfo) -> bool {
    i.agent_version
        .as_deref()
        .is_some_and(|s| s.trim() == "1.4.5")
        || i.capabilities_meta
            .as_ref()
            .and_then(|m| m.pointer("/antigravity/systemPrompt/append"))
            .and_then(Value::as_bool)
            == Some(true)
}
impl AcpFlavor for Antigravity {
    fn driver(&self) -> &str {
        "antigravity"
    }
    fn engine_driver(&self) -> EngineDriver {
        EngineDriver::Antigravity
    }
    fn capabilities(&self) -> ProviderCapabilities {
        let mut c = acp_base_capabilities();
        c.sessions.supports_model_switch_in_session = true;
        c.sessions.supports_runtime_mode_switch_in_session = true;
        c.tools.supports_mcp_tools = true;
        c.subagents.supports_subagents = true;
        c
    }
    fn launch(&self, _: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        Ok(LaunchCommand::new(
            if cfg!(windows) {
                "agy_acp_server.exe"
            } else {
                "agy_acp_server"
            },
            Vec::<String>::new(),
        ))
    }
    fn auth_policy(&self) -> AuthPolicy {
        AuthPolicy::Eager {
            method_id: self
                .auth_method
                .clone()
                .unwrap_or_else(|| "oauth-personal".into()),
        }
    }
    fn resume_method(&self) -> Option<ResumeMethod> {
        Some(ResumeMethod::Resume)
    }
    fn session_meta(
        &self,
        i: &InitializeInfo,
        instructions: Option<&str>,
    ) -> Option<Map<String, Value>> {
        let mut a = Map::new();
        if version(i.agent_version.as_deref()).is_some_and(|v| ((1, 4, 2)..=(1, 4, 5)).contains(&v))
        {
            a.insert("disabledTools".into(), json!(["run_workflow"]));
        }
        if appends(i)
            && let Some(s) = instructions
        {
            a.insert("systemPrompt".into(), json!({"append":s}));
        }
        if a.is_empty() {
            None
        } else {
            Some(json!({"antigravity":a}).as_object().unwrap().clone())
        }
    }
    fn instructions_in_session_meta(&self, i: &InitializeInfo) -> bool {
        appends(i)
    }
    fn steers_with_prompt(&self, i: &InitializeInfo) -> bool {
        version(i.agent_version.as_deref()).is_some_and(|v| v >= (1, 5, 0))
    }
    fn session_mode_for(&self, m: RuntimeMode, modes: Option<&ModeState>) -> Option<String> {
        Some(
            if m == RuntimeMode::Auto && modes.is_some_and(|s| s.has("auto")) {
                "auto"
            } else {
                "default"
            }
            .into(),
        )
    }
    fn permission_disposition(&self, p: &RuntimePolicy, r: &Value) -> Disposition {
        let d = policy::permission_disposition(p, r.get("toolCall").unwrap_or(&Value::Null));
        if d == Disposition::Deny {
            d
        } else if p.runtime_mode == RuntimeMode::Auto {
            Disposition::Ask
        } else {
            d
        }
    }
}
