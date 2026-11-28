//! Codex sign-in for a provider instance, through Codex's own login (owner decision: GOAT 2 never
//! holds OpenAI tokens). Each flow runs a short-lived `codex app-server` in the instance's home
//! (its auth overlay, src/home_layout.rs), so a second account signs in to itself, and Codex
//! writes the instance's private `auth.json`: `account/login/start` (ChatGPT browser or device
//! code), `account/login/completed`, `account/logout`; a cancelled or expired flow ends its
//! Codex process, and Codex's login server with it.
//!
//! The flow states, phases and messages are v1's provider-auth flow
//! (packages/provider-core/src/server/providerAuthFlow.ts at goat 916b5ccc): starting ->
//! waiting (the interaction) -> verifying -> succeeded | failed, cancelled on cancel, idle after
//! logout, a 5 minute expiry. v1's own OpenAI OAuth client (CodexChatGptAuth.ts: GOAT-held
//! tokens, token sharing, saved ChatGPT profiles) is deliberately not carried.
//! The authorization URL is only in the returned states (never logged).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::task::JoinHandle;

use goat2_contracts::{
    CredentialOwner, ProviderAuthInteraction, ProviderAuthMethod, ProviderAuthMethodType,
    ProviderAuthPhase, ProviderAuthState, ProviderInstanceId,
};
use goat2_engine_api::{EngineError, ProviderTarget};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, timeout_at};

use crate::engine::{
    CodexEngineOptions, base_launch, instance_layout, instance_options, materialize,
};
use crate::home_layout::Redactor;
use crate::probe::format_rfc3339_ms;
use crate::process::ChildProcess;
use crate::protocol::client::InitializeParams;
use crate::protocol::methods;
use crate::protocol::server::Notification;
use crate::transport::{Connection, Inbound};

/// "Sign in with ChatGPT" (v1 method id): Codex's browser login with its own local callback.
pub const METHOD_CHATGPT: &str = "chatgpt";
/// ChatGPT sign-in with a one-time code entered on another device or browser.
pub const METHOD_DEVICE_CODE: &str = "chatgpt-device-code";
/// A Codex answer the flow waits for (initialize, login start, account read, logout).
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

const STARTING: &str = "Starting sign-in.";
const WAITING: &str = "Complete sign-in to continue.";
const VERIFYING: &str = "Checking provider sign-in.";
const SUCCEEDED: &str = "Sign-in complete.";
const FAILED: &str = "Sign-in failed. Start again.";
const EXPIRED: &str = "Sign-in expired. Start again.";
const CANCELLED: &str = "Sign-in cancelled.";
const NOT_COMPLETED: &str = "ChatGPT sign-in could not be completed. Start again.";
/// Beyond the process's own kill grace, how long a canceller waits for the flow to end before
/// it is aborted (which kills its Codex).
const STOP_MARGIN: Duration = Duration::from_secs(2);
/// Logout answers within this, so the host (30 s) always records an outcome.
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(20);
const UNKNOWN_METHOD: &str = "The provider did not advertise this sign-in method.";
const IN_PROGRESS: &str = "Provider setup is already in progress.";
const NOT_ACTIVE: &str = "This sign-in is no longer active in this client.";
const SIGNED_OUT: &str = "Signed out.";
const SIGN_OUT_FAILED: &str = "Could not sign out. Try again.";

/// The sign-in flows, one slot per provider instance (v1 keeps one flow per instance).
///
/// A slot owns its flow's update sender, so publishing is atomic with ending: once cancel,
/// logout or the flow itself has ended the flow, nothing more is sent, exactly one terminal state
/// went out (returned by the canceller, or sent by the flow), and the sender is closed. Starting,
/// cancelling and signing out an instance are serialized, and a canceller waits for the flow's
/// Codex to end, so an old login never overlaps a new one or a logout in the same home.
#[derive(Default)]
pub struct AuthFlows {
    slots: Mutex<HashMap<String, Arc<Slot>>>,
}

#[derive(Default)]
struct Slot {
    /// Serializes start, cancel and logout for the instance.
    op: tokio::sync::Mutex<()>,
    flow: Mutex<Option<Flow>>,
}

struct Flow {
    id: String,
    updates: mpsc::UnboundedSender<ProviderAuthState>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Slot {
    /// A state for the flow while it is still the active one.
    fn publish(&self, id: &str, state: ProviderAuthState) {
        if let Some(flow) = lock(&self.flow).as_ref()
            && flow.id == id
        {
            let _ = flow.updates.send(state);
        }
    }

    /// The flow's own end: its terminal state, then its sender closes.
    fn finish(&self, id: &str, end: ProviderAuthState) {
        let mut flow = lock(&self.flow);
        if flow.as_ref().is_some_and(|f| f.id == id)
            && let Some(f) = flow.take()
        {
            let _ = f.updates.send(end);
        }
    }

    /// Ends the active flow for a canceller (only the one named, when `expected` is given):
    /// it is removed so it publishes nothing more, `last` is its terminal state on its stream (if
    /// any), its sender closes, and its Codex has ended when this returns. `Err` when the named
    /// flow is not the active one; `Ok(false)` when there was none.
    async fn end(
        &self,
        expected: Option<&str>,
        last: Option<ProviderAuthState>,
        grace: Duration,
    ) -> Result<bool, ()> {
        let flow = {
            let mut slot = lock(&self.flow);
            match (slot.as_ref(), expected) {
                (Some(f), Some(id)) if f.id != id => return Err(()),
                (None, Some(_)) => return Err(()),
                (None, None) => return Ok(false),
                _ => {}
            }
            slot.take()
        };
        let Some(Flow {
            updates,
            stop,
            task,
            ..
        }) = flow
        else {
            return Ok(false);
        };
        if let Some(last) = last {
            let _ = updates.send(last);
        }
        drop(updates);
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        if let Some(mut task) = task
            && tokio::time::timeout(grace, &mut task).await.is_err()
        {
            // Dropping the flow kills its Codex process group.
            task.abort();
            let _ = task.await;
        }
        Ok(true)
    }
}

impl Drop for AuthFlows {
    /// The factory is gone: every flow's Codex ends with it.
    fn drop(&mut self) {
        for slot in lock(&self.slots).values() {
            if let Some(mut flow) = lock(&slot.flow).take()
                && let Some(task) = flow.task.take()
            {
                task.abort();
            }
        }
    }
}

/// v1 Codex sign-in methods (CodexChatGptAuth.ts:820-832 names "Sign in with ChatGPT"), with
/// Codex's device-code login added; the account's email names the ChatGPT method when known.
pub fn methods(email: Option<String>) -> Vec<ProviderAuthMethod> {
    vec![
        ProviderAuthMethod {
            id: METHOD_CHATGPT.into(),
            account_email: email.clone(),
            can_remove: None,
            name: "Sign in with ChatGPT".into(),
            description: email.map(|e| format!("Reconnect {e}.")),
            r#type: ProviderAuthMethodType::Agent,
        },
        ProviderAuthMethod {
            id: METHOD_DEVICE_CODE.into(),
            account_email: None,
            can_remove: None,
            name: "Sign in with a device code".into(),
            description: Some(
                "Open the sign-in page on any device and enter a one-time code.".into(),
            ),
            r#type: ProviderAuthMethodType::Agent,
        },
    ]
}

/// A v1 provider-auth state for this instance (credentials owned by Codex).
fn state(
    instance: &ProviderInstanceId,
    phase: ProviderAuthPhase,
    flow_id: Option<&str>,
    expires_at: Option<&str>,
    message: &str,
    interaction: Option<ProviderAuthInteraction>,
) -> ProviderAuthState {
    let authorization_url = match &interaction {
        Some(ProviderAuthInteraction::Browser { url, .. })
        | Some(ProviderAuthInteraction::DeviceCode { url, .. }) => Some(url.clone()),
        _ => None,
    };
    ProviderAuthState {
        instance_id: instance.clone(),
        phase,
        flow_id: flow_id.map(str::to_string),
        authorization_url,
        expires_at: expires_at.map(str::to_string),
        message: Some(message.into()),
        methods: Some(methods(None)),
        interaction: Some(interaction),
        credential_owner: Some(CredentialOwner::Provider),
    }
}

/// A short-lived app-server in the instance's home.
struct Codex {
    child: ChildProcess,
    conn: Connection,
    inbound: mpsc::UnboundedReceiver<Inbound>,
}

impl Codex {
    async fn open(options: &CodexEngineOptions, target: &ProviderTarget) -> Result<Self, String> {
        let layout = instance_layout(options, Some(target));
        if let Some(layout) = &layout {
            materialize(layout)?;
        }
        let options = instance_options(options, target.launch.as_ref());
        let cwd = std::env::temp_dir();
        let launch = base_launch(&options, &options.program, cwd, layout.as_ref());
        let mut child = ChildProcess::spawn(&launch).map_err(|_| FAILED.to_string())?;
        let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
            child.kill_group();
            return Err(FAILED.into());
        };
        let (conn, inbound) =
            Connection::start_with(stdin, stdout, None, options.transport.clone());
        let codex = Self {
            child,
            conn,
            inbound,
        };
        let deadline = Instant::now() + CALL_TIMEOUT;
        let initialized = timeout_at(
            deadline,
            codex.conn.request_value(
                methods::INITIALIZE,
                &InitializeParams::goat(&options.client_version),
            ),
        )
        .await;
        if !matches!(initialized, Ok(Ok(_)))
            || codex
                .conn
                .notify(methods::INITIALIZED, &Value::Null)
                .is_err()
        {
            codex.close().await;
            return Err(FAILED.into());
        }
        Ok(codex)
    }

    async fn call(&self, method: &str, params: Value) -> Option<Value> {
        timeout_at(
            Instant::now() + CALL_TIMEOUT,
            self.conn.request_value(method, &params),
        )
        .await
        .ok()?
        .ok()
    }

    /// The signed-in account's email, if the instance has a ChatGPT account.
    async fn account_email(&self) -> Option<String> {
        let account = self.call(methods::ACCOUNT_READ, json!({})).await?;
        let account = account.get("account")?;
        (account.get("type")?.as_str()? == "chatgpt")
            .then(|| account.get("email")?.as_str().map(str::to_string))
            .flatten()
            .filter(|e| !e.is_empty())
    }

    /// Whether the instance has any account after a login.
    async fn signed_in(&self) -> bool {
        self.call(methods::ACCOUNT_READ, json!({}))
            .await
            .and_then(|a| a.get("account").map(|a| !a.is_null()))
            .unwrap_or(false)
    }

    async fn close(mut self) {
        self.conn.close_input();
        self.child.terminate_group().await;
    }
}

/// A sign-in URL GOAT shows: the contract's SignInUrl rule and a WHATWG http(s) URL.
fn sign_in_url(url: String) -> Option<String> {
    goat2_contracts::serde_util::sign_in_url::check(&url).ok()?;
    let parsed = url::Url::parse(&url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then_some(url)
}

/// The browser or device-code interaction from Codex's login answer; None when it does not
/// match the pinned LoginAccountResponse or its URL is not a usable sign-in URL.
fn interaction(
    flow_id: &str,
    method: &str,
    answer: &Value,
) -> Option<(String, ProviderAuthInteraction)> {
    let text = |key: &str| answer.get(key)?.as_str().map(str::to_string);
    let login_id = text("loginId").filter(|id| !id.is_empty())?;
    match (method, answer.get("type")?.as_str()?) {
        (METHOD_CHATGPT, "chatgpt") => Some((
            login_id,
            ProviderAuthInteraction::Browser {
                id: flow_id.into(),
                url: sign_in_url(text("authUrl")?)?,
                // Codex's own callback server finishes the login; there is nothing to paste.
                requires_consent: false,
                accepts_callback: None,
            },
        )),
        (METHOD_DEVICE_CODE, "chatgptDeviceCode") => Some((
            login_id,
            ProviderAuthInteraction::DeviceCode {
                id: flow_id.into(),
                url: sign_in_url(text("verificationUrl")?)?,
                user_code: text("userCode").filter(|c| !c.is_empty())?,
            },
        )),
        _ => None,
    }
}

/// An unguessable flow id (v1 uses a random UUID v4).
fn flow_id() -> String {
    let mut bytes = [0u8; 16];
    #[cfg(unix)]
    let filled = {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut bytes))
            .is_ok()
    };
    #[cfg(not(unix))]
    let filled = false;
    if !filled {
        // Windows is Part 2: a time and address mix, unique within the process.
        use std::hash::{BuildHasher, Hasher};
        for chunk in bytes.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
            );
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl AuthFlows {
    fn slot(&self, instance: &ProviderInstanceId) -> Arc<Slot> {
        Arc::clone(
            lock(&self.slots)
                .entry(instance.as_str().to_string())
                .or_default(),
        )
    }

    /// The methods, naming the instance's ChatGPT account when Codex can read it.
    pub async fn methods(
        &self,
        options: &CodexEngineOptions,
        target: &ProviderTarget,
    ) -> Vec<ProviderAuthMethod> {
        let email = match Codex::open(options, target).await {
            Ok(codex) => {
                let email = codex.account_email().await;
                codex.close().await;
                email
            }
            Err(_) => None,
        };
        let redact = redactor(options, target);
        methods(email.map(|e| redact.apply(&e)))
    }

    /// v1 `providerAuthFlow.start`: the starting state now, then waiting, verifying and the end
    /// on `updates`; the sender is dropped after the end. One deadline, set here, bounds the whole
    /// flow (v1 times out the scoped flow).
    pub async fn start(
        &self,
        options: &CodexEngineOptions,
        target: &ProviderTarget,
        method_id: Option<String>,
        updates: mpsc::UnboundedSender<ProviderAuthState>,
    ) -> Result<ProviderAuthState, EngineError> {
        let instance = target.instance_id.clone();
        let method = method_id.unwrap_or_else(|| METHOD_CHATGPT.into());
        if method != METHOD_CHATGPT && method != METHOD_DEVICE_CODE {
            return Ok(state(
                &instance,
                ProviderAuthPhase::Failed,
                None,
                None,
                UNKNOWN_METHOD,
                None,
            ));
        }
        let slot = self.slot(&instance);
        let _op = slot.op.lock().await;
        let id = flow_id();
        // v1 providerAuthFlow timeoutMs (300 s by default).
        let deadline = Instant::now() + options.auth_timeout;
        let expires_at = format_rfc3339_ms(now_ms() + options.auth_timeout.as_millis() as i64);
        let (stop, mut stopped) = oneshot::channel();
        {
            let mut flow = lock(&slot.flow);
            if flow.is_some() {
                return Err(EngineError::Unavailable(IN_PROGRESS.into()));
            }
            *flow = Some(Flow {
                id: id.clone(),
                updates,
                stop: Some(stop),
                task: None,
            });
        }
        let task = {
            let slot = Arc::clone(&slot);
            let options = options.clone();
            let target = target.clone();
            let id = id.clone();
            let expires_at = expires_at.clone();
            tokio::spawn(async move {
                let instance = target.instance_id.clone();
                let expired = || {
                    state(
                        &instance,
                        ProviderAuthPhase::Failed,
                        Some(&id),
                        None,
                        EXPIRED,
                        None,
                    )
                };
                // Stopped: the canceller already answered; it waits for this task, so the flow's
                // Codex is gone when the canceller returns.
                let mut codex = tokio::select! {
                    biased;
                    _ = &mut stopped => return,
                    _ = tokio::time::sleep_until(deadline) => return slot.finish(&id, expired()),
                    opened = Codex::open(&options, &target) => match opened {
                        Ok(codex) => codex,
                        Err(message) => {
                            let failed = state(&instance, ProviderAuthPhase::Failed, Some(&id), None, &message, None);
                            return slot.finish(&id, failed);
                        }
                    },
                };
                let end = tokio::select! {
                    biased;
                    _ = &mut stopped => None,
                    _ = tokio::time::sleep_until(deadline) => Some(expired()),
                    end = run(&mut codex, &target, &id, &method, &expires_at, &slot) => Some(end),
                };
                // The process group has ended before the flow is released, so no old login can
                // still write credentials once a new flow or a logout may run.
                codex.close().await;
                if let Some(end) = end {
                    slot.finish(&id, end);
                }
            })
        };
        if let Some(flow) = lock(&slot.flow).as_mut()
            && flow.id == id
        {
            flow.task = Some(task);
        }
        Ok(state(
            &instance,
            ProviderAuthPhase::Starting,
            Some(&id),
            Some(&expires_at),
            STARTING,
            None,
        ))
    }

    /// v1 `providerAuthFlow.cancel`: the flow ends (its Codex with it, which ends Codex's login) and
    /// the cancelled state is the answer; its stream closes without another state.
    pub async fn cancel(
        &self,
        options: &CodexEngineOptions,
        target: &ProviderTarget,
        flow_id: &str,
    ) -> Result<ProviderAuthState, EngineError> {
        let instance = target.instance_id.clone();
        let slot = self.slot(&instance);
        let _op = slot.op.lock().await;
        slot.end(Some(flow_id), None, options.kill_grace + STOP_MARGIN)
            .await
            .map_err(|_| EngineError::Unavailable(NOT_ACTIVE.into()))?;
        Ok(state(
            &instance,
            ProviderAuthPhase::Cancelled,
            Some(flow_id),
            None,
            CANCELLED,
            None,
        ))
    }

    /// v1 `providerAuthFlow.logout`: a running flow ends first (its stream gets the cancelled state
    /// and closes, its Codex has ended), then Codex signs the instance out, within a bound so the
    /// host always gets an answer.
    pub async fn logout(
        &self,
        options: &CodexEngineOptions,
        target: &ProviderTarget,
    ) -> Result<ProviderAuthState, EngineError> {
        let instance = target.instance_id.clone();
        let slot = self.slot(&instance);
        let _op = slot.op.lock().await;
        let active_id = lock(&slot.flow).as_ref().map(|f| f.id.clone());
        if let Some(id) = active_id {
            let last = state(
                &instance,
                ProviderAuthPhase::Cancelled,
                Some(&id),
                None,
                CANCELLED,
                None,
            );
            let _ = slot
                .end(Some(&id), Some(last), options.kill_grace + STOP_MARGIN)
                .await;
        }
        let signed_out = tokio::time::timeout(LOGOUT_TIMEOUT, async {
            let codex = Codex::open(options, target).await.ok()?;
            let done = codex
                .call(methods::ACCOUNT_LOGOUT, json!({}))
                .await
                .is_some();
            codex.close().await;
            Some(done)
        })
        .await
        .ok()
        .flatten()
        .unwrap_or(false);
        let (phase, message) = if signed_out {
            (ProviderAuthPhase::Idle, SIGNED_OUT)
        } else {
            (ProviderAuthPhase::Failed, SIGN_OUT_FAILED)
        };
        Ok(state(&instance, phase, None, None, message, None))
    }
}

fn redactor(options: &CodexEngineOptions, target: &ProviderTarget) -> Redactor {
    Redactor::for_layout(instance_layout(options, Some(target)).as_ref())
}

/// One flow in an open Codex: its login, the person's sign-in, Codex's confirmation; returns
/// the end state. The caller ends the process.
async fn run(
    codex: &mut Codex,
    target: &ProviderTarget,
    flow_id: &str,
    method: &str,
    expires_at: &str,
    slot: &Slot,
) -> ProviderAuthState {
    let instance = &target.instance_id;
    let end = |phase, message: &str| state(instance, phase, Some(flow_id), None, message, None);
    let params = if method == METHOD_DEVICE_CODE {
        json!({"type": "chatgptDeviceCode"})
    } else {
        json!({"type": "chatgpt"})
    };
    let answer = codex.call(methods::ACCOUNT_LOGIN_START, params).await;
    let Some((login_id, interaction)) = answer
        .as_ref()
        .and_then(|a| interaction(flow_id, method, a))
    else {
        return end(ProviderAuthPhase::Failed, FAILED);
    };
    slot.publish(
        flow_id,
        state(
            instance,
            ProviderAuthPhase::Waiting,
            Some(flow_id),
            Some(expires_at),
            WAITING,
            Some(interaction),
        ),
    );
    let completed = loop {
        match codex.inbound.recv().await {
            Some(Inbound::Notification(Notification::AccountLoginCompleted {
                login_id: done,
                success,
                ..
            })) if done.as_deref().is_none_or(|d| d == login_id) => break success,
            Some(Inbound::Closed) | Some(Inbound::Retired { .. }) | None => {
                return end(ProviderAuthPhase::Failed, FAILED);
            }
            Some(_) => {}
        }
    };
    if !completed {
        return end(ProviderAuthPhase::Failed, NOT_COMPLETED);
    }
    slot.publish(
        flow_id,
        state(
            instance,
            ProviderAuthPhase::Verifying,
            Some(flow_id),
            Some(expires_at),
            VERIFYING,
            None,
        ),
    );
    if codex.signed_in().await {
        end(ProviderAuthPhase::Succeeded, SUCCEEDED)
    } else {
        end(ProviderAuthPhase::Failed, FAILED)
    }
}
