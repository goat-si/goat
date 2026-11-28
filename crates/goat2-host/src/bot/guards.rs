//! Receipt guards for a person's message to a bot (PRD bot-reply.md, part2 done criterion 3).
//!
//! Every message a person sends a bot gets one receipt: the bot's own `goat_send_to_user` ack or
//! result (`session`), else at 20 s a host progress line (`fallback`) unless the session is
//! already composing its answer, else at 55 s the fixed line (`fixed`). A run that ends with a
//! final answer but no `result` sends that answer as the result.
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc1b2):
//! - `channels/ChannelSessionFirst.ts:59-62` ACK_MS 20_000, FIXED_LINE_MS 55_000,
//!   CHECK_INTERVAL_MS 5_000; check() skips a session that is answering or composing; one
//!   receipt per message (commit only while no receipt is committed); from 55 s the fixed line
//!   owns the receipt.
//! - `channels/channelSessionProgress.ts` sessionProgress (answering / composing / working with
//!   the last 3 steps of 120 chars / queued) and workStep wording.
//! - `channels/channelCopy.ts:10` sessionWorking, verbatim.
//! - `channels/channelSessionReceipt.ts` sessionFinalText: a final answer that repeats the
//!   session's first line sends only what follows.
//!
//! Adapted: v1's 20 s line is written by the reception model from progressSummary; GOAT 2 has
//! no reception model, so the host writes the line from the same progress facts. Not carried:
//! deadlines across a restart (quitting the app ends the work, PART1 fixed decision).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use goat2_contracts::{
    AssistantMessagePhase, InputId, LogEvent, NotificationSource, NotifyKind, RunId, ThreadId,
    TurnItemBody, UserNotified,
};

use crate::core::Host;

/// v1 CHANNEL_COPY.sessionWorking.
pub const SESSION_WORKING: &str = "Working on it — I'll reply here.";
const STEP_CHARS: usize = 120;
const STEPS_TOLD: usize = 3;

/// Guard timers; [Default] is v1's values, tests shrink them.
#[derive(Debug, Clone)]
pub struct GuardOptions {
    pub ack_after: Duration,
    pub fixed_after: Duration,
    pub check_every: Duration,
}

impl Default for GuardOptions {
    fn default() -> Self {
        Self {
            ack_after: Duration::from_millis(20_000),
            fixed_after: Duration::from_millis(55_000),
            check_every: Duration::from_millis(5_000),
        }
    }
}

/// Who wrote a receipt (v1 commit source).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Session,
    Fallback,
    Fixed,
}

impl Source {
    /// `UserNotified.source`.
    pub fn wire(self) -> NotificationSource {
        match self {
            Self::Session => NotificationSource::Session,
            Self::Fallback => NotificationSource::Fallback,
            Self::Fixed => NotificationSource::Fixed,
        }
    }
}

#[derive(Debug, Clone)]
struct Pending {
    thread: ThreadId,
    accepted: Instant,
    run: Option<RunId>,
    receipt: Option<Source>,
}

/// What a bot run owes: the person's messages it carries and which got their result.
#[derive(Debug, Clone, Default)]
struct RunState {
    inputs: Vec<InputId>,
    answered: Vec<InputId>,
    results: usize,
    acks: usize,
    /// The session's last ack line (sessionFinalText).
    ack: Option<String>,
}

/// Per-host guard state.
#[derive(Debug, Default)]
pub struct Guards {
    pending: HashMap<InputId, Pending>,
    runs: HashMap<RunId, RunState>,
}

/// v1 sessionProgress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    Answering,
    Composing,
    Working(Vec<String>),
    Queued,
}

/// v1 workStep: a finished item that is work toward the answer, in words.
pub fn work_step(body: &TurnItemBody) -> Option<String> {
    let step = match body {
        TurnItemBody::CommandExecution { input, .. } => format!("ran {input}"),
        TurnItemBody::DynamicTool {
            tool_name, input, ..
        } => {
            let name = tool_name.as_deref().unwrap_or("a tool");
            if name.ends_with("send_to_user") {
                return None;
            }
            let path = input
                .get("path")
                .and_then(|p| p.as_str())
                .map(|p| format!(" {p}"))
                .unwrap_or_default();
            format!("called {name}{path}")
        }
        TurnItemBody::WebSearch { patterns, .. } => match patterns {
            Some(p) if !p.is_empty() => format!("searched the web for {}", p.join(", ")),
            _ => "searched the web".to_owned(),
        },
        TurnItemBody::FileChange { .. } => "prepared a file change".to_owned(),
        TurnItemBody::Subagent { prompt, .. } => format!("asked a helper: {prompt}"),
        _ => return None,
    };
    Some(step.chars().take(STEP_CHARS).collect())
}

/// The 20 s line for a session that has not replied itself (v1 progressSummary, written for the
/// person instead of for a reception model).
pub fn progress_line(progress: &Progress) -> Option<String> {
    match progress {
        Progress::Answering | Progress::Composing => None,
        Progress::Working(steps) => Some(format!("Still on it. So far I {}.", steps.join("; "))),
        Progress::Queued => Some(
            "Got your message. I'll start on it as soon as I finish the one before it.".to_owned(),
        ),
    }
}

/// v1 sessionFinalText: a final message that opens with the ack line sends only what follows.
pub fn final_text(ack: Option<&str>, text: &str) -> String {
    let final_ = text.trim();
    match ack.map(str::trim) {
        Some(line)
            if !line.is_empty()
                && final_.starts_with(line)
                && (final_ == line
                    || (line.ends_with(['.', '!', '?', '…', '。', '！', '？'])
                        && final_[line.len()..].starts_with(char::is_whitespace))) =>
        {
            final_[line.len()..].trim().to_owned()
        }
        _ => final_.to_owned(),
    }
}

fn progress(host: &Host, p: &Pending) -> Progress {
    let Some(run) = &p.run else {
        return Progress::Queued;
    };
    if host.is_streaming(&p.thread) {
        return Progress::Composing;
    }
    let store = host.store();
    let last = store.last_seq(&p.thread).unwrap_or(0);
    let lines = store
        .read_page(&p.thread, last + 1, 400)
        .map(|(l, _)| l)
        .unwrap_or_default();
    let mut steps = Vec::new();
    for line in lines {
        let LogEvent::ItemCompleted(done) = line.event else {
            continue;
        };
        if &done.run_id != run || done.item.parent_item_id.is_some() {
            continue;
        }
        match &done.item.body {
            TurnItemBody::AssistantMessage { phase, .. }
                if !matches!(phase, Some(AssistantMessagePhase::Commentary)) =>
            {
                return Progress::Answering;
            }
            body => steps.extend(work_step(body)),
        }
    }
    if steps.is_empty() {
        return Progress::Composing;
    }
    let skip = steps.len().saturating_sub(STEPS_TOLD);
    Progress::Working(steps.split_off(skip))
}

/// A person's message to a bot was accepted: start its guard.
pub(crate) fn watch(host: &Host, thread: &ThreadId, input: &InputId) {
    host.inner
        .bot
        .guards
        .lock()
        .expect("guards")
        .pending
        .insert(
            input.clone(),
            Pending {
                thread: thread.clone(),
                accepted: Instant::now(),
                run: None,
                receipt: None,
            },
        );
    let host = host.clone();
    let input = input.clone();
    let tracker = host.clone();
    let task = tokio::spawn(async move { run_guard(host, input).await });
    tracker.track(&task);
}

async fn run_guard(host: Host, input: InputId) {
    let opts = host.options().bot_guards.clone();
    let Some(accepted) = pending_of(&host, &input).map(|p| p.accepted) else {
        return;
    };
    tokio::time::sleep_until((accepted + opts.ack_after).into()).await;
    loop {
        let now = Instant::now();
        if now >= accepted + opts.fixed_after {
            break;
        }
        match check(&host, &input).await {
            Checked::Done => return,
            Checked::Later => {}
        }
        let next = (Instant::now() + opts.check_every).min(accepted + opts.fixed_after);
        tokio::time::sleep_until(next.into()).await;
    }
    fixed(&host, &input).await;
}

fn pending_of(host: &Host, input: &InputId) -> Option<Pending> {
    host.inner
        .bot
        .guards
        .lock()
        .expect("guards")
        .pending
        .get(input)
        .cloned()
}

enum Checked {
    Done,
    Later,
}

/// Write a host receipt for every still-unanswered input of the same run (one line per run).
fn commit(host: &Host, p: &Pending, input: &InputId, source: Source, text: String) {
    let run_id = p.run.clone();
    let event = LogEvent::UserNotified(UserNotified {
        run_id: run_id.clone(),
        kind: NotifyKind::Ack,
        text,
        source: Some(source.wire()),
    });
    if let Err(err) = host.append(&p.thread, vec![event]) {
        tracing::warn!(thread = %p.thread, %err, "bot receipt not written");
        return;
    }
    let mut guards = host.inner.bot.guards.lock().expect("guards");
    for (id, other) in guards.pending.iter_mut() {
        if id == input || (run_id.is_some() && other.run == run_id && other.receipt.is_none()) {
            other.receipt = Some(source);
        }
    }
}

async fn check(host: &Host, input: &InputId) -> Checked {
    let Some(p) = pending_of(host, input) else {
        return Checked::Done;
    };
    if p.receipt.is_some() {
        return Checked::Done;
    }
    let fence = host.fence_lock(&p.thread);
    let _fenced = fence.lock().await;
    let Some(p) = pending_of(host, input) else {
        return Checked::Done;
    };
    if p.receipt.is_some() {
        return Checked::Done;
    }
    match progress_line(&progress(host, &p)) {
        Some(text) => {
            commit(host, &p, input, Source::Fallback, text);
            Checked::Done
        }
        None => Checked::Later,
    }
}

async fn fixed(host: &Host, input: &InputId) {
    let Some(p) = pending_of(host, input) else {
        return;
    };
    let fence = host.fence_lock(&p.thread);
    let _fenced = fence.lock().await;
    if let Some(p) = pending_of(host, input)
        && p.receipt.is_none()
    {
        commit(host, &p, input, Source::Fixed, SESSION_WORKING.to_owned());
    }
}

/// The inputs a run carries (start or accepted steer).
pub(crate) fn bind(host: &Host, run: &RunId, inputs: &[InputId]) {
    let mut guards = host.inner.bot.guards.lock().expect("guards");
    let mut bound = Vec::new();
    for id in inputs {
        if let Some(p) = guards.pending.get_mut(id) {
            p.run = Some(run.clone());
            bound.push(id.clone());
        }
    }
    guards
        .runs
        .entry(run.clone())
        .or_default()
        .inputs
        .extend(bound);
}

/// Whether `goat_send_to_user` may send `kind` for a bot run now (under the fence). A bot run
/// can carry several messages (steered in), so the Part 1 "once per run per kind" becomes once
/// per message: an ack while a message of the run has no receipt, a result while one has no
/// result. A run with no person's message (a worker's wake) sends each kind once.
pub(crate) fn may_send(host: &Host, run: &RunId, kind: NotifyKind) -> bool {
    let guards = host.inner.bot.guards.lock().expect("guards");
    let state = guards.runs.get(run).cloned().unwrap_or_default();
    if state.inputs.is_empty() {
        return match kind {
            NotifyKind::Ack => state.acks == 0,
            NotifyKind::Result => state.results == 0,
        };
    }
    match kind {
        NotifyKind::Ack => state
            .inputs
            .iter()
            .any(|i| guards.pending.get(i).is_some_and(|p| p.receipt.is_none())),
        NotifyKind::Result => state.inputs.iter().any(|i| !state.answered.contains(i)),
    }
}

/// The session sent a line for `run` (under the fence, after it was written).
pub(crate) fn sent(host: &Host, run: &RunId, kind: NotifyKind, text: &str) {
    let mut guards = host.inner.bot.guards.lock().expect("guards");
    let state = guards.runs.entry(run.clone()).or_default();
    let inputs = state.inputs.clone();
    match kind {
        NotifyKind::Ack => {
            state.acks += 1;
            state.ack = Some(text.to_owned());
        }
        NotifyKind::Result => {
            state.results += 1;
            state.answered = inputs.clone();
        }
    }
    for id in &inputs {
        if let Some(p) = guards.pending.get_mut(id)
            && p.receipt.is_none()
        {
            p.receipt = Some(Source::Session);
        }
    }
}

/// A bot run ended (inside finish_run, under the fence, after `run.finished`): a final answer
/// still owed to a message of the run is sent as its result; the run's guards end.
pub(crate) fn run_finished(host: &Host, thread: &ThreadId, run: &RunId, last_answer: &str) {
    let state = {
        let mut guards = host.inner.bot.guards.lock().expect("guards");
        guards.pending.retain(|_, p| p.run.as_ref() != Some(run));
        guards.runs.remove(run).unwrap_or_default()
    };
    let owed = if state.inputs.is_empty() {
        state.results == 0
    } else {
        state.inputs.iter().any(|i| !state.answered.contains(i))
    };
    if !owed {
        return;
    }
    let text = final_text(state.ack.as_deref(), last_answer);
    if text.is_empty() {
        return;
    }
    if let Err(err) = host.append(
        thread,
        vec![LogEvent::UserNotified(UserNotified {
            run_id: Some(run.clone()),
            kind: NotifyKind::Result,
            text,
            // The bot's own final answer (v1 commit source "session").
            source: Some(NotificationSource::Session),
        })],
    ) {
        tracing::warn!(%thread, %err, "bot result not written");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_text_drops_a_repeated_ack() {
        assert_eq!(
            final_text(Some("Checking the tests."), "Checking the tests. All pass."),
            "All pass."
        );
        assert_eq!(
            final_text(Some("Checking"), "Checking-in done"),
            "Checking-in done"
        );
        assert_eq!(final_text(None, "  done "), "done");
        assert_eq!(final_text(Some("Done."), "Done."), "");
    }

    #[test]
    fn progress_lines() {
        assert_eq!(progress_line(&Progress::Composing), None);
        assert_eq!(progress_line(&Progress::Answering), None);
        assert_eq!(
            progress_line(&Progress::Working(vec!["ran cargo test".into()])).unwrap(),
            "Still on it. So far I ran cargo test."
        );
        assert!(
            progress_line(&Progress::Queued)
                .unwrap()
                .contains("finish the one before")
        );
    }
}
