//! Provider setup on the host wire: the provider list entries, install and sign-in flows, and the ACP
//! registry search/prepare results behind the `subscribe_providers` / `provider_*` commands.
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc): `packages/contracts/src/server.ts` (`ServerProvider`
//! subset), `providerSetup.ts` (`ProviderAuthState`, `ProviderAuthMethod`, `ProviderAuthInteraction`,
//! `ProviderInstallState`) and `acpRegistry.ts` (search and prepare results). Field names and literals
//! are v1's; v1 string length checks are not carried (the host bounds provider input).

use crate::{ProviderCapabilities, ProviderInstanceId, ProviderProbeResult};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
/// v1 `ServerProvider.setup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSetup {
    pub can_authenticate: bool,
    pub can_install: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub documentation_url: Option<String>,
}

/// v1 `ProviderAuthState.phase`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAuthPhase {
    Idle,
    Starting,
    Waiting,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
}

/// v1 `ProviderAuthMethod.type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAuthMethodType {
    Agent,
    Terminal,
    Credentials,
}

/// v1 `ProviderInstallState.phase`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderInstallPhase {
    Idle,
    Downloading,
    Extracting,
    Verifying,
    Succeeded,
    Failed,
    Cancelled,
}

/// v1 `ProviderInstallState.source`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderInstallSource {
    Managed,
    Local,
}

/// v1 `AcpRegistryDistribution`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AcpRegistryDistribution {
    Binary,
    Npx,
    Uvx,
}

/// v1 `AcpRegistryIntegrity`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum AcpRegistryIntegrity {
    Sha256,
    Registry,
}

/// v1 `ProviderAuthMethod`: one way to sign in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthMethod {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub can_remove: Option<bool>,
    pub name: String,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub description: Option<String>,
    pub r#type: ProviderAuthMethodType,
}

/// A response may contain credentials or typed secrets. Never log or persist the containing
/// frame (including goat.jsonl and tracing).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ProviderAuthResponse {
    Browser {
        action: ProviderAuthBrowserAction,
    },
    Terminal {
        #[serde(with = "crate::serde_util::auth_terminal_data")]
        #[ts(as = "String")]
        #[schemars(with = "String", length(max = 4096))]
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        size: Option<ProviderAuthTerminalSize>,
    },
    Credentials {
        #[serde(with = "crate::serde_util::auth_values")]
        #[ts(as = "std::collections::BTreeMap<String, String>")]
        #[schemars(schema_with = "auth_values_schema")]
        values: std::collections::BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderAuthBrowserAction {
    Accept,
    Decline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ProviderAuthTerminalSize {
    #[serde(with = "crate::serde_util::auth_cols")]
    #[ts(as = "u16")]
    #[schemars(with = "u16", range(min = 1, max = 500))]
    pub cols: u16,
    #[serde(with = "crate::serde_util::auth_rows")]
    #[ts(as = "u16")]
    #[schemars(with = "u16", range(min = 1, max = 200))]
    pub rows: u16,
}

fn auth_values_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type": "object", "maxProperties": 16,
        "propertyNames": {"type": "string", "minLength": 1, "maxLength": 128,
          "pattern": r"^[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff](?:[\s\S]*[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff])?$"},
        "additionalProperties": {"type": "string", "maxLength": 16384}})
}

impl std::fmt::Debug for ProviderAuthResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Browser { action } => f.debug_struct("Browser").field("action", action).finish(),
            Self::Terminal { size, .. } => f
                .debug_struct("Terminal")
                .field("data", &"<redacted>")
                .field("size", size)
                .finish(),
            Self::Credentials { values } => {
                let redacted: std::collections::BTreeMap<_, _> =
                    values.keys().map(|k| (k, "<redacted>")).collect();
                f.debug_struct("Credentials")
                    .field("values", &redacted)
                    .finish()
            }
        }
    }
}

/// v1 `ProviderAuthInteraction`: what the person must do next in a sign-in flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProviderAuthInteraction {
    Browser {
        id: String,
        /// v1 `SignInUrl`: http(s) only.
        #[serde(with = "crate::serde_util::sign_in_url")]
        #[ts(as = "String")]
        #[schemars(
            with = "String",
            length(min = 1, max = 16384),
            regex(
                pattern = r"^[Hh][Tt][Tt][Pp][Ss]?://(?:[\s\S]*[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff])?$"
            )
        )]
        url: String,
        requires_consent: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        accepts_callback: Option<bool>,
    },
    DeviceCode {
        id: String,
        /// v1 `SignInUrl`: http(s) only.
        #[serde(with = "crate::serde_util::sign_in_url")]
        #[ts(as = "String")]
        #[schemars(
            with = "String",
            length(min = 1, max = 16384),
            regex(
                pattern = r"^[Hh][Tt][Tt][Pp][Ss]?://(?:[\s\S]*[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff])?$"
            )
        )]
        url: String,
        user_code: String,
    },
    Terminal {
        id: String,
        output: String,
        /// v1 non-negative integer, within the safe wire integer range.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::serde_util::safe_u64_opt"
        )]
        #[ts(optional, as = "Option<u64>")]
        #[schemars(with = "Option<u64>")]
        output_offset: Option<u64>,
    },
    Credentials {
        id: String,
        fields: Vec<ProviderCredentialField>,
    },
}
/// v1 credentials interaction field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct ProviderCredentialField {
    pub name: String,
    pub label: String,
    pub secret: bool,
}
/// v1 `ProviderAuthState.credentialOwner`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CredentialOwner {
    Provider,
    T3,
}
/// v1 `ProviderAuthState` (`provider_auth_*` results). `authorizationUrl` carries an engine `AuthRequired` URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAuthState {
    pub instance_id: ProviderInstanceId,
    pub phase: ProviderAuthPhase,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub flow_id: Option<String>,
    /// v1 `SignInUrl`: http(s) only; carries an engine `AuthRequired` URL.
    #[serde(with = "crate::serde_util::sign_in_url_opt")]
    #[ts(as = "Option<String>")]
    #[schemars(
        with = "crate::serde_util::Nullable<String>",
        length(min = 1, max = 16384),
        regex(
            pattern = r"^[Hh][Tt][Tt][Pp][Ss]?://(?:[\s\S]*[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff])?$"
        )
    )]
    pub authorization_url: Option<String>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub expires_at: Option<String>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub methods: Option<Vec<ProviderAuthMethod>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<ProviderAuthInteraction>")]
    pub interaction: Option<Option<ProviderAuthInteraction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub credential_owner: Option<CredentialOwner>,
}

/// v1 `ProviderInstallState` (`provider_install_*` results).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstallState {
    pub driver: String,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub operation_id: Option<String>,
    pub phase: ProviderInstallPhase,
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub downloaded_bytes: u64,
    #[serde(with = "crate::serde_util::safe_u64_opt")]
    #[ts(as = "Option<u64>")]
    #[schemars(with = "crate::serde_util::Nullable<u64>")]
    pub total_bytes: Option<u64>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub version: Option<String>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub installed_version: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<String>")]
    pub executable_path: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "crate::serde_util::present_nullable",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[schemars(with = "Option<ProviderInstallSource>")]
    pub source: Option<Option<ProviderInstallSource>>,
    pub can_remove: bool,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub message: Option<String>,
}

/// v1 `AcpRegistrySearchAgent`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySearchAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub license: Option<String>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub website: Option<String>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub repository: Option<String>,
    #[serde(deserialize_with = "crate::serde_util::required_nullable")]
    #[schemars(with = "crate::serde_util::Nullable<String>")]
    pub icon: Option<String>,
    pub distribution: AcpRegistryDistribution,
    pub integrity: AcpRegistryIntegrity,
}

/// v1 `AcpRegistrySearchResult` (`search_acp_registry`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistrySearchResult {
    pub agents: Vec<AcpRegistrySearchAgent>,
}

/// v1 `AcpRegistryPrepareResult` (`prepare_acp_registry_agent`); `prepared` is always `true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AcpRegistryPrepareResult {
    pub agent_id: String,
    pub version: String,
    pub distribution: AcpRegistryDistribution,
    #[serde(
        deserialize_with = "deserialize_true",
        serialize_with = "serialize_true"
    )]
    #[ts(type = "true")]
    #[schemars(schema_with = "true_schema")]
    pub prepared: bool,
}

/// One row of the `providers` frame: the v1 `ServerProvider` fields the UI needs, with the probe result
/// and any running sign-in or install flow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerProviderEntry {
    pub instance_id: ProviderInstanceId,
    pub driver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_name: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub acp_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub setup: Option<ProviderSetup>,
    pub capabilities: ProviderCapabilities,
    pub probe: ProviderProbeResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub auth_flow: Option<ProviderAuthState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub install: Option<ProviderInstallState>,
}

fn deserialize_true<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    use serde::de::Error;
    if bool::deserialize(d)? {
        Ok(true)
    } else {
        Err(D::Error::custom("prepared must be true"))
    }
}
fn serialize_true<S: serde::Serializer>(v: &bool, s: S) -> Result<S::Ok, S::Error> {
    use serde::ser::Error;
    if *v {
        s.serialize_bool(true)
    } else {
        Err(S::Error::custom("prepared must be true"))
    }
}
fn true_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "const": true })
}
