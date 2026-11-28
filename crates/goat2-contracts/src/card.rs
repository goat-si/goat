//! `ThreadCard`: the only thing the host reads at startup (`card.json`, `cards.sqlite`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{BotId, Epoch, ItemId, ProjectId, ThreadId};
use crate::limits::{CARD_EXCERPT_MAX_CHARS, CARD_TITLE_MAX_CHARS, NEEDS_YOU_SUMMARY_MAX_CHARS};

/// Who created the thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadKind {
    /// One per bot, forever.
    Bot,
    /// Started by a parent thread through MCP `thread.start`.
    Worker,
    /// Started by a person.
    User,
}

/// Parent link, written on the child (`parent: {threadId, byItemId}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ParentRef {
    pub thread_id: ThreadId,
    /// The parent's tool-call item that started this child.
    pub by_item_id: ItemId,
}

/// Engine drivers. Part 1 ships Codex only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EngineDriver {
    Codex,
}

/// Engine settings for a thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    pub driver: EngineDriver,
    pub model: String,
    pub runtime_mode: String,
    pub cwd: String,
}

/// Last seen engine session pointer (Codex threadId). Not the thread's identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EngineRef {
    pub driver: EngineDriver,
    pub id: String,
}

/// Card status shown in lists and the inbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadStatus {
    Idle,
    Queued,
    Running,
    NeedsYou,
    Failed,
}

/// What kind of human step a request needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RequestKind {
    Approval,
    Question,
    Signin,
    /// A run settled as `unknown` waits for a person to choose resend or drop.
    Resend,
}

/// The open human request summarised on the card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NeedsYou {
    pub kind: RequestKind,
    /// At most [NEEDS_YOU_SUMMARY_MAX_CHARS] characters.
    pub summary: String,
}

/// Child counts for a parent card.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChildCounts {
    pub running: u32,
    pub total: u32,
}

/// How a message sent while a run is active is handled by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FollowUpMode {
    /// Mix into the current run at the next tool/model boundary (human and worker threads).
    Steer,
    /// Start a new run after the current one, one by one (bot threads).
    Followup,
    /// Merge inputs that arrive within [crate::limits::COLLECT_WINDOW_MS] into the next run.
    Collect,
}

/// One row per thread. Every text field is bounded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadCard {
    pub id: ThreadId,
    pub kind: ThreadKind,
    /// At most [CARD_TITLE_MAX_CHARS] characters.
    pub title: String,
    /// Card index column for lookups by project.
    pub project_id: Option<ProjectId>,
    pub bot_id: Option<BotId>,
    pub parent: Option<ParentRef>,
    pub engine: EngineConfig,
    pub engine_ref: Option<EngineRef>,
    pub status: ThreadStatus,
    pub needs_you: Option<NeedsYou>,
    /// Start of the last answer, at most [CARD_EXCERPT_MAX_CHARS] characters.
    pub last_excerpt: String,
    pub children: ChildCounts,
    pub follow_up_mode: FollowUpMode,
    /// Set by `thread.changed {archived}`. Archived cards stay in the index.
    #[serde(default, skip_serializing_if = "is_false")]
    pub archived: bool,
    /// RFC 3339 UTC timestamp.
    pub updated_at: String,
    /// Generation of this thread's `goat.jsonl`.
    pub epoch: Epoch,
    /// Last `goat.jsonl` seq folded into this card.
    pub applied_seq: u64,
    /// Card index global sequence, the `subscribeCards` cursor.
    pub card_seq: u64,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A text field above its bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitViolation {
    pub field: &'static str,
    pub max: usize,
    pub actual: usize,
}

impl std::fmt::Display for LimitViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} has {} characters, limit {}",
            self.field, self.actual, self.max
        )
    }
}

impl std::error::Error for LimitViolation {}

fn check_chars(field: &'static str, value: &str, max: usize) -> Result<(), LimitViolation> {
    let actual = value.chars().count();
    if actual > max {
        Err(LimitViolation { field, max, actual })
    } else {
        Ok(())
    }
}

impl ThreadCard {
    /// Check every bounded text field. Writers clamp with [crate::text::clamp_chars] first.
    pub fn check_limits(&self) -> Result<(), LimitViolation> {
        check_chars("title", &self.title, CARD_TITLE_MAX_CHARS)?;
        check_chars("lastExcerpt", &self.last_excerpt, CARD_EXCERPT_MAX_CHARS)?;
        if let Some(needs_you) = &self.needs_you {
            check_chars(
                "needsYou.summary",
                &needs_you.summary,
                NEEDS_YOU_SUMMARY_MAX_CHARS,
            )?;
        }
        Ok(())
    }
}
