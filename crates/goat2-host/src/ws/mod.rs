//! Authenticated WebSocket subscriptions for the UI.
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::{
    api::{CardUpdate, ThreadLive, WsHost, is_command},
    store::{StoreError, ThreadStore},
    util,
};
use axum::{
    Router,
    extract::{
        Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use goat2_contracts::{
    CardCursor, ClientFrame, Epoch, HostFrame, ItemId, LogLine, ResetReason, ThreadCursor,
    ThreadId, limits,
};
use serde::Deserialize;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};

#[derive(Clone, Copy)]
pub struct WsOptions {
    pub ping_interval: Duration,
}
impl Default for WsOptions {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(limits::PING_INTERVAL_SECS),
        }
    }
}
#[derive(Clone)]
struct App {
    host: Arc<dyn WsHost>,
    options: WsOptions,
}
#[derive(Deserialize)]
struct Auth {
    token: Option<String>,
}

pub fn router(host: Arc<dyn WsHost>) -> Router {
    router_with(host, WsOptions::default())
}
pub fn router_with(host: Arc<dyn WsHost>, options: WsOptions) -> Router {
    Router::new()
        .route("/ws", get(upgrade))
        .with_state(App { host, options })
}
async fn upgrade(
    State(app): State<App>,
    Query(auth): Query<Auth>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let expected = app.host.ui_token();
    if !header.is_some_and(|s| util::token_eq(s, &expected))
        && !auth
            .token
            .as_deref()
            .is_some_and(|s| util::token_eq(s, &expected))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| connection(socket, app))
}
type Tx = mpsc::UnboundedSender<Value>;
fn send(tx: &Tx, frame: impl serde::Serialize) {
    if let Ok(v) = serde_json::to_value(frame) {
        let _ = tx.send(v);
    }
}
fn error(
    tx: &Tx,
    sub_id: Option<String>,
    req_id: Option<String>,
    code: &str,
    message: impl ToString,
) {
    send(
        tx,
        HostFrame::Error {
            sub_id,
            req_id,
            code: code.into(),
            message: message.to_string(),
        },
    );
}
async fn connection(socket: WebSocket, app: App) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let mut subs: HashMap<String, (JoinHandle<()>, Option<mpsc::UnboundedSender<ItemId>>)> =
        HashMap::new();
    let mut last_seen = Instant::now();
    let mut timer = tokio::time::interval_at(
        tokio::time::Instant::now() + app.options.ping_interval,
        app.options.ping_interval,
    );
    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(msg)) = incoming else { break }; last_seen = Instant::now();
                match msg {
                    Message::Text(text) => {
                        let value: Value = match serde_json::from_str(&text) { Ok(v) => v, Err(e) => { error(&tx,None,None,"bad_frame",e); continue; } };
                        let req_id = value.get("reqId").and_then(Value::as_str).map(str::to_owned);
                        let frame: ClientFrame = match serde_json::from_value(value) { Ok(f) => f, Err(e) => { error(&tx,None,None,"bad_frame",e); continue; } };
                        if is_command(&frame) {
                            let Some(req_id) = req_id else { error(&tx,None,None,"bad_frame","missing reqId"); continue; };
                            let host=app.host.clone(); let tx=tx.clone();
                            tokio::spawn(async move { match host.command(frame).await { Ok(value) => send(&tx,HostFrame::command_ok(req_id,value)), Err(e) => send(&tx,HostFrame::command_err(req_id,e)) } });
                            continue;
                        }
                        match frame {
                            ClientFrame::SubscribeCards { sub_id, after } => {
                                if let Some((handle,_)) = subs.remove(&sub_id) { handle.abort(); }
                                let host=app.host.clone(); let tx=tx.clone(); let id=sub_id.clone();
                                let handle=tokio::spawn(async move { cards(host,tx,id,after).await }); subs.insert(sub_id,(handle,None));
                            }
                            ClientFrame::SubscribeThread { sub_id, thread_id, after } => {
                                if let Some((handle,_)) = subs.remove(&sub_id) { handle.abort(); }
                                let host=app.host.clone(); let tx=tx.clone(); let id=sub_id.clone(); let (resync_tx,resync_rx)=mpsc::unbounded_channel();
                                let handle=tokio::spawn(async move { thread(host,tx,id,thread_id,after,resync_rx).await }); subs.insert(sub_id,(handle,Some(resync_tx)));
                            }
                            ClientFrame::Unsubscribe { sub_id } => { if let Some((handle,_))=subs.remove(&sub_id) { handle.abort(); } }
                            ClientFrame::ResyncItem { sub_id, item_id } => { if let Some((_,Some(sender)))=subs.get(&sub_id) { let _=sender.send(item_id); } }
                            ClientFrame::ReadPage { req_id, thread_id, before, limit } => {
                                if limit > 500 || limit == 0 { error(&tx,None,Some(req_id),"bad_frame","limit must be between 1 and 500"); continue; }
                                let store=app.host.store(); let tx=tx.clone(); tokio::spawn(async move {
                                    let id=thread_id.clone(); let result=tokio::task::spawn_blocking(move || store.read_page(&id,before,limit as usize)).await;
                                    match result { Ok(Ok((lines,has_more))) => send(&tx,HostFrame::Page {req_id,thread_id,lines,has_more}), Ok(Err(e)) => error(&tx,None,Some(req_id),"store_error",e), Err(e) => error(&tx,None,Some(req_id),"store_error",e) }
                                });
                            }
                            ClientFrame::Pong { .. } => {}
                            _ => error(&tx,None,None,"bad_frame","unsupported frame"),
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            value = rx.recv() => { let Some(value)=value else { break }; if sink.send(Message::Text(value.to_string().into())).await.is_err() { break; } }
            _ = timer.tick() => {
                let silence=last_seen.elapsed().saturating_sub(Duration::from_millis(app.host.stalled_ms_since(last_seen)));
                if silence >= app.options.ping_interval.saturating_mul(3) { break; }
                send(&tx,HostFrame::Ping {at:util::now_rfc3339()});
            }
        }
    }
    for (_, (handle, _)) in subs {
        handle.abort();
    }
}

async fn cards(host: Arc<dyn WsHost>, tx: Tx, sub_id: String, after: Option<CardCursor>) {
    let mut rx = host.watch_cards();
    let store = host.store();
    // The store's cursor contract: other epoch, past the end, or before a deletion (no
    // tombstones in Part 1) answers every card plus a reset.
    let read = store.cards_after(after.as_ref());
    let epoch = read.cursor.epoch.clone();
    let mut last = match (&read.reset, &after) {
        (None, Some(cursor)) => cursor.card_seq,
        _ => 0,
    };
    if let (Some(reason), Some(_)) = (read.reset, &after) {
        send(
            &tx,
            HostFrame::CardsReset {
                sub_id: sub_id.clone(),
                reason,
                epoch: epoch.clone(),
            },
        );
    }
    for card in read.cards {
        if card.card_seq > last {
            last = card.card_seq;
            send(
                &tx,
                HostFrame::CardChanged {
                    sub_id: sub_id.clone(),
                    card: Box::new(card),
                },
            );
        }
    }
    for bot in host.bots() {
        send(
            &tx,
            HostFrame::BotChanged {
                sub_id: sub_id.clone(),
                bot: Box::new(bot),
            },
        );
    }
    send(
        &tx,
        HostFrame::CardsCaughtUp {
            sub_id: sub_id.clone(),
            cursor: CardCursor {
                epoch,
                card_seq: last,
            },
        },
    );
    loop {
        match rx.recv().await {
            Ok(CardUpdate::Changed(card)) if card.card_seq > last => {
                last = card.card_seq;
                send(
                    &tx,
                    HostFrame::CardChanged {
                        sub_id: sub_id.clone(),
                        card: Box::new((*card).clone()),
                    },
                );
            }
            Ok(CardUpdate::Removed {
                thread_id,
                card_seq,
            }) if card_seq > last => {
                last = card_seq;
                send(
                    &tx,
                    HostFrame::CardRemoved {
                        sub_id: sub_id.clone(),
                        thread_id,
                        card_seq,
                    },
                );
            }
            Ok(CardUpdate::BotChanged(bot)) => send(
                &tx,
                HostFrame::BotChanged {
                    sub_id: sub_id.clone(),
                    bot: Box::new((*bot).clone()),
                },
            ),
            Ok(CardUpdate::BotRemoved { bot_id }) => send(
                &tx,
                HostFrame::BotRemoved {
                    sub_id: sub_id.clone(),
                    bot_id,
                },
            ),
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(_)) => {
                let store = host.store();
                let epoch = store.index_epoch();
                send(
                    &tx,
                    HostFrame::CardsReset {
                        sub_id: sub_id.clone(),
                        reason: ResetReason::TooFarBehind,
                        epoch: epoch.clone(),
                    },
                );
                last = 0;
                for card in store.cards() {
                    last = last.max(card.card_seq);
                    send(
                        &tx,
                        HostFrame::CardChanged {
                            sub_id: sub_id.clone(),
                            card: Box::new(card),
                        },
                    );
                }
                for bot in host.bots() {
                    send(
                        &tx,
                        HostFrame::BotChanged {
                            sub_id: sub_id.clone(),
                            bot: Box::new(bot),
                        },
                    );
                }
                send(
                    &tx,
                    HostFrame::CardsCaughtUp {
                        sub_id: sub_id.clone(),
                        cursor: CardCursor {
                            epoch,
                            card_seq: last,
                        },
                    },
                );
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

struct Replay {
    epoch: Epoch,
    lines: Vec<LogLine>,
    last: u64,
    reset: Option<ResetReason>,
}
fn replay(
    store: &dyn ThreadStore,
    id: &ThreadId,
    after: Option<ThreadCursor>,
    forced: Option<ResetReason>,
) -> Result<Replay, StoreError> {
    let epoch = store
        .thread_epoch(id)
        .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
    let last = store
        .last_seq(id)
        .ok_or_else(|| StoreError::ThreadMissing(id.to_string()))?;
    let mut reset = forced;
    let mut start = match after {
        Some(cursor) if reset.is_none() && cursor.epoch != epoch => {
            reset = Some(ResetReason::EpochChanged);
            None
        }
        Some(cursor) if reset.is_none() && cursor.seq > last => {
            reset = Some(ResetReason::InvalidCursor);
            None
        }
        Some(cursor) if reset.is_none() => Some(cursor.seq),
        _ => None,
    };
    if let Some(seq) = start {
        let lines = store.read_after(id, seq)?;
        let bytes: usize = lines
            .iter()
            .map(|line| {
                serde_json::to_vec(line)
                    .map(|v| v.len() + 1)
                    .map_err(|e| StoreError::Io(std::io::Error::other(e)))
            })
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .sum();
        if lines.len() > limits::REPLAY_MAX_EVENTS || bytes > limits::REPLAY_MAX_BYTES {
            reset = Some(ResetReason::TooFarBehind);
            start = None;
        } else {
            return Ok(Replay {
                epoch,
                lines,
                last,
                reset,
            });
        }
    }
    let from = match start {
        Some(v) => v,
        None => store
            .latest_checkpoint_seq(id)?
            .unwrap_or(1)
            .saturating_sub(1),
    };
    let lines = store.read_after(id, from)?;
    Ok(Replay {
        epoch,
        lines,
        last,
        reset,
    })
}
async fn do_replay(
    host: &Arc<dyn WsHost>,
    tx: &Tx,
    sub: &str,
    id: &ThreadId,
    after: Option<ThreadCursor>,
    forced: Option<ResetReason>,
) -> Option<u64> {
    let store = host.store();
    let read_id = id.clone();
    let result =
        tokio::task::spawn_blocking(move || replay(store.as_ref(), &read_id, after, forced)).await;
    let replay = match result {
        Ok(Ok(r)) => r,
        Ok(Err(StoreError::ThreadMissing(_))) => {
            send(
                tx,
                HostFrame::ThreadReset {
                    sub_id: sub.into(),
                    thread_id: id.clone(),
                    reason: ResetReason::ThreadMissing,
                    epoch: Epoch::new(""),
                },
            );
            return None;
        }
        Ok(Err(e)) => {
            error(tx, Some(sub.into()), None, "store_error", e);
            return None;
        }
        Err(e) => {
            error(tx, Some(sub.into()), None, "store_error", e);
            return None;
        }
    };
    if let Some(reason) = replay.reset {
        send(
            tx,
            HostFrame::ThreadReset {
                sub_id: sub.into(),
                thread_id: id.clone(),
                reason,
                epoch: replay.epoch.clone(),
            },
        );
    }
    let mut last = replay.last;
    for line in replay.lines {
        last = last.max(line.seq);
        send(
            tx,
            HostFrame::ThreadEvent {
                sub_id: sub.into(),
                thread_id: id.clone(),
                line: Box::new(line),
            },
        );
    }
    send(
        tx,
        HostFrame::ThreadCaughtUp {
            sub_id: sub.into(),
            thread_id: id.clone(),
            cursor: ThreadCursor {
                epoch: replay.epoch,
                seq: last,
            },
        },
    );
    Some(last)
}
async fn thread(
    host: Arc<dyn WsHost>,
    tx: Tx,
    sub: String,
    id: ThreadId,
    after: Option<ThreadCursor>,
    mut resync: mpsc::UnboundedReceiver<ItemId>,
) {
    let (mut rx, snapshot) = host.watch_thread(&id);
    let Some(mut last) = do_replay(&host, &tx, &sub, &id, after, None).await else {
        return;
    };
    let mut texts = HashMap::<ItemId, String>::new();
    for item in snapshot {
        send(
            &tx,
            HostFrame::TextAppend {
                sub_id: sub.clone(),
                thread_id: id.clone(),
                item_id: item.item_id.clone(),
                offset: 0,
                text: item.text.clone(),
            },
        );
        texts.insert(item.item_id, item.text);
    }
    loop {
        tokio::select! {
            requested=resync.recv()=>{if let Some(item_id)=requested && let Some(text)=texts.get(&item_id) {send(&tx,HostFrame::TextAppend{sub_id:sub.clone(),thread_id:id.clone(),item_id,offset:0,text:text.clone()});}},
            update=rx.recv()=>match update {
                Ok(ThreadLive::Line(line)) if line.seq>last => {last=line.seq;send(&tx,HostFrame::ThreadEvent{sub_id:sub.clone(),thread_id:id.clone(),line:Box::new((*line).clone())});},
                Ok(ThreadLive::Text{item_id,offset,text}) => {
                let buffer=texts.entry(item_id.clone()).or_default();
                let length=buffer.encode_utf16().count() as u64;
                if offset == length { buffer.push_str(&text); send(&tx,HostFrame::TextAppend{sub_id:sub.clone(),thread_id:id.clone(),item_id,offset,text}); }
                else if offset < length && text_matches_at(buffer, offset, &text) { /* already included in snapshot */ }
                else { // Refresh rather than retain an incomplete or divergent streaming buffer.
                    let (new_rx, items)=host.watch_thread(&id); rx=new_rx; texts.clear();
                    let Some(seq)=do_replay(&host,&tx,&sub,&id,None,Some(ResetReason::TooFarBehind)).await else {return};last=seq;
                    for item in items { send(&tx,HostFrame::TextAppend{sub_id:sub.clone(),thread_id:id.clone(),item_id:item.item_id.clone(),offset:0,text:item.text.clone()}); texts.insert(item.item_id,item.text); }
                }
            },
                Ok(ThreadLive::TextDone{item_id})=>{texts.remove(&item_id);},
                Ok(ThreadLive::Reset{reason,..}) => { let (new_rx,items)=host.watch_thread(&id);rx=new_rx;texts.clear(); let Some(seq)=do_replay(&host,&tx,&sub,&id,None,Some(reason)).await else {return};last=seq; for item in items {send(&tx,HostFrame::TextAppend{sub_id:sub.clone(),thread_id:id.clone(),item_id:item.item_id.clone(),offset:0,text:item.text.clone()});texts.insert(item.item_id,item.text);} },
                Ok(_) => {},
                Err(broadcast::error::RecvError::Lagged(_)) => {let (new_rx,items)=host.watch_thread(&id);rx=new_rx;texts.clear(); let Some(seq)=do_replay(&host,&tx,&sub,&id,None,Some(ResetReason::TooFarBehind)).await else {return};last=seq; for item in items {send(&tx,HostFrame::TextAppend{sub_id:sub.clone(),thread_id:id.clone(),item_id:item.item_id.clone(),offset:0,text:item.text.clone()});texts.insert(item.item_id,item.text);}},
                Err(broadcast::error::RecvError::Closed)=>return,
            }
        }
    }
}

// Offsets on the wire count UTF-16 code units; an already snapshotted chunk is suppressed.
fn text_matches_at(buffer: &str, offset: u64, text: &str) -> bool {
    let units: Vec<u16> = buffer.encode_utf16().collect();
    let chunk: Vec<u16> = text.encode_utf16().collect();
    let Ok(start) = usize::try_from(offset) else {
        return false;
    };
    units
        .get(start..)
        .is_some_and(|tail| tail.starts_with(&chunk))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_selection() -> goat2_contracts::ModelSelection {
        goat2_contracts::ModelSelection {
            instance_id: "codex".into(),
            model: "m".into(),
            options: None,
        }
    }
    use crate::{
        api::{
            BotProfile, Command, CommandReply, CommandValue, Reason, StreamingItem, command_error,
        },
        store::LaneAStore,
    };
    use async_trait::async_trait;
    use goat2_contracts::{
        EngineConfig, FollowUpMode, LogEvent, ThreadChanged, ThreadCreated, ThreadKind,
    };
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{
        MaybeTlsStream, WebSocketStream, tungstenite::Message as ClientMessage,
    };
    type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
    struct Fake {
        store: Arc<LaneAStore>,
        cards: broadcast::Sender<CardUpdate>,
        lines: broadcast::Sender<ThreadLive>,
        inject_line: std::sync::atomic::AtomicBool,
        stalled_ms: std::sync::atomic::AtomicU64,
    }
    #[async_trait]
    impl WsHost for Fake {
        fn ui_token(&self) -> String {
            "secret".into()
        }
        fn store(&self) -> Arc<dyn ThreadStore> {
            self.store.clone()
        }
        fn bots(&self) -> Vec<BotProfile> {
            vec![]
        }
        fn watch_cards(&self) -> broadcast::Receiver<CardUpdate> {
            self.cards.subscribe()
        }
        fn watch_thread(
            &self,
            _: &ThreadId,
        ) -> (broadcast::Receiver<ThreadLive>, Vec<StreamingItem>) {
            let rx = self.lines.subscribe();
            if self
                .inject_line
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                let line = self
                    .store
                    .read_after(&ThreadId::from("t"), 0)
                    .unwrap()
                    .pop()
                    .unwrap();
                self.lines.send(ThreadLive::Line(Arc::new(line))).unwrap();
            }
            (
                rx,
                vec![StreamingItem {
                    item_id: ItemId::from("item"),
                    text: "hello".into(),
                }],
            )
        }
        fn stalled_ms_since(&self, _: Instant) -> u64 {
            self.stalled_ms.load(std::sync::atomic::Ordering::SeqCst)
        }
        async fn command(&self, command: Command) -> CommandReply {
            if matches!(command, Command::RenameThread { .. }) {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            match command {
                Command::StopThread { .. } => Ok(CommandValue {
                    thread_id: Some("t".into()),
                    ..Default::default()
                }),
                _ => Err(command_error(Reason::NotAllowed, "refused")),
            }
        }
    }
    fn created() -> ThreadCreated {
        ThreadCreated {
            kind: ThreadKind::User,
            title: "test".into(),
            project_id: None,
            bot_id: None,
            parent: None,
            engine: EngineConfig {
                provider_instance_id: "codex".into(),
                model_selection: test_selection(),
                runtime_mode: goat2_contracts::RuntimeMode::FullAccess,
                cwd: "/tmp".into(),
            },
            follow_up_mode: FollowUpMode::Steer,
        }
    }
    async fn setup() -> (tempfile::TempDir, Arc<Fake>, String) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(LaneAStore::open(dir.path()).unwrap().0);
        store.create(&ThreadId::from("t"), created()).unwrap();
        let (cards, _) = broadcast::channel(256);
        let (lines, _) = broadcast::channel(256);
        let host = Arc::new(Fake {
            store,
            cards,
            lines,
            inject_line: std::sync::atomic::AtomicBool::new(false),
            stalled_ms: std::sync::atomic::AtomicU64::new(0),
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = router(host.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (dir, host, format!("ws://{addr}/ws"))
    }
    async fn connect(url: &str) -> Socket {
        tokio_tungstenite::connect_async(format!("{url}?token=secret"))
            .await
            .unwrap()
            .0
    }
    async fn write(ws: &mut Socket, value: Value) {
        ws.send(ClientMessage::Text(value.to_string().into()))
            .await
            .unwrap();
    }
    async fn read(ws: &mut Socket) -> Value {
        let msg = tokio::time::timeout(Duration::from_secs(2), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        serde_json::from_str(msg.to_text().unwrap()).unwrap()
    }
    #[tokio::test]
    async fn auth_commands_bad_frame_and_page() {
        let (_dir, _host, url) = setup().await;
        let err = tokio_tungstenite::connect_async(format!("{url}?token=bad"))
            .await
            .unwrap_err();
        assert!(
            matches!(err,tokio_tungstenite::tungstenite::Error::Http(ref r) if r.status()==401)
        );
        let mut ws = connect(&url).await;
        write(
            &mut ws,
            json!({"type":"stop_thread","reqId":"1","clientRequestId":"one","threadId":"t"}),
        )
        .await;
        assert_eq!(
            read(&mut ws).await,
            json!({"type":"command_result","reqId":"1","ok":true,"value":{"threadId":"t"}})
        );
        write(
            &mut ws,
            json!({"type":"resume_queue","reqId":"2","clientRequestId":"two","threadId":"t"}),
        )
        .await;
        let refused = read(&mut ws).await;
        assert_eq!(refused["error"]["code"], "permission_denied");
        assert_eq!(refused["error"]["reason"], "not_allowed");
        write(&mut ws, json!({"type":"garbage"})).await;
        assert_eq!(read(&mut ws).await["code"], "bad_frame");
        write(
            &mut ws,
            json!({"type":"read_page","reqId":"3","threadId":"t","before":10,"limit":1}),
        )
        .await;
        let page = read(&mut ws).await;
        assert_eq!(page["type"], "page");
        assert_eq!(page["lines"].as_array().unwrap().len(), 1);
        assert_eq!(page["hasMore"], false);
    }
    #[tokio::test]
    async fn cards_initial_live_and_epoch_reset() {
        let (_dir, host, url) = setup().await;
        let mut ws = connect(&url).await;
        write(
            &mut ws,
            json!({"type":"subscribe_cards","subId":"c","after":{"epoch":"old","cardSeq":0}}),
        )
        .await;
        assert_eq!(read(&mut ws).await["reason"], "epoch_changed");
        assert_eq!(read(&mut ws).await["type"], "card_changed");
        assert_eq!(read(&mut ws).await["type"], "cards_caught_up");
        let result = host
            .store
            .append(
                &ThreadId::from("t"),
                vec![LogEvent::ThreadChanged(ThreadChanged {
                    title: Some("next".into()),
                    ..Default::default()
                })],
            )
            .unwrap();
        host.cards
            .send(CardUpdate::Changed(Arc::new(result.card)))
            .unwrap();
        assert_eq!(read(&mut ws).await["card"]["title"], "next");
        let bot = BotProfile {
            bot_id: "b".into(),
            name: "bot".into(),
            purpose: "test".into(),
            face: goat2_contracts::BotFace {
                shape: "round".into(),
                color: "blue".into(),
                goat: false,
            },
            role: goat2_contracts::BotRole::Member,
            session_thread_id: "t".into(),
            default_model_selection: test_selection(),
            instructions: None,
        };
        host.cards
            .send(CardUpdate::BotChanged(Arc::new(bot)))
            .unwrap();
        assert_eq!(read(&mut ws).await["bot"]["botId"], "b");
        host.cards
            .send(CardUpdate::BotRemoved { bot_id: "b".into() })
            .unwrap();
        assert_eq!(read(&mut ws).await["botId"], "b");
        let card_seq = host.store.cards_after(None).cursor.card_seq + 1;
        host.store.delete(&ThreadId::from("t")).unwrap();
        host.cards
            .send(CardUpdate::Removed {
                thread_id: "t".into(),
                card_seq,
            })
            .unwrap();
        assert_eq!(read(&mut ws).await["type"], "card_removed");
        // Reconnecting with a cursor from before the deletion resets instead of a delta.
        let mut again = connect(&url).await;
        write(
            &mut again,
            json!({"type":"subscribe_cards","subId":"c2","after":{"epoch":host.store.index_epoch(),"cardSeq":1}}),
        )
        .await;
        let reset = read(&mut again).await;
        assert_eq!(reset["type"], "cards_reset");
        // The store's reason for a cursor older than a deletion (lane A DESIGN.md cursor table).
        assert_eq!(reset["reason"], "thread_missing");
    }
    #[tokio::test]
    async fn thread_replay_cursors_stream_resync_and_page() {
        let (_dir, host, url) = setup().await;
        let id = ThreadId::from("t");
        let epoch = host.store.thread_epoch(&id).unwrap();
        for _ in 0..3 {
            host.store
                .append(&id, vec![LogEvent::ThreadChanged(ThreadChanged::default())])
                .unwrap();
        }
        let mut ws = connect(&url).await;
        write(&mut ws,json!({"type":"subscribe_thread","subId":"s","threadId":"t","after":{"epoch":epoch,"seq":2}})).await;
        assert_eq!(read(&mut ws).await["line"]["seq"], 3);
        assert_eq!(read(&mut ws).await["line"]["seq"], 4);
        assert_eq!(read(&mut ws).await["type"], "thread_caught_up");
        assert_eq!(read(&mut ws).await["text"], "hello");
        host.lines
            .send(ThreadLive::Text {
                item_id: ItemId::from("item"),
                offset: 5,
                text: "!".into(),
            })
            .unwrap();
        assert_eq!(read(&mut ws).await["offset"], 5);
        write(
            &mut ws,
            json!({"type":"resync_item","subId":"s","itemId":"item"}),
        )
        .await;
        assert_eq!(read(&mut ws).await["text"], "hello!");
        write(
            &mut ws,
            json!({"type":"read_page","reqId":"p","threadId":"t","before":5,"limit":2}),
        )
        .await;
        assert_eq!(read(&mut ws).await["hasMore"], true);
        write(
            &mut ws,
            json!({"type":"subscribe_thread","subId":"missing","threadId":"missing"}),
        )
        .await;
        assert_eq!(read(&mut ws).await["reason"], "thread_missing");
        for (sub, cursor, reason) in [
            ("old", json!({"epoch":"old","seq":1}), "epoch_changed"),
            ("invalid", json!({"epoch":epoch,"seq":99}), "invalid_cursor"),
        ] {
            write(
                &mut ws,
                json!({"type":"subscribe_thread","subId":sub,"threadId":"t","after":cursor}),
            )
            .await;
            assert_eq!(read(&mut ws).await["reason"], reason);
            for _ in 0..4 {
                assert_eq!(read(&mut ws).await["type"], "thread_event");
            }
            assert_eq!(read(&mut ws).await["type"], "thread_caught_up");
            let _ = read(&mut ws).await;
        }
        write(&mut ws,json!({"type":"subscribe_thread","subId":"equal","threadId":"t","after":{"epoch":epoch,"seq":4}})).await;
        assert_eq!(read(&mut ws).await["type"], "thread_caught_up");
        let _ = read(&mut ws).await;
    }
    #[tokio::test]
    async fn too_far_behind_resets() {
        let (_dir, host, url) = setup().await;
        let id = ThreadId::from("t");
        let epoch = host.store.thread_epoch(&id).unwrap();
        host.store
            .append(
                &id,
                (0..129)
                    .map(|_| LogEvent::ThreadChanged(ThreadChanged::default()))
                    .collect(),
            )
            .unwrap();
        let mut ws = connect(&url).await;
        write(&mut ws,json!({"type":"subscribe_thread","subId":"s","threadId":"t","after":{"epoch":epoch,"seq":1}})).await;
        assert_eq!(read(&mut ws).await["reason"], "too_far_behind");
    }
    #[tokio::test]
    async fn replay_deduplicates_buffered_live_lines_and_none_replays() {
        let (_dir, host, url) = setup().await;
        host.inject_line
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let mut ws = connect(&url).await;
        write(
            &mut ws,
            json!({"type":"subscribe_thread","subId":"s","threadId":"t"}),
        )
        .await;
        assert_eq!(read(&mut ws).await["line"]["seq"], 1);
        assert_eq!(read(&mut ws).await["type"], "thread_caught_up");
        assert_eq!(read(&mut ws).await["offset"], 0);
        let result = host
            .store
            .append(
                &ThreadId::from("t"),
                vec![LogEvent::ThreadChanged(ThreadChanged::default())],
            )
            .unwrap();
        host.lines
            .send(ThreadLive::Line(Arc::new(result.lines[0].clone())))
            .unwrap();
        assert_eq!(read(&mut ws).await["line"]["seq"], 2);
    }
    #[test]
    fn utf16_snapshot_deduplication() {
        assert!(text_matches_at("A😀B", 1, "😀"));
        assert!(!text_matches_at("A😀B", 1, "X"));
        assert!(!text_matches_at("A😀B", 4, "C"));
    }
    #[tokio::test]
    async fn slow_command_does_not_block_subscriptions() {
        let (_dir, _host, url) = setup().await;
        let mut ws = connect(&url).await;
        write(
            &mut ws,
            json!({"type":"rename_thread","reqId":"slow","clientRequestId":"slow-key","threadId":"t","title":"x"}),
        )
        .await;
        write(&mut ws, json!({"type":"subscribe_cards","subId":"c"})).await;
        assert_eq!(read(&mut ws).await["type"], "card_changed");
        assert_eq!(read(&mut ws).await["type"], "cards_caught_up");
        assert_eq!(read(&mut ws).await["reqId"], "slow");
    }
    #[tokio::test]
    async fn ping_timeout_excludes_host_stall() {
        let (_dir, host, _url) = setup().await;
        host.stalled_ms
            .store(1000, std::sync::atomic::Ordering::SeqCst);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = router_with(
            host.clone(),
            WsOptions {
                ping_interval: Duration::from_millis(30),
            },
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut ws = connect(&format!("ws://{addr}/ws")).await;
        for _ in 0..4 {
            assert_eq!(read(&mut ws).await["type"], "ping");
        }
        host.stalled_ms
            .store(0, std::sync::atomic::Ordering::SeqCst);
        let message = tokio::time::timeout(Duration::from_secs(1), ws.next())
            .await
            .unwrap();
        assert!(
            message.is_none()
                || matches!(message, Some(Err(_)))
                || matches!(message, Some(Ok(ClientMessage::Close(_))))
        );
    }
    #[tokio::test]
    async fn checkpoint_is_first_replayed_line() {
        let (_dir, host, url) = setup().await;
        let id = ThreadId::from("t");
        host.store
            .append(&id, vec![LogEvent::ThreadChanged(ThreadChanged::default())])
            .unwrap();
        // The store writes a checkpoint after every run.finished (seq 6 here).
        let run: goat2_contracts::RunId = "run_1".into();
        host.store
            .append(
                &id,
                vec![LogEvent::RunStarted(goat2_contracts::RunStarted {
                    run_id: run.clone(),
                    input_ids: vec![],
                    generation: 1,
                    engine_ref: None,
                })],
            )
            .unwrap();
        host.store
            .append(
                &id,
                vec![LogEvent::RunFinished(goat2_contracts::RunFinished {
                    run_id: run,
                    outcome: goat2_contracts::RunOutcome::Completed,
                    reason: None,
                })],
            )
            .unwrap();
        host.store
            .append(&id, vec![LogEvent::ThreadChanged(ThreadChanged::default())])
            .unwrap();
        let checkpoint = host.store.latest_checkpoint_seq(&id).unwrap().unwrap();
        let mut ws = connect(&url).await;
        write(
            &mut ws,
            json!({"type":"subscribe_thread","subId":"s","threadId":"t"}),
        )
        .await;
        let first = read(&mut ws).await;
        assert_eq!(first["line"]["seq"], checkpoint);
        assert_eq!(first["line"]["type"], "checkpoint");
        assert_eq!(read(&mut ws).await["line"]["seq"], checkpoint + 1);
        assert_eq!(read(&mut ws).await["type"], "thread_caught_up");
    }
    #[tokio::test]
    async fn bearer_header_authorizes_upgrade() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let (_dir, _host, url) = setup().await;
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Authorization", "Bearer secret".parse().unwrap());
        let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
        write(&mut ws, json!({"type":"subscribe_cards","subId":"c"})).await;
        assert_eq!(read(&mut ws).await["type"], "card_changed");
    }
}
