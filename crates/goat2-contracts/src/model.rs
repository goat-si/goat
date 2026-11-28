//! Model selection, lifted from GOAT v1 (`packages/contracts/src/modelSelection.ts`, `model.ts`,
//! `providerPolicy.ts` at goat-si/goat origin/dev 916b5ccc). Wire shape only: v1's decoder also
//! accepts a legacy `provider` key and an options object, which GOAT 2 never wrote.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::ProviderInstanceId;

/// v1 `ProviderOptionSelectionValue`: a trimmed string or a boolean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(untagged)]
pub enum ProviderOptionSelectionValue {
    Text(String),
    Flag(bool),
}

/// v1 `ProviderOptionSelection`, e.g. `{id: "reasoningEffort", value: "xhigh"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOptionSelection {
    pub id: String,
    pub value: ProviderOptionSelectionValue,
}

/// v1 `ModelSelection`: provider instance, model and model options.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub instance_id: ProviderInstanceId,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub options: Option<Vec<ProviderOptionSelection>>,
}

/// v1 `RuntimeMode` (`providerPolicy.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    ApprovalRequired,
    AutoAcceptEdits,
    Auto,
    FullAccess,
}
