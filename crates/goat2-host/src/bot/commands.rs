//! Bot commands from the UI (contracts step 2): `update_bot`, `list_bot_notes`,
//! `write_bot_notes`, `mark_read`, `get_turn_item`. The core's command handler (dedupe by
//! clientRequestId) calls in here.

use std::sync::Arc;

use goat2_contracts::{BotFace, BotId, ItemId, ModelSelection, ThreadId};

use super::{attention, details, mcp::NOTES_LOCK, notes, registry};
use crate::api::{CardUpdate, CommandReply, CommandValue, Reason, command_error};
use crate::core::Host;

/// `update_bot` fields (None = unchanged; `instructions: Some("")` clears them).
pub(crate) struct BotChange {
    pub name: Option<String>,
    pub purpose: Option<String>,
    pub face: Option<BotFace>,
    pub default_model_selection: Option<ModelSelection>,
    pub instructions: Option<String>,
}

pub(crate) fn update_bot(host: &Host, bot_id: &BotId, change: BotChange) -> CommandReply {
    if !registry::instructions_fit(change.instructions.as_deref()) {
        return Err(command_error(
            Reason::InvalidRequest,
            "bot instructions must fit in 16384 UTF-8 bytes",
        ));
    }
    if change.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Err(command_error(Reason::InvalidRequest, "a bot needs a name"));
    }
    let model = change.default_model_selection.clone();
    let updated = registry::update_bot(host, bot_id, |b| {
        if let Some(name) = change.name {
            b.name = name;
        }
        if let Some(purpose) = change.purpose {
            b.purpose = purpose;
        }
        if let Some(face) = change.face {
            b.face = face;
        }
        if let Some(selection) = change.default_model_selection {
            b.default_model_selection = selection;
        }
        if let Some(text) = change.instructions {
            b.instructions = (!text.trim().is_empty()).then_some(text);
        }
    })
    .map_err(|e| command_error(Reason::Internal, e.to_string()))?
    .ok_or_else(|| command_error(Reason::BotNotFound, "bot not found"))?;
    // The bot's own thread runs the new default model from its next run.
    if let Some(selection) = model {
        host.append(
            &updated.session_thread_id,
            vec![goat2_contracts::LogEvent::ThreadChanged(
                goat2_contracts::ThreadChanged {
                    model_selection: Some(selection),
                    ..Default::default()
                },
            )],
        )
        .map_err(|e| command_error(Reason::Internal, e.to_string()))?;
    }
    Ok(CommandValue {
        bot_id: Some(updated.bot_id.clone()),
        thread_id: Some(updated.session_thread_id.clone()),
        bot: Some(updated),
        ..Default::default()
    })
}

fn notes_path(host: &Host, bot_id: &BotId) -> Result<std::path::PathBuf, crate::api::CommandError> {
    host.bot(bot_id)
        .ok_or_else(|| command_error(Reason::BotNotFound, "bot not found"))?;
    Ok(notes::notes_path(&host.options().data_dir, bot_id.as_str()))
}

pub(crate) async fn list_bot_notes(host: &Host, bot_id: &BotId) -> CommandReply {
    let path = notes_path(host, bot_id)?;
    let listed = tokio::task::spawn_blocking(move || notes::list(&path))
        .await
        .map_err(|e| command_error(Reason::Internal, e.to_string()))?
        .map_err(|e| command_error(Reason::Internal, e.to_string()))?;
    Ok(CommandValue {
        bot_id: Some(bot_id.clone()),
        notes: Some(listed),
        ..Default::default()
    })
}

pub(crate) async fn write_bot_notes(
    host: &Host,
    bot_id: &BotId,
    text: String,
    expected_revision: Option<String>,
) -> CommandReply {
    let path = notes_path(host, bot_id)?;
    let _writer = NOTES_LOCK.lock().await;
    let p = path.clone();
    let written =
        tokio::task::spawn_blocking(move || notes::write(&p, &text, expected_revision.as_deref()))
            .await
            .map_err(|e| command_error(Reason::Internal, e.to_string()))?;
    match written {
        Ok(()) => {}
        Err(notes::WriteError::Changed) => {
            return Err(command_error(
                Reason::NotesChanged,
                "the notes changed since you opened them; reload and edit again",
            ));
        }
        Err(notes::WriteError::TooLarge) => {
            return Err(command_error(
                Reason::PayloadTooLarge,
                "notes are larger than 256 KiB",
            ));
        }
        Err(notes::WriteError::Io(e)) => {
            return Err(command_error(Reason::Internal, e.to_string()));
        }
    }
    let listed = tokio::task::spawn_blocking(move || notes::list(&path))
        .await
        .map_err(|e| command_error(Reason::Internal, e.to_string()))?
        .map_err(|e| command_error(Reason::Internal, e.to_string()))?;
    Ok(CommandValue {
        bot_id: Some(bot_id.clone()),
        notes: Some(listed),
        ..Default::default()
    })
}

pub(crate) fn mark_read(host: &Host, thread: &ThreadId, seq: u64) -> CommandReply {
    let card = attention::mark_read(host, thread, seq)
        .ok_or_else(|| command_error(Reason::ThreadNotFound, "thread not found"))?;
    let _ = host
        .inner
        .cards_tx
        .send(CardUpdate::Refreshed(Arc::new(card)));
    Ok(CommandValue {
        thread_id: Some(thread.clone()),
        ..Default::default()
    })
}

pub(crate) async fn get_turn_item(host: &Host, thread: &ThreadId, item: &ItemId) -> CommandReply {
    let item = details::get_turn_item(host, thread, item).await?;
    Ok(CommandValue {
        thread_id: Some(thread.clone()),
        turn_item: Some(item),
        ..Default::default()
    })
}
