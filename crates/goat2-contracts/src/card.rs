//! `ThreadCard`: the only thing the host reads at startup (`card.json`, `cards.sqlite`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{BotId, Epoch, ItemId, ProjectId, ProviderInstanceId, ThreadId};
use crate::limits::{CARD_EXCERPT_MAX_CHARS, CARD_TITLE_MAX_CHARS, NEEDS_YOU_SUMMARY_MAX_CHARS};
use crate::log::Fold;
use crate::model::{ModelSelection, RuntimeMode};

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

/// The provider behind an engine, as v1 `ProviderDriverKind` values (goat
/// `apps/web/src/components/settings/providerDriverMeta.ts`). It names the provider, not the
/// transport, so moving a provider between driver crates never changes persisted lines. Registry
/// agents are `acpRegistry` plus the agent id. Cloud kinds are Part 3.
///
/// Wire: `"codex"`, `"claudeAgent"`, `"grok"`, ..., `{"acpRegistry": {"agentId": "kimi"}}`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EngineDriver {
    Codex,
    ClaudeAgent,
    Grok,
    Fx,
    Antigravity,
    Opencode,
    Cursor,
    Muse,
    Pi,
    Omo,
    AcpRegistry { agent_id: String },
}

impl EngineDriver {
    /// The v1 `ProviderDriverKind` slug (`acpRegistry` for every registry agent).
    pub fn driver_kind(&self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::ClaudeAgent => "claudeAgent",
            Self::Grok => "grok",
            Self::Fx => "fx",
            Self::Antigravity => "antigravity",
            Self::Opencode => "opencode",
            Self::Cursor => "cursor",
            Self::Muse => "muse",
            Self::Pi => "pi",
            Self::Omo => "omo",
            Self::AcpRegistry { .. } => "acpRegistry",
        }
    }
}

/// Engine settings for a thread, with v1 `OrchestrationV2AppThread` field names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EngineConfig {
    pub provider_instance_id: ProviderInstanceId,
    pub model_selection: ModelSelection,
    pub runtime_mode: RuntimeMode,
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
    /// A choice among options (v1 `goat_decision_request`). Silence never approves.
    Decision,
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
    /// Start of the last answer, at most [CARD_EXCERPT_MAX_CHARS] characters (v1
    /// `latestAnswerExcerpt`).
    pub latest_answer_excerpt: String,
    pub children: ChildCounts,
    pub follow_up_mode: FollowUpMode,
    /// v1 `archivedAt`: when the thread was archived (`thread.changed {archivedAt}`), else `null`.
    /// Archived cards stay in the index.
    pub archived_at: Option<String>,
    /// RFC 3339 UTC timestamp.
    pub updated_at: String,
    /// Generation of this thread's `goat.jsonl`.
    pub epoch: Epoch,
    /// Last `goat.jsonl` seq folded into this card, at most [crate::limits::MAX_SAFE_WIRE_INTEGER].
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub applied_seq: u64,
    /// Card index global sequence, the `subscribeCards` cursor, at most
    /// [crate::limits::MAX_SAFE_WIRE_INTEGER].
    #[serde(with = "crate::serde_util::safe_u64")]
    #[ts(as = "u64")]
    #[schemars(with = "u64")]
    pub card_seq: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    #[ts(as = "Option<u32>", optional)]
    pub open_asks: u32,
    #[serde(default, skip_serializing_if = "is_false")]
    #[ts(as = "Option<bool>", optional)]
    pub unread: bool,
}

/// `threads/<threadId>/card.json`: `{"v":1,"card":ThreadCard,"fold":Fold}`, replaced atomically.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CardFile {
    pub v: u32,
    pub card: ThreadCard,
    pub fold: Fold,
}

impl CardFile {
    pub fn new(card: ThreadCard, fold: Fold) -> Self {
        Self {
            v: crate::limits::CARD_FILE_FORMAT_VERSION,
            card,
            fold,
        }
    }
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
        check_chars(
            "latestAnswerExcerpt",
            &self.latest_answer_excerpt,
            CARD_EXCERPT_MAX_CHARS,
        )?;
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

fn is_zero(v: &u32) -> bool {
    *v == 0
}
fn is_false(v: &bool) -> bool {
    !*v
}
