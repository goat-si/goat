//! Bots. Host-owned, stored as `<dataDir>/bots/<botId>.json`; the main bot GOAT exists from
//! first start. Each bot owns one `bot` thread.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{BotId, ThreadId};
use crate::model::ModelSelection;

/// A bot's face, drawn by `packages/bot-face`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BotFace {
    pub shape: String,
    pub color: String,
    /// The GOAT mark instead of a generated face.
    pub goat: bool,
}

/// `main` is the GOAT bot; every other bot is a `member`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BotRole {
    Main,
    Member,
}

/// `bots/<botId>.json` and the `bot_changed` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BotProfile {
    pub bot_id: BotId,
    pub name: String,
    pub purpose: String,
    pub face: BotFace,
    pub role: BotRole,
    /// The bot's own `bot` thread (v1 `sessionThreadId`).
    pub session_thread_id: ThreadId,
    /// v1 `defaultModelSelection`.
    pub default_model_selection: ModelSelection,
    /// v1 `BotInstructions`: at most 16384 characters and UTF-8 bytes (bytes checked by serde only).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::serde_util::instructions"
    )]
    #[ts(optional, as = "Option<String>")]
    #[schemars(with = "Option<String>", length(max = 16384))]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelBotNote {
    pub index: u32,
    pub date: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replaces: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replaced_by: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelListBotNotesResult {
    pub revision: Option<String>,
    pub notes: Vec<ChannelBotNote>,
    pub truncated: bool,
}
