//! Codex sign-in for a provider instance, through Codex's own login (owner decision: GOAT 2 never
//! holds OpenAI tokens). Each flow runs a short-lived `codex app-server` in the instance's home
//! (its auth overlay, src/home_layout.rs), so a second account signs in to itself, and Codex
//! writes the instance's private `auth.json`: `account/login/start` (ChatGPT browser or device
//! code), `account/login/completed`, `account/login/cancel`, `account/logout`.
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
/// v1 providerAuthFlow `timeoutMs` default.
const FLOW_TIMEOUT: Duration = Duration::from_secs(300);
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
const UNKNOWN_METHOD: &str = "The provider did not advertise this sign-in method.";
const IN_PROGRESS: &str = "Provider setup is already in progress.";
const NOT_ACTIVE: &str = "This sign-in is no longer active in this client.";
const SIGNED_OUT: &str = "Signed out.";
const SIGN_OUT_FAILED: &str = "Could not sign out. Try again.";

/// The sign-in flows running, by provider instance (one at a time each, as v1).
#[derive(Default)]
pub struct AuthFlows {
    active: Mutex<HashMap<String, Active>>,
}

struct Active {
    flow_id: String,
    /// Ends the flow quietly: the canceller already answered with the terminal state.
    stop: Option<oneshot::Sender<()>>,
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

/// The browser or device-code interaction from Codex's login answer; None when it does not
/// match the pinned LoginAccountResponse or its URL is not http(s).
fn interaction(
    flow_id: &str,
    method: &str,
    answer: &Value,
) -> Option<(String, ProviderAuthInteraction)> {
    let text = |key: &str| answer.get(key)?.as_str().map(str::to_string);
    let web = |url: String| {
        let lower = url.to_ascii_lowercase();
        (lower.starts_with("https://") || lower.starts_with("http://")).then_some(url)
    };
    let login_id = text("loginId").filter(|id| !id.is_empty())?;
    match (method, answer.get("type")?.as_str()?) {
        (METHOD_CHATGPT, "chatgpt") => Some((
            login_id,
            ProviderAuthInteraction::Browser {
                id: flow_id.into(),
                url: web(text("authUrl")?)?,
                // Codex's own callback server finishes the login; there is nothing to paste.
                requires_consent: false,
                accepts_callback: None,
            },
        )),
        (METHOD_DEVICE_CODE, "chatgptDeviceCode") => Some((
            login_id,
            ProviderAuthInteraction::DeviceCode {
                id: flow_id.into(),
                url: web(text("verificationUrl")?)?,
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
    /// on `updates`; the sender is dropped after the end.
    pub fn start(
        self: &Arc<Self>,
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
        let id = flow_id();
        let expires_ms = now_ms() + FLOW_TIMEOUT.as_millis() as i64;
        let expires_at = format_rfc3339_ms(expires_ms);
        let (stop, stopped) = oneshot::channel();
        {
            let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
            if active.contains_key(instance.as_str()) {
                return Err(EngineError::Unavailable(IN_PROGRESS.into()));
            }
            active.insert(
                instance.as_str().to_string(),
                Active {
                    flow_id: id.clone(),
                    stop: Some(stop),
                },
            );
        }
        let flows = Arc::clone(self);
        let options = options.clone();
        let target = target.clone();
        let flow = id.clone();
        let expires = expires_at.clone();
        tokio::spawn(async move {
            let end = run(
                &options, &target, &flow, &method, &expires, &updates, stopped,
            )
            .await;
            let mut active = flows.active.lock().unwrap_or_else(|e| e.into_inner());
            let ours = active
                .get(target.instance_id.as_str())
                .is_some_and(|a| a.flow_id == flow);
            if ours {
                active.remove(target.instance_id.as_str());
                // Only a flow still active publishes its end; a cancelled one was answered.
                if let Some(end) = end {
                    let _ = updates.send(end);
                }
            }
        });
        Ok(state(
            &instance,
            ProviderAuthPhase::Starting,
            Some(&id),
            Some(&expires_at),
            STARTING,
            None,
        ))
    }

    /// v1 `providerAuthFlow.cancel`: the flow ends now and Codex's login is cancelled.
    pub fn cancel(
        &self,
        target: &ProviderTarget,
        flow_id: &str,
    ) -> Result<ProviderAuthState, EngineError> {
        let instance = target.instance_id.clone();
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        match active.get(instance.as_str()) {
            Some(a) if a.flow_id == flow_id => {}
            _ => return Err(EngineError::Unavailable(NOT_ACTIVE.into())),
        }
        if let Some(mut a) = active.remove(instance.as_str())
            && let Some(stop) = a.stop.take()
        {
            let _ = stop.send(());
        }
        Ok(state(
            &instance,
            ProviderAuthPhase::Cancelled,
            Some(flow_id),
            None,
            CANCELLED,
            None,
        ))
    }

    /// v1 `providerAuthFlow.logout`: a running flow ends, then Codex signs the instance out.
    pub async fn logout(
        &self,
        options: &CodexEngineOptions,
        target: &ProviderTarget,
    ) -> Result<ProviderAuthState, EngineError> {
        let instance = target.instance_id.clone();
        if let Some(mut a) = self
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(instance.as_str())
            && let Some(stop) = a.stop.take()
        {
            let _ = stop.send(());
        }
        let signed_out = match Codex::open(options, target).await {
            Ok(codex) => {
                let done = codex
                    .call(methods::ACCOUNT_LOGOUT, json!({}))
                    .await
                    .is_some();
                codex.close().await;
                done
            }
            Err(_) => false,
        };
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

/// One flow: Codex's login, the person's sign-in, Codex's confirmation. Returns the end state, or
/// None when it was stopped (cancel or logout already answered).
async fn run(
    options: &CodexEngineOptions,
    target: &ProviderTarget,
    flow_id: &str,
    method: &str,
    expires_at: &str,
    updates: &mpsc::UnboundedSender<ProviderAuthState>,
    mut stopped: oneshot::Receiver<()>,
) -> Option<ProviderAuthState> {
    let instance = &target.instance_id;
    let end =
        |phase, message: &str| Some(state(instance, phase, Some(flow_id), None, message, None));
    let deadline = Instant::now() + FLOW_TIMEOUT;
    let mut codex = tokio::select! {
        _ = &mut stopped => return None,
        opened = Codex::open(options, target) => match opened {
            Ok(codex) => codex,
            Err(message) => return end(ProviderAuthPhase::Failed, &message),
        },
    };
    let params = if method == METHOD_DEVICE_CODE {
        json!({"type": "chatgptDeviceCode"})
    } else {
        json!({"type": "chatgpt"})
    };
    let answer = tokio::select! {
        _ = &mut stopped => {
            codex.close().await;
            return None;
        }
        answer = codex.call(methods::ACCOUNT_LOGIN_START, params) => answer,
    };
    let Some((login_id, interaction)) = answer
        .as_ref()
        .and_then(|a| interaction(flow_id, method, a))
    else {
        codex.close().await;
        return end(ProviderAuthPhase::Failed, FAILED);
    };
    let _ = updates.send(state(
        instance,
        ProviderAuthPhase::Waiting,
        Some(flow_id),
        Some(expires_at),
        WAITING,
        Some(interaction),
    ));
    let completed = loop {
        tokio::select! {
            _ = &mut stopped => {
                let _ = codex.call(methods::ACCOUNT_LOGIN_CANCEL, json!({"loginId": login_id})).await;
                codex.close().await;
                return None;
            }
            _ = tokio::time::sleep_until(deadline) => {
                let _ = codex.call(methods::ACCOUNT_LOGIN_CANCEL, json!({"loginId": login_id})).await;
                codex.close().await;
                return end(ProviderAuthPhase::Failed, EXPIRED);
            }
            inbound = codex.inbound.recv() => match inbound {
                Some(Inbound::Notification(Notification::AccountLoginCompleted { login_id: done, success, .. }))
                    if done.as_deref().is_none_or(|d| d == login_id) => break success,
                Some(Inbound::Closed) | Some(Inbound::Retired { .. }) | None => {
                    codex.close().await;
                    return end(ProviderAuthPhase::Failed, FAILED);
                }
                Some(_) => {}
            },
        }
    };
    if !completed {
        codex.close().await;
        return end(ProviderAuthPhase::Failed, NOT_COMPLETED);
    }
    let _ = updates.send(state(
        instance,
        ProviderAuthPhase::Verifying,
        Some(flow_id),
        Some(expires_at),
        VERIFYING,
        None,
    ));
    let signed_in = codex.signed_in().await;
    codex.close().await;
    if signed_in {
        end(ProviderAuthPhase::Succeeded, SUCCEEDED)
    } else {
        end(ProviderAuthPhase::Failed, FAILED)
    }
}
