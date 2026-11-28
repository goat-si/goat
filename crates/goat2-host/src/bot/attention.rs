//! Read marks and `ThreadCard.unread` (contracts step 2, owner decision): `mark_read` keeps
//! `lastReadSeq` per thread in `<dataDir>/ui-state.json` (UI state, never thread history), and
//! the host derives `unread` when it serves a card: the thread's newest line not from the person
//! (an agent item, a bot message, a request) is newer than the read mark.
//!
//! GOAT 2 design (v1 keeps `lastVisitedAt` per thread instead). Writes are batched: a mark sets a
//! dirty flag and a background task rewrites the file at most every 500 ms, keeping keys it does
//! not own (pin order, visits).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use goat2_contracts::{InputSource, LogEvent, LogLine, ThreadCard, ThreadId, TurnItemBody};
use serde_json::{Map, Value};

use crate::core::Host;

const FILE: &str = "ui-state.json";
const KEY: &str = "lastReadSeq";
const SCAN_PAGE: usize = 64;
const SCAN_PAGES: usize = 4;

/// Read marks and the newest-news cache.
#[derive(Debug, Default)]
pub struct Attention {
    loaded: bool,
    /// The whole file, so keys this module does not own survive a rewrite.
    doc: Map<String, Value>,
    read: HashMap<ThreadId, u64>,
    /// Seq of the newest line not from the person, per thread (filled lazily, kept current by
    /// [noted]).
    news: HashMap<ThreadId, u64>,
    dirty: bool,
}

fn path(host: &Host) -> PathBuf {
    host.options().data_dir.join(FILE)
}

/// A line the person did not write: what makes a thread unread.
pub fn is_news(line: &LogLine) -> bool {
    match &line.event {
        LogEvent::ItemCompleted(done) => {
            !matches!(done.item.body, TurnItemBody::UserMessage { .. })
        }
        LogEvent::UserNotified(_) | LogEvent::RequestOpened(_) => true,
        LogEvent::InputAccepted(i) => !matches!(i.from, InputSource::User),
        _ => false,
    }
}

fn load(host: &Host, a: &mut Attention) {
    if a.loaded {
        return;
    }
    a.loaded = true;
    let Ok(bytes) = std::fs::read(path(host)) else {
        return;
    };
    let Ok(Value::Object(doc)) = serde_json::from_slice::<Value>(&bytes) else {
        tracing::warn!("ui-state.json is not a JSON object; read marks start empty");
        return;
    };
    if let Some(Value::Object(marks)) = doc.get(KEY) {
        for (id, seq) in marks {
            if let Some(seq) = seq.as_u64() {
                a.read.insert(ThreadId::new(id.clone()), seq);
            }
        }
    }
    a.doc = doc;
}

/// The newest news seq of a thread, from the end of its log.
fn scan_news(host: &Host, thread: &ThreadId) -> u64 {
    let store = host.store();
    let Some(mut before) = store.last_seq(thread).map(|s| s + 1) else {
        return 0;
    };
    for _ in 0..SCAN_PAGES {
        let Ok((lines, older)) = store.read_page(thread, before, SCAN_PAGE) else {
            return 0;
        };
        if let Some(line) = lines.iter().rev().find(|l| is_news(l)) {
            return line.seq;
        }
        match lines.first() {
            Some(first) if older => before = first.seq,
            _ => return 0,
        }
    }
    0
}

/// Hook (every appended batch): keep the news seq current.
pub(crate) fn noted(host: &Host, thread: &ThreadId, lines: &[LogLine]) {
    let Some(seq) = lines.iter().rev().find(|l| is_news(l)).map(|l| l.seq) else {
        return;
    };
    let mut a = host.inner.bot.attention.lock().expect("attention");
    if let Some(known) = a.news.get_mut(thread) {
        *known = (*known).max(seq);
    }
}

/// The card as the UI sees it: `unread` derived from the read mark.
pub(crate) fn serve(host: &Host, mut card: ThreadCard) -> ThreadCard {
    let mut a = host.inner.bot.attention.lock().expect("attention");
    load(host, &mut a);
    let read = a.read.get(&card.id).copied().unwrap_or(0);
    if read >= card.applied_seq {
        card.unread = false;
        return card;
    }
    let news = match a.news.get(&card.id) {
        Some(seq) => *seq,
        None => {
            let seq = scan_news(host, &card.id);
            a.news.insert(card.id.clone(), seq);
            seq
        }
    };
    card.unread = news > read;
    card
}

/// `mark_read {threadId, seq}`: the person read the thread up to `seq` (marks only move
/// forward). Returns the card to send again.
pub(crate) fn mark_read(host: &Host, thread: &ThreadId, seq: u64) -> Option<ThreadCard> {
    let card = host.store().card(thread)?;
    let last = host.store().last_seq(thread).unwrap_or(card.applied_seq);
    {
        let mut a = host.inner.bot.attention.lock().expect("attention");
        load(host, &mut a);
        let mark = a.read.entry(thread.clone()).or_insert(0);
        let next = (*mark).max(seq.min(last));
        if next != *mark {
            *mark = next;
            a.dirty = true;
        }
    }
    Some(serve(host, card))
}

/// Write the file if marks changed (atomic replace).
pub(crate) fn flush(host: &Host) -> std::io::Result<()> {
    let bytes = {
        let mut a = host.inner.bot.attention.lock().expect("attention");
        if !a.dirty {
            return Ok(());
        }
        a.dirty = false;
        let marks: Map<String, Value> = a
            .read
            .iter()
            .map(|(id, seq)| (id.to_string(), Value::from(*seq)))
            .collect();
        let mut doc = a.doc.clone();
        doc.insert(KEY.to_owned(), Value::Object(marks));
        a.doc = doc.clone();
        serde_json::to_vec_pretty(&Value::Object(doc)).map_err(std::io::Error::other)?
    };
    let target = path(host);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, target)
}

/// Start the batched writer.
pub(crate) fn start(host: &Host) {
    let h = host.clone();
    let task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        loop {
            tick.tick().await;
            let h2 = h.clone();
            match tokio::task::spawn_blocking(move || flush(&h2)).await {
                Ok(Err(err)) => {
                    tracing::warn!(%err, "ui-state.json not written");
                    h.inner.bot.attention.lock().expect("attention").dirty = true;
                }
                Err(err) => tracing::warn!(%err, "ui-state flush task failed"),
                Ok(Ok(())) => {}
            }
        }
    });
    host.track(&task);
}

/// For tests: the read marks as stored.
pub fn stored_marks(data_dir: &std::path::Path) -> HashMap<String, u64> {
    std::fs::read(data_dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get(KEY).cloned())
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
