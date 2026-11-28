//! Bots on the host (PRD part2/bot.md): registry and main bot, the session brief and its
//! rotation, receipt guards for a person's messages, decisions and multi-question asks, bot
//! notes. The core calls in through the single-call hooks below (boundary agreed with lane E).

pub mod asks;
pub mod brief;
pub mod guards;
pub mod mcp;
pub mod notes;
pub mod registry;

use std::sync::Mutex;

use goat2_contracts::{
    BotProfile, EngineRef, InputId, InputMode, InputSource, RunId, ThreadCard, ThreadId, ThreadKind,
};

use crate::core::Host;
use crate::engine::EngineInput;

/// Bot state the host keeps in memory.
#[derive(Debug, Default)]
pub struct BotState {
    pub(crate) guards: Mutex<guards::Guards>,
}

/// Whether the host's engine can steer a message into a running turn. The Part 1 host runs one
/// factory, Codex (v1 `CodexCapabilities.ts` supportsActiveSteering: true); from lane C step 1
/// this reads `EngineFactory::capabilities().supports_active_steering`.
pub(crate) fn engine_steers(host: &Host) -> bool {
    host.options().bot_steering
}

/// Hook (accept): the mode of a person's message to a bot. GOAT 2 decision (owner 2026-11-28):
/// v1 queues a message behind the bot's running turn; GOAT 2 steers it into the turn when the
/// engine can, so the bot sees it at once, and queues it as a followup only for engines without
/// steering. The bot chat sends followup (the bot thread's mode) or steer; an explicit interrupt
/// or collect is kept.
pub(crate) fn input_mode(
    host: &Host,
    card: &ThreadCard,
    from: &InputSource,
    requested: Option<InputMode>,
) -> Option<InputMode> {
    if card.kind != ThreadKind::Bot || !matches!(from, InputSource::User) {
        return requested;
    }
    match requested {
        None | Some(InputMode::Followup | InputMode::Steer) => Some(if engine_steers(host) {
            InputMode::Steer
        } else {
            InputMode::Followup
        }),
        other => other,
    }
}

/// Hook (accept, after the input is on disk): a person's message to a bot starts its guard.
pub(crate) fn input_accepted(host: &Host, card: &ThreadCard, input: &InputId, from: &InputSource) {
    if card.kind == ThreadKind::Bot && matches!(from, InputSource::User) {
        guards::watch(host, &card.id, input);
    }
}

/// Hook (run accepted by the engine, or a steer accepted): the person's messages it carries.
pub(crate) fn inputs_bound(host: &Host, run: &RunId, inputs: &[InputId]) {
    guards::bind(host, run, inputs);
}

/// Hook (before an engine start or a run on a live session): why the bot's engine session must
/// be replaced first, if it must. The caller stops a live session and starts fresh (no resume).
pub(crate) fn rotation_due(
    host: &Host,
    card: &ThreadCard,
    session_ref: Option<&EngineRef>,
) -> Option<&'static str> {
    if card.kind != ThreadKind::Bot {
        return None;
    }
    let bot = registry::bot_of_thread(host, &card.id)?;
    brief::rotation_reason(host, &bot, session_ref)
}

/// A brief waiting for the first turn of a new bot session.
#[derive(Debug, Clone)]
pub(crate) struct PendingBrief {
    bot: BotProfile,
    record: brief::SessionRecord,
}

/// Hook (first turn of a new engine session of a bot thread): put the frozen brief in front of
/// the first message, as v1 sends its frozen prefix as the session's first message. Returns
/// what [brief_taken] records once the engine accepted the turn.
pub(crate) fn apply_brief(
    host: &Host,
    thread: &ThreadId,
    engine_ref: &EngineRef,
    inputs: &mut [EngineInput],
) -> Option<PendingBrief> {
    let bot = registry::bot_of_thread(host, thread)?;
    let ids: Vec<InputId> = inputs.iter().map(|i| i.input_id.clone()).collect();
    let first = inputs.first_mut()?;
    let (prefix, mut record) = brief::build(host, &bot, &first.text, &ids);
    record.engine_ref = Some(engine_ref.clone());
    first.text = prefix;
    Some(PendingBrief { bot, record })
}

/// Hook: the engine accepted the briefed turn; later starts resume this session.
pub(crate) fn brief_taken(host: &Host, pending: PendingBrief) {
    if let Err(err) = brief::write_record(host, &pending.bot, &pending.record) {
        tracing::warn!(bot = %pending.bot.bot_id, %err, "bot session record not written");
    }
}

/// Hook (finish_run, under the run fence, after `run.finished`).
pub(crate) fn run_finished(
    host: &Host,
    card_kind: ThreadKind,
    thread: &ThreadId,
    run: &RunId,
    last_answer: &str,
) {
    if card_kind == ThreadKind::Bot {
        guards::run_finished(host, thread, run, last_answer);
    }
}
