//! Token usage lifted from v1 providerRuntime.ts:260-284.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageCost {
    #[ts(type = "number")]
    #[schemars(with = "f64")]
    pub amount: serde_json::Number,
    #[serde(with = "crate::serde_util::currency")]
    #[ts(as = "String")]
    #[schemars(with = "String")]
    #[schemars(
        length(min = 1, max = 32),
        regex(
            pattern = r"^[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff](?:[\s\S]*[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff])?$"
        )
    )]
    pub currency: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTokenUsageSnapshot {
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub used_tokens: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub total_processed_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::positive_safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>", range(min = 1))]
    pub max_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub input_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub cached_input_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub output_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub reasoning_output_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub last_used_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub last_input_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub last_cached_input_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub last_output_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub last_reasoning_output_tokens: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub tool_uses: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>")]
    pub duration_ms: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::positive_safe_u64_opt "
    )]
    #[ts(as = "Option<u64>", optional)]
    #[schemars(with = "Option<u64>", range(min = 1))]
    pub auto_compact_threshold: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub compacts_automatically: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost: Option<TokenUsageCost>,
}
