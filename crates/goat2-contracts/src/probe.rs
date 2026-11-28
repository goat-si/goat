//! Provider probe results: what the host knows about an installed provider without a session.
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc): `packages/contracts/src/server.ts`
//! (`ServerProvider` subset, `ServerProviderAuth`, `ServerProviderModel`),
//! `serverProviderState.ts` and `model.ts` (`ModelCapabilities`, `ProviderOptionDescriptor`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// v1 `ServerProviderState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ServerProviderState {
    Ready,
    Warning,
    Error,
    Disabled,
}

/// v1 `ServerProviderAuthStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ServerProviderAuthStatus {
    Authenticated,
    Unauthenticated,
    Unknown,
}

/// v1 `ServerProviderCli`: whether the probe found the provider's CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ServerProviderCli {
    Present,
    Missing,
    None,
}

/// v1 `AcpRegistryUrlAuthAction` (`acpRegistry.ts`): the sign-in URL an ACP registry agent asked the
/// person to open, answered by its elicitation id.
///
/// v1's length checks on these strings are not carried: the registry driver bounds what it reads,
/// and serde and the JSON Schema accept the same values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryUrlAuthAction {
    pub elicitation_id: String,
    pub url: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expires_at: Option<String>,
}

/// v1 `ServerProviderAuth`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerProviderAuth {
    pub status: ServerProviderAuthStatus,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auth_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub email: Option<String>,
    /// Pending ACP registry sign-in (v1 `action`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub action: Option<AcpRegistryUrlAuthAction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub can_logout: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subscription_sharing: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    /// Origin of the custom endpoint the instance sends its requests to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub endpoint: Option<String>,
}

/// v1 `ProviderOptionChoice`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOptionChoice {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_default: Option<bool>,
}

/// v1 select option `role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderOptionRole {
    Reasoning,
}

/// v1 `ProviderOptionDescriptor` (`select` or `boolean`), e.g. reasoning effort.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProviderOptionDescriptor {
    Select {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        description: Option<String>,
        options: Vec<ProviderOptionChoice>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        current_value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        prompt_injected_values: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        role: Option<ProviderOptionRole>,
    },
    Boolean {
        id: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        current_value: Option<bool>,
    },
}

/// v1 `ModelCapabilities`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapabilities {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub option_descriptors: Option<Vec<ProviderOptionDescriptor>>,
}

/// v1 model `badge`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelBadge {
    New,
}

/// v1 `ServerProviderModel`: one model the provider offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerProviderModel {
    pub slug: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub short_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sub_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub aliases: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub badge: Option<ModelBadge>,
    pub is_custom: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_default: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub is_legacy: Option<bool>,
    /// False when sessions can use the model but application text generation cannot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub supports_text_generation: Option<bool>,
    pub capabilities: Option<ModelCapabilities>,
}

/// What `EngineFactory::probe()` returns: the v1 `ServerProvider` fields a probe can know
/// (install, version, auth, models). The host adds instance identity and settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProbeResult {
    pub installed: bool,
    pub version: Option<String>,
    /// Version reported by the installed CLI when it differs from `version` (v1).
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<String>")]
    pub installed_version: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cli: Option<ServerProviderCli>,
    /// Resolved executable path (GOAT 2; v1 kept it in provider settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub binary_path: Option<String>,
    pub status: ServerProviderState,
    pub auth: ServerProviderAuth,
    pub models: Vec<ServerProviderModel>,
    /// RFC 3339 UTC timestamp of this probe.
    pub checked_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message: Option<String>,
}
