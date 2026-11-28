//! The bot's own MCP paths: its notes (PRD part2/bot.md 6, injection.md).
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc1b2) `agentSurface/entries/channel.ts`
//! `channel.notes_change` (save a note a person's message asked for; a correction replaces an
//! earlier note) and `channels/channelBotNotesRecall.ts` (what a read shows). Adapted: GOAT 2
//! names the paths `bot.notes_read` / `bot.notes_change` (no channels in Part 2); a retry with
//! the same clientRequestId saves nothing twice (v1 keys a note by its input id).

use serde_json::json;
use tokio::sync::Mutex;

use super::notes::{self, Saved};
use super::registry::bot_of_thread;
use crate::api::{BotNotesChangeArgs, BotNotesReadArgs, Caller, ErrorCode, SurfaceResult};
use crate::core::Host;

/// One writer at a time per host for notes files (notes::append's caller lock).
pub(crate) static NOTES_LOCK: Mutex<()> = Mutex::const_new(());

fn not_a_bot() -> SurfaceResult {
    SurfaceResult::err(
        ErrorCode::PermissionDenied,
        "not_a_bot",
        "only a bot's own session reads and changes its notes",
        false,
    )
}

pub(crate) async fn notes_read(
    host: &Host,
    caller: &Caller,
    args: BotNotesReadArgs,
) -> SurfaceResult {
    let Some(bot) = bot_of_thread(host, &caller.thread_id) else {
        return not_a_bot();
    };
    let path = notes::notes_path(&host.options().data_dir, bot.bot_id.as_str());
    let query = args.query.unwrap_or_default();
    match tokio::task::spawn_blocking(move || notes::snapshot(&path, &query)).await {
        Ok(Ok(snap)) => SurfaceResult::ok(json!({
            "notes": snap.section(),
            "standing": snap.standing,
            "matched": snap.matched,
            "revision": snap.revision,
            "rule": notes::NOTES_REPLACED_RULE,
        })),
        Ok(Err(e)) => SurfaceResult::err(
            ErrorCode::Unavailable,
            "notes_unreadable",
            e.to_string(),
            true,
        ),
        Err(e) => SurfaceResult::err(ErrorCode::Internal, "internal", e.to_string(), false),
    }
}

pub(crate) async fn notes_change(
    host: &Host,
    caller: &Caller,
    args: BotNotesChangeArgs,
) -> SurfaceResult {
    let Some(bot) = bot_of_thread(host, &caller.thread_id) else {
        return not_a_bot();
    };
    let path = notes::notes_path(&host.options().data_dir, bot.bot_id.as_str());
    let day = crate::util::now_rfc3339();
    let source = args
        .client_request_id
        .as_deref()
        .map(|k| crate::util::stable_id(&[caller.thread_id.as_str(), "bot.notes_change", k]));
    let _writer = NOTES_LOCK.lock().await;
    let saved = tokio::task::spawn_blocking(move || {
        notes::append(
            &path,
            &args.note,
            &day,
            source.as_deref(),
            args.replaces.as_deref(),
        )
    })
    .await;
    match saved {
        Ok(Ok(Saved::Wrote { line, correction })) => SurfaceResult::ok(json!({
            "saved": true,
            "line": line,
            "correction": correction,
            "next": "Saved. It is in your notes from your next session on.",
        })),
        Ok(Ok(Saved::Unchanged { reason, alike })) => SurfaceResult::ok(json!({
            "saved": false,
            "reason": reason,
            "alike": alike,
        })),
        Ok(Err(e)) => SurfaceResult::err(
            ErrorCode::Unavailable,
            "notes_unwritable",
            e.to_string(),
            true,
        ),
        Err(e) => SurfaceResult::err(ErrorCode::Internal, "internal", e.to_string(), false),
    }
}
