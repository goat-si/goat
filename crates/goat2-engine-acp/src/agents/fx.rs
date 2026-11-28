//! v1 provider-fx/src/server/acpSupport.ts:61-97,159-188,223-235 and adapter.ts:51-76.
use crate::{
    capabilities::acp_base_capabilities,
    flavor::{AcpFlavor, LaunchCommand, ModelWrite},
    policy::{self, Disposition, RuntimePolicy},
    wire::{ModeState, SessionSetup},
};
use goat2_contracts::{EngineDriver, ModelSelection, ProviderCapabilities, RuntimeMode};
use goat2_engine_api::{EngineError, SessionSpec};
use serde_json::Value;
#[derive(Debug, Default)]
pub struct Fx;
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
    fn launch(&self, _: &SessionSpec) -> Result<LaunchCommand, EngineError> {
        Ok(LaunchCommand::new("fx", ["acp"]))
    }
    fn session_mode_for(&self, m: RuntimeMode, modes: Option<&ModeState>) -> Option<String> {
        let desired = match m {
            RuntimeMode::Auto => "auto",
            RuntimeMode::FullAccess => "full-access",
            _ => "ask",
        };
        if desired == "auto" && modes.is_some_and(|s| !s.has("auto") && s.has("code")) {
            Some("code".into())
        } else {
            Some(desired.into())
        }
    }
    fn permission_disposition(&self, p: &RuntimePolicy, r: &Value) -> Disposition {
        if p.runtime_mode == RuntimeMode::Auto {
            return Disposition::Ask;
        }
        let mut p = p.clone();
        if p.runtime_mode == RuntimeMode::AutoAcceptEdits {
            p.runtime_mode = RuntimeMode::ApprovalRequired;
        }
        policy::permission_disposition(&p, r.get("toolCall").unwrap_or(&Value::Null))
    }
    fn model_write(&self, s: &ModelSelection, setup: &SessionSetup) -> ModelWrite {
        let model = s.model.trim();
        if model.is_empty() || model == "default" {
            return ModelWrite::Keep;
        }
        if setup.config_options.iter().any(|v| {
            v.get("id").and_then(Value::as_str) == Some("model")
                && v.get("currentValue").and_then(Value::as_str) == Some(model)
        }) {
            return ModelWrite::Keep;
        }
        ModelWrite::ConfigOption {
            config_id: "model".into(),
            value: model.into(),
        }
    }
}
