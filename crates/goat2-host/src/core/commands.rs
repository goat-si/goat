//! UI commands (`ClientFrame` command variants) and the [WsHost] implementation.

use std::sync::Arc;

use async_trait::async_trait;
use goat2_contracts::limits::BLOB_THRESHOLD_BYTES;
use goat2_contracts::{
    BotFace, BotId, BotProfile, BotRole, ChildStarted, EngineChoice, EngineConfig, EngineDriver,
    FollowUpMode, InputSource, ItemId, LogEvent, ParentRef, ThreadCard, ThreadChanged,
    ThreadCreated, ThreadId, ThreadKind, ThreadStatus,
};
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

use super::Host;
use super::actor::{InputAck, Msg, NewInput, QueueEdit, Refusal, Resolution};
use crate::api::{
    CardUpdate, Command, CommandErrorCode, CommandReply, CommandValue, StreamingItem, ThreadLive,
    WsHost, command_error,
};
use crate::store::{StoreError, ThreadStore};
use crate::util::new_id;

/// A remembered command result. `args: None` = rebuilt from the log at startup (arguments
/// unknown; the id alone matches).
#[derive(Debug, Clone)]
pub struct DedupeEntry {
    pub args: Option<Value>,
    pub reply: CommandReply,
}

const DEDUPE_KEEP: usize = 4096;

fn refusal(r: Refusal) -> crate::api::CommandError {
    command_error(r.code, r.message)
}

fn store_error(e: StoreError) -> crate::api::CommandError {
    match e {
        StoreError::NotFound(id) => command_error(
            CommandErrorCode::ThreadMissing,
            format!("thread {id} not found"),
        ),
        other => command_error(CommandErrorCode::Internal, other.to_string()),
    }
}

/// Ask an actor and wait for its answer.
pub(crate) async fn ask<T>(
    host: &Host,
    id: &ThreadId,
    make: impl FnOnce(oneshot::Sender<Result<T, Refusal>>) -> Msg,
) -> Result<T, Refusal> {
    let (tx, rx) = oneshot::channel();
    if !host.send(id, make(tx)) {
        return Err(Refusal::new(
            CommandErrorCode::ThreadMissing,
            format!("thread {id} not found"),
        ));
    }
    rx.await.unwrap_or_else(|_| {
        Err(Refusal::new(
            CommandErrorCode::Internal,
            "the thread's actor stopped",
        ))
    })
}

/// Settings for a new thread.
pub(crate) struct NewThread {
    pub kind: ThreadKind,
    pub title: String,
    pub bot_id: Option<BotId>,
    pub parent: Option<ParentRef>,
    pub engine: EngineConfig,
}

pub(crate) fn create_thread(host: &Host, t: NewThread) -> Result<ThreadCard, StoreError> {
    let id = ThreadId::new(new_id("thr"));
    let follow_up_mode = match t.kind {
        ThreadKind::Bot => FollowUpMode::Followup,
        ThreadKind::Worker | ThreadKind::User => FollowUpMode::Steer,
    };
    let appended = host.inner.store.create(
        &id,
        ThreadCreated {
            kind: t.kind,
            title: t.title,
            project_id: None,
            bot_id: t.bot_id,
            parent: t.parent,
            engine: t.engine,
            follow_up_mode,
        },
    )?;
    host.publish(&id, &appended);
    Ok(appended.card)
}

fn engine_config(choice: &EngineChoice, cwd: String) -> EngineConfig {
    EngineConfig {
        driver: choice.driver,
        model: choice.model.clone(),
        runtime_mode: choice.runtime_mode.clone(),
        cwd,
    }
}

fn first_line_title(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("New thread")
        .trim();
    goat2_contracts::text::clamp_chars(line, 80)
}

fn args_of(frame: &Command) -> Value {
    let mut value = serde_json::to_value(frame).unwrap_or(Value::Null);
    if let Some(obj) = value.as_object_mut() {
        obj.remove("reqId");
    }
    value
}

/// Run one command with the dedupe rule.
pub(crate) async fn handle(host: &Host, frame: Command) -> CommandReply {
    let Some(key) = frame.client_request_id().map(str::to_owned) else {
        return Err(command_error(
            CommandErrorCode::InvalidRequest,
            "not a command frame",
        ));
    };
    if key.is_empty() {
        return Err(command_error(
            CommandErrorCode::InvalidRequest,
            "clientRequestId is empty",
        ));
    }
    let _guard = host.inner.command_lock.lock().await;
    let args = args_of(&frame);
    if let Some(entry) = host.inner.dedupe.lock().expect("dedupe").get(&key).cloned() {
        if entry.args.as_ref().is_some_and(|a| a != &args) {
            return Err(command_error(
                CommandErrorCode::IdempotencyConflict,
                "clientRequestId was already used with different arguments",
            ));
        }
        return entry.reply.map(|mut v| {
            v.deduped = Some(true);
            v
        });
    }
    let reply = execute(host, frame).await;
    let mut dedupe = host.inner.dedupe.lock().expect("dedupe");
    if dedupe.len() >= DEDUPE_KEEP {
        dedupe.clear();
    }
    dedupe.insert(
        key,
        DedupeEntry {
            args: Some(args),
            reply: reply.clone(),
        },
    );
    reply
}

async fn send_input(host: &Host, thread_id: &ThreadId, input: NewInput) -> CommandReply {
    if input.text.len() > BLOB_THRESHOLD_BYTES {
        return Err(command_error(
            CommandErrorCode::PayloadTooLarge,
            "message is larger than 64 KB",
        ));
    }
    let InputAck { input_id, run_id } = ask(host, thread_id, |tx| Msg::Input(input, tx))
        .await
        .map_err(refusal)?;
    Ok(CommandValue {
        thread_id: Some(thread_id.clone()),
        input_id: Some(input_id),
        run_id,
        ..Default::default()
    })
}

async fn execute(host: &Host, frame: Command) -> CommandReply {
    let store = host.inner.store.clone();
    let thread_value = |id: &ThreadId| CommandValue {
        thread_id: Some(id.clone()),
        ..Default::default()
    };
    match frame {
        Command::SendInput {
            client_request_id,
            thread_id,
            text,
            mode,
            attachments,
            ..
        } => {
            send_input(
                host,
                &thread_id,
                NewInput {
                    from: InputSource::User,
                    text,
                    attachments: attachments.unwrap_or_default(),
                    mode: Some(mode),
                    client_request_id,
                },
            )
            .await
        }
        Command::StartThread {
            client_request_id,
            kind,
            title,
            bot_id,
            parent,
            engine,
            cwd,
            text,
            ..
        } => {
            let cwd = cwd.unwrap_or_else(|| host.inner.opts.default_cwd.clone());
            let title = title.unwrap_or_else(|| first_line_title(text.as_deref().unwrap_or("")));
            let parent_ref = match (kind, parent) {
                (ThreadKind::Worker, Some(parent)) => {
                    let parent_card = store.card(&parent).ok_or_else(|| {
                        command_error(CommandErrorCode::ThreadMissing, "parent not found")
                    })?;
                    if parent_card.kind == ThreadKind::Worker {
                        return Err(command_error(
                            CommandErrorCode::NotAllowed,
                            "a worker cannot have children (depth 1)",
                        ));
                    }
                    if host.busy_children(&parent) >= host.inner.opts.max_children {
                        return Err(command_error(
                            CommandErrorCode::LimitReached,
                            "the parent already runs 4 children",
                        ));
                    }
                    Some(ParentRef {
                        thread_id: parent,
                        by_item_id: ItemId::new(format!("ui:{client_request_id}")),
                    })
                }
                (ThreadKind::Worker, None) => {
                    return Err(command_error(
                        CommandErrorCode::InvalidRequest,
                        "a worker thread needs a parent",
                    ));
                }
                (ThreadKind::Bot, _) if bot_id.as_ref().and_then(|b| host.bot(b)).is_none() => {
                    return Err(command_error(CommandErrorCode::BotMissing, "bot not found"));
                }
                _ => None,
            };
            let card = create_thread(
                host,
                NewThread {
                    kind,
                    title,
                    bot_id,
                    parent: parent_ref.clone(),
                    engine: engine_config(&engine, cwd),
                },
            )
            .map_err(store_error)?;
            if let Some(parent) = &parent_ref {
                host.append(
                    &parent.thread_id,
                    vec![LogEvent::ChildStarted(ChildStarted {
                        child_thread_id: card.id.clone(),
                        task: text.clone().unwrap_or_default(),
                        by_item_id: parent.by_item_id.clone(),
                    })],
                )
                .map_err(store_error)?;
            }
            match text.filter(|t| !t.trim().is_empty()) {
                Some(text) => {
                    send_input(
                        host,
                        &card.id,
                        NewInput {
                            from: InputSource::User,
                            text,
                            attachments: Vec::new(),
                            mode: None,
                            client_request_id,
                        },
                    )
                    .await
                }
                None => Ok(thread_value(&card.id)),
            }
        }
        Command::StopThread { thread_id, .. } => {
            let run_id = ask(host, &thread_id, |tx| Msg::Stop {
                hold: true,
                reply: Some(tx),
            })
            .await
            .map_err(refusal)?;
            Ok(CommandValue {
                run_id,
                ..thread_value(&thread_id)
            })
        }
        Command::ResumeQueue { thread_id, .. } => {
            ask(host, &thread_id, Msg::ResumeQueue)
                .await
                .map_err(refusal)?;
            Ok(thread_value(&thread_id))
        }
        Command::ResolveRequest {
            thread_id,
            request_id,
            outcome,
            text,
            answers,
            option_id,
            ..
        } => {
            let resolution = Resolution {
                request_id: request_id.clone(),
                outcome,
                option_id,
                text,
                answers,
            };
            ask(host, &thread_id, |tx| Msg::Resolve(resolution, tx))
                .await
                .map_err(refusal)?;
            Ok(CommandValue {
                request_id: Some(request_id),
                ..thread_value(&thread_id)
            })
        }
        Command::ArchiveThread {
            thread_id,
            archived,
            ..
        } => change(
            host,
            &thread_id,
            ThreadChanged {
                archived: Some(archived),
                ..Default::default()
            },
        ),
        Command::RenameThread {
            thread_id, title, ..
        } => change(
            host,
            &thread_id,
            ThreadChanged {
                title: Some(goat2_contracts::text::clamp_chars(
                    &title,
                    goat2_contracts::limits::CARD_TITLE_MAX_CHARS,
                )),
                ..Default::default()
            },
        ),
        Command::ChangeThread {
            thread_id,
            model,
            runtime_mode,
            follow_up_mode,
            ..
        } => change(
            host,
            &thread_id,
            ThreadChanged {
                model,
                runtime_mode,
                follow_up_mode,
                ..Default::default()
            },
        ),
        Command::EditQueued {
            thread_id,
            input_id,
            text,
            ..
        } => queue(host, &thread_id, QueueEdit::Edit { input_id, text }).await,
        Command::CancelQueued {
            thread_id,
            input_id,
            ..
        } => queue(host, &thread_id, QueueEdit::Cancel { input_id }).await,
        Command::ReorderQueued {
            thread_id,
            input_ids,
            ..
        } => queue(host, &thread_id, QueueEdit::Reorder { input_ids }).await,
        Command::PromoteToSteer {
            thread_id,
            input_id,
            ..
        } => queue(host, &thread_id, QueueEdit::PromoteToSteer { input_id }).await,
        Command::CreateBot {
            name,
            purpose,
            face,
            engine,
            ..
        } => {
            let profile = create_bot(host, name, purpose, face, engine, BotRole::Member)
                .map_err(store_error)?;
            Ok(CommandValue {
                bot_id: Some(profile.bot_id.clone()),
                thread_id: Some(profile.thread_id.clone()),
                ..Default::default()
            })
        }
        _ => Err(command_error(
            CommandErrorCode::InvalidRequest,
            "not a command frame",
        )),
    }
}

fn change(host: &Host, thread_id: &ThreadId, changed: ThreadChanged) -> CommandReply {
    if host.inner.store.card(thread_id).is_none() {
        return Err(command_error(
            CommandErrorCode::ThreadMissing,
            "thread not found",
        ));
    }
    host.append(thread_id, vec![LogEvent::ThreadChanged(changed)])
        .map_err(store_error)?;
    Ok(CommandValue {
        thread_id: Some(thread_id.clone()),
        ..Default::default()
    })
}

async fn queue(host: &Host, thread_id: &ThreadId, edit: QueueEdit) -> CommandReply {
    ask(host, thread_id, |tx| Msg::Queue(edit, tx))
        .await
        .map_err(refusal)?;
    Ok(CommandValue {
        thread_id: Some(thread_id.clone()),
        ..Default::default()
    })
}

// ---------------------------------------------------------------- bots

fn bots_dir(host: &Host) -> std::path::PathBuf {
    host.inner.opts.data_dir.join("bots")
}

fn save_bot(host: &Host, profile: &BotProfile) -> Result<(), StoreError> {
    let dir = bots_dir(host);
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{}.json.tmp", profile.bot_id));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(profile).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(tmp, dir.join(format!("{}.json", profile.bot_id)))?;
    Ok(())
}

fn create_bot(
    host: &Host,
    name: String,
    purpose: String,
    face: BotFace,
    engine: EngineChoice,
    role: BotRole,
) -> Result<BotProfile, StoreError> {
    let bot_id = if role == BotRole::Main {
        BotId::new("goat")
    } else {
        BotId::new(new_id("bot"))
    };
    let card = create_thread(
        host,
        NewThread {
            kind: ThreadKind::Bot,
            title: name.clone(),
            bot_id: Some(bot_id.clone()),
            parent: None,
            engine: engine_config(&engine, host.inner.opts.default_cwd.clone()),
        },
    )?;
    let profile = BotProfile {
        bot_id,
        name,
        purpose,
        face,
        role,
        thread_id: card.id,
        engine,
    };
    save_bot(host, &profile)?;
    host.inner.bots.lock().expect("bots").push(profile.clone());
    let _ = host
        .inner
        .cards_tx
        .send(CardUpdate::BotChanged(Arc::new(profile.clone())));
    Ok(profile)
}

/// Load `bots/*.json`; create the main bot GOAT on first start.
pub(crate) fn load_bots(host: &Host) -> Result<(), StoreError> {
    let dir = bots_dir(host);
    let mut bots = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json")
                && let Ok(bytes) = std::fs::read(&path)
                && let Ok(profile) = serde_json::from_slice::<BotProfile>(&bytes)
            {
                bots.push(profile);
            }
        }
    }
    bots.sort_by(|a, b| {
        (a.role != BotRole::Main, &a.name).cmp(&(b.role != BotRole::Main, &b.name))
    });
    let has_main = bots.iter().any(|b| b.role == BotRole::Main);
    *host.inner.bots.lock().expect("bots") = bots;
    if !has_main {
        create_bot(
            host,
            "GOAT".to_owned(),
            "Your main bot".to_owned(),
            BotFace {
                shape: "goat".to_owned(),
                color: "#0169CC".to_owned(),
                goat: true,
            },
            EngineChoice {
                driver: EngineDriver::Codex,
                model: String::new(),
                runtime_mode: "full-access".to_owned(),
            },
            BotRole::Main,
        )?;
    }
    Ok(())
}

/// Rebuild the recent-id table from `input.accepted.clientRequestId` of active and recent
/// threads, so a UI resend after a lost reply is answered from the log.
pub(crate) async fn rebuild_dedupe(host: &Host) {
    let store = host.inner.store.clone();
    let mut cards = store.cards();
    cards.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let ids: Vec<ThreadId> = cards
        .iter()
        .enumerate()
        .filter(|(i, c)| *i < 50 || c.status != ThreadStatus::Idle)
        .map(|(_, c)| c.id.clone())
        .collect();
    let found = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        for id in ids {
            let Ok(lines) = store.read_after(&id, 0) else {
                continue;
            };
            for line in lines {
                if let LogEvent::InputAccepted(input) = line.event
                    && matches!(input.from, InputSource::User)
                {
                    found.push((input.client_request_id, id.clone(), input.input_id));
                }
            }
        }
        found
    })
    .await
    .unwrap_or_default();
    let mut dedupe = host.inner.dedupe.lock().expect("dedupe");
    for (key, thread_id, input_id) in found {
        dedupe.entry(key).or_insert(DedupeEntry {
            args: None,
            reply: Ok(CommandValue {
                thread_id: Some(thread_id),
                input_id: Some(input_id),
                ..Default::default()
            }),
        });
    }
}

#[async_trait]
impl WsHost for Host {
    fn ui_token(&self) -> String {
        self.inner.opts.ui_token.clone()
    }

    fn store(&self) -> Arc<dyn ThreadStore> {
        self.inner.store.clone()
    }

    fn bots(&self) -> Vec<BotProfile> {
        self.inner.bots.lock().expect("bots").clone()
    }

    fn watch_cards(&self) -> broadcast::Receiver<CardUpdate> {
        self.inner.cards_tx.subscribe()
    }

    fn watch_thread(
        &self,
        thread_id: &ThreadId,
    ) -> (broadcast::Receiver<ThreadLive>, Vec<StreamingItem>) {
        self.watch(thread_id)
    }

    async fn command(&self, command: Command) -> CommandReply {
        handle(self, command).await
    }

    fn stalled_ms_since(&self, since: std::time::Instant) -> u64 {
        self.inner.stall.stalled_ms_since(since)
    }
}
