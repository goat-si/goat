//! Claude sign-in (v1 `ClaudeAuth.ts`, `providerLoginTerminal.ts`, `providerAuthFlow.ts` at
//! `916b5ccc1b2`): one method, "Sign in with Claude", which runs `claude auth login` in a
//! terminal the person sees and types into, with the instance's binary, environment and Claude
//! home (`CLAUDE_CONFIG_DIR`). When the command exits 0 the flow checks `claude auth status`.
//! Logout runs `claude auth logout`.
//!
//! Phases and messages follow v1: the start state is `waiting` with a terminal interaction
//! (v1 publishes `starting` and then `waiting` within the same start), each output chunk
//! updates it, then `verifying`, then `succeeded` or `failed`; cancel gives `cancelled`;
//! a flow expires after 5 minutes. Terminal output keeps the last 16,384 characters with a running
//! offset (v1). What the person types is a secret: it goes to the terminal and nowhere else (no
//! log, state, event or error); the terminal's own echo is turned off, so only what the CLI itself
//! prints is shown.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use goat2_contracts::{
    CredentialOwner, ProviderAuthInteraction, ProviderAuthMethod, ProviderAuthMethodType,
    ProviderAuthPhase, ProviderAuthResponse, ProviderAuthState,
};
use goat2_engine_api::{EngineError, ProviderTarget};
use tokio::sync::mpsc;

use crate::launch::LaunchOptions;

/// v1 method id and texts (ClaudeAuth.ts:52-58).
pub const METHOD_ID: &str = "claude-login";
const INTERACTION_ID: &str = "terminal";
/// v1 `providerAuthFlow` default timeout.
const FLOW_TIMEOUT: Duration = Duration::from_secs(300);
/// v1 terminal transcript size.
const TRANSCRIPT_CHARS: usize = 16_384;

pub fn methods() -> Vec<ProviderAuthMethod> {
    vec![ProviderAuthMethod {
        id: METHOD_ID.to_string(),
        account_email: None,
        can_remove: None,
        name: "Sign in with Claude".to_string(),
        description: Some("Sign in using the official Claude Code CLI.".to_string()),
        r#type: ProviderAuthMethodType::Terminal,
    }]
}

fn base_state(target: &ProviderTarget) -> ProviderAuthState {
    ProviderAuthState {
        instance_id: target.instance_id.clone(),
        phase: ProviderAuthPhase::Idle,
        flow_id: None,
        authorization_url: None,
        expires_at: None,
        message: None,
        methods: Some(methods()),
        interaction: None,
        credential_owner: Some(CredentialOwner::Provider),
    }
}

struct Flow {
    id: String,
    state: Mutex<ProviderAuthState>,
    updates: Mutex<Option<mpsc::UnboundedSender<ProviderAuthState>>>,
    #[cfg(unix)]
    terminal: pty::Terminal,
}

impl Flow {
    fn current(&self) -> ProviderAuthState {
        self.state
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|e| e.into_inner().clone())
    }

    /// Publish a change unless the flow already ended; a terminal phase drops the sender.
    fn publish(&self, change: impl FnOnce(&mut ProviderAuthState)) -> Option<ProviderAuthState> {
        let mut updates = self.updates.lock().ok()?;
        let sender = updates.as_ref()?;
        let mut state = self.state.lock().ok()?;
        change(&mut state);
        let _ = sender.send(state.clone());
        if matches!(
            state.phase,
            ProviderAuthPhase::Succeeded | ProviderAuthPhase::Failed | ProviderAuthPhase::Cancelled
        ) {
            *updates = None;
        }
        Some(state.clone())
    }

    fn ended(&self) -> bool {
        self.updates.lock().map(|u| u.is_none()).unwrap_or(true)
    }
}

/// Sign-in flows by provider instance; at most one runs per instance.
#[derive(Default)]
pub struct AuthFlows {
    flows: Mutex<HashMap<String, Arc<Flow>>>,
}

impl std::fmt::Debug for AuthFlows {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthFlows").finish_non_exhaustive()
    }
}

fn not_running() -> EngineError {
    EngineError::Unavailable("This sign-in is no longer running. Start again.".into())
}

impl AuthFlows {
    fn flow(&self, target: &ProviderTarget, flow_id: &str) -> Result<Arc<Flow>, EngineError> {
        self.flows
            .lock()
            .ok()
            .and_then(|flows| flows.get(target.instance_id.as_str()).cloned())
            .filter(|flow| flow.id == flow_id && !flow.ended())
            .ok_or_else(not_running)
    }

    fn remove(&self, instance: &str, flow_id: &str) {
        if let Ok(mut flows) = self.flows.lock()
            && flows.get(instance).is_some_and(|f| f.id == flow_id)
        {
            flows.remove(instance);
        }
    }

    /// Stop the instance's running flow (cancelled), if any.
    fn stop(&self, instance: &str) {
        let flow = self.flows.lock().ok().and_then(|mut f| f.remove(instance));
        if let Some(flow) = flow {
            flow.publish(cancelled);
            #[cfg(unix)]
            flow.terminal.kill();
        }
    }

    #[cfg(not(unix))]
    pub async fn start(
        self: &Arc<Self>,
        _launch: LaunchOptions,
        _target: &ProviderTarget,
        _method_id: Option<String>,
        _updates: mpsc::UnboundedSender<ProviderAuthState>,
    ) -> Result<ProviderAuthState, EngineError> {
        Err(EngineError::Unsupported("auth_start".into()))
    }

    #[cfg(unix)]
    pub async fn start(
        self: &Arc<Self>,
        launch: LaunchOptions,
        target: &ProviderTarget,
        method_id: Option<String>,
        updates: mpsc::UnboundedSender<ProviderAuthState>,
    ) -> Result<ProviderAuthState, EngineError> {
        if method_id.as_deref().is_some_and(|m| m != METHOD_ID) {
            return Err(EngineError::Unsupported(
                "The provider did not advertise this sign-in method.".into(),
            ));
        }
        let instance = target.instance_id.to_string();
        self.stop(&instance);
        let terminal = pty::Terminal::spawn(&launch, &["auth", "login"]).map_err(|_| {
            EngineError::StartFailed("Could not open the provider sign-in terminal.".into())
        })?;
        let id = format!("claude-auth-{}", crate::util::uuid());
        let expires = chrono_like_now_plus(FLOW_TIMEOUT);
        let mut state = base_state(target);
        state.phase = ProviderAuthPhase::Waiting;
        state.flow_id = Some(id.clone());
        state.expires_at = Some(expires);
        state.message = Some("Complete sign-in to continue.".into());
        state.interaction = Some(Some(ProviderAuthInteraction::Terminal {
            id: INTERACTION_ID.into(),
            output: String::new(),
            output_offset: Some(0),
        }));
        let flow = Arc::new(Flow {
            id: id.clone(),
            state: Mutex::new(state.clone()),
            updates: Mutex::new(Some(updates)),
            terminal,
        });
        if let Ok(mut flows) = self.flows.lock() {
            flows.insert(instance.clone(), flow.clone());
        }
        // Output: each chunk replaces the transcript (last 16,384 characters) and moves the offset.
        let reader = flow.terminal.reader();
        let output_flow = flow.clone();
        let output = std::thread::spawn(move || {
            let mut transcript = String::new();
            let mut offset: u64 = 0;
            let mut pending: Vec<u8> = Vec::new();
            let mut buffer = [0u8; 4096];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                pending.extend_from_slice(&buffer[..read]);
                // Keep an incomplete UTF-8 sequence for the next read.
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(error) if error.error_len().is_none() => error.valid_up_to(),
                    Err(_) => pending.len(),
                };
                let chunk = String::from_utf8_lossy(&pending[..valid]).into_owned();
                pending.drain(..valid);
                if chunk.is_empty() {
                    continue;
                }
                offset += chunk.chars().count() as u64;
                transcript.push_str(&chunk);
                let excess = transcript.chars().count().saturating_sub(TRANSCRIPT_CHARS);
                if excess > 0 {
                    let cut = transcript
                        .char_indices()
                        .nth(excess)
                        .map_or(transcript.len(), |(i, _)| i);
                    transcript.drain(..cut);
                }
                let text = transcript.clone();
                output_flow.publish(|s| {
                    if s.phase == ProviderAuthPhase::Waiting {
                        s.interaction = Some(Some(ProviderAuthInteraction::Terminal {
                            id: INTERACTION_ID.into(),
                            output: text,
                            output_offset: Some(offset),
                        }));
                    }
                });
            }
        });
        let flows = self.clone();
        let finish_flow = flow.clone();
        tokio::spawn(async move {
            let waiter = finish_flow.clone();
            let exit = tokio::time::timeout(
                FLOW_TIMEOUT,
                tokio::task::spawn_blocking(move || waiter.terminal.wait()),
            )
            .await;
            let code = match exit {
                Ok(Ok(code)) => code,
                Ok(Err(_)) => None,
                Err(_) => {
                    finish_flow.terminal.kill();
                    finish_flow.publish(|s| failed(s, "Sign-in expired. Start again."));
                    flows.remove(&instance, &finish_flow.id);
                    return;
                }
            };
            // The last output lands before the result.
            let _ = tokio::task::spawn_blocking(move || output.join()).await;
            if finish_flow.ended() {
                flows.remove(&instance, &finish_flow.id);
                return;
            }
            if code != Some(0) {
                finish_flow.publish(|s| {
                    failed(s, "The provider login command did not finish successfully.")
                });
                flows.remove(&instance, &finish_flow.id);
                return;
            }
            finish_flow.publish(|s| {
                s.phase = ProviderAuthPhase::Verifying;
                s.interaction = Some(None);
                s.authorization_url = None;
                s.message = Some("Checking provider sign-in.".into());
            });
            let signed_in = match crate::probe::run(&launch, &["auth", "status"]).await {
                Ok((_, stdout)) => {
                    crate::probe::parse_auth_status(&stdout).status
                        == goat2_contracts::ServerProviderAuthStatus::Authenticated
                }
                Err(_) => false,
            };
            finish_flow.publish(|s| {
                if signed_in {
                    s.phase = ProviderAuthPhase::Succeeded;
                    s.interaction = Some(None);
                    s.authorization_url = None;
                    s.expires_at = None;
                    s.message = Some("Sign-in complete.".into());
                } else {
                    failed(s, "Claude could not confirm the authentication change.");
                }
            });
            flows.remove(&instance, &finish_flow.id);
        });
        Ok(state)
    }

    /// Terminal input and size for the running flow. The data is written to the terminal only.
    pub fn respond(
        &self,
        target: &ProviderTarget,
        flow_id: &str,
        interaction_id: &str,
        response: ProviderAuthResponse,
    ) -> Result<ProviderAuthState, EngineError> {
        let flow = self.flow(target, flow_id)?;
        if interaction_id != INTERACTION_ID {
            return Err(EngineError::Unsupported(
                "This sign-in is not waiting for that answer.".into(),
            ));
        }
        let ProviderAuthResponse::Terminal { data, size } = response else {
            return Err(EngineError::Unsupported(
                "This sign-in takes terminal input only.".into(),
            ));
        };
        #[cfg(unix)]
        {
            let unavailable = || {
                EngineError::Unavailable(
                    "The provider sign-in terminal is no longer available.".into(),
                )
            };
            if let Some(size) = size {
                flow.terminal
                    .resize(size.cols, size.rows)
                    .map_err(|_| unavailable())?;
            }
            if !data.is_empty() {
                flow.terminal
                    .write(data.as_bytes())
                    .map_err(|_| unavailable())?;
            }
        }
        #[cfg(not(unix))]
        let _ = (data, size);
        Ok(flow.current())
    }

    pub fn cancel(
        &self,
        target: &ProviderTarget,
        flow_id: &str,
    ) -> Result<ProviderAuthState, EngineError> {
        let flow = self.flow(target, flow_id)?;
        let state = flow.publish(cancelled).unwrap_or_else(|| flow.current());
        #[cfg(unix)]
        flow.terminal.kill();
        self.remove(target.instance_id.as_str(), flow_id);
        Ok(state)
    }

    /// v1 logout: stop a running sign-in, run `claude auth logout`, answer idle ("Signed out.").
    pub async fn logout(
        &self,
        launch: &LaunchOptions,
        target: &ProviderTarget,
    ) -> Result<ProviderAuthState, EngineError> {
        self.stop(target.instance_id.as_str());
        match crate::probe::run(launch, &["auth", "logout"]).await {
            Ok((true, _)) => {
                let mut state = base_state(target);
                state.message = Some("Signed out.".into());
                Ok(state)
            }
            _ => Err(EngineError::Unavailable(
                "Could not sign out. Try again.".into(),
            )),
        }
    }
}

fn failed(state: &mut ProviderAuthState, message: &str) {
    state.phase = ProviderAuthPhase::Failed;
    state.interaction = Some(None);
    state.authorization_url = None;
    state.expires_at = None;
    state.message = Some(message.into());
}

fn cancelled(state: &mut ProviderAuthState) {
    state.phase = ProviderAuthPhase::Cancelled;
    state.interaction = Some(None);
    state.authorization_url = None;
    state.expires_at = None;
    state.message = Some("Sign-in cancelled.".into());
}

/// RFC 3339 time `after` from now (UTC).
fn chrono_like_now_plus(after: Duration) -> String {
    crate::util::rfc3339_after(after)
}

#[cfg(unix)]
mod pty {
    //! A pseudo-terminal running one CLI command as its own session leader (so a kill reaches
    //! everything it started), with the driver's environment rules.

    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::{Arc, Mutex};

    use crate::launch::LaunchOptions;

    pub struct Terminal {
        master: Arc<File>,
        child: Mutex<Child>,
        pid: i32,
    }

    pub struct Reader(Arc<File>);

    impl Reader {
        /// Blocking read; 0 or an error once the command and everything holding the terminal
        /// have exited.
        pub fn read(&self, buffer: &mut [u8]) -> std::io::Result<usize> {
            (&*self.0).read(buffer)
        }
    }

    impl Terminal {
        pub fn spawn(launch: &LaunchOptions, args: &[&str]) -> std::io::Result<Self> {
            let mut master: libc::c_int = -1;
            let mut slave: libc::c_int = -1;
            let mut size = libc::winsize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: out-pointers to locals; no name buffer or termios requested.
            let opened = unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut size,
                )
            };
            if opened != 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: openpty returned two open descriptors that nothing else owns.
            let (master, slave) =
                unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
            for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
                // SAFETY: fcntl on an owned descriptor.
                unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
            }
            // What the person types is not echoed back by the terminal (a secret); the CLI shows
            // only what it prints itself.
            // SAFETY: termios read and write on an owned descriptor.
            unsafe {
                let mut termios: libc::termios = std::mem::zeroed();
                if libc::tcgetattr(slave.as_raw_fd(), &mut termios) == 0 {
                    termios.c_lflag &= !(libc::ECHO | libc::ECHONL);
                    libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &termios);
                }
            }
            let mut command = Command::new(&launch.binary);
            command.args(args);
            let (removed, set) = crate::probe::cli_env(launch);
            for name in removed {
                command.env_remove(name);
            }
            for (key, value) in set {
                command.env(key, value);
            }
            command.env("TERM", "xterm-256color");
            command
                .stdin(Stdio::from(slave.try_clone()?))
                .stdout(Stdio::from(slave.try_clone()?))
                .stderr(Stdio::from(slave));
            // SAFETY: only async-signal-safe calls between fork and exec.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let child = command.spawn()?;
            // The parent's copies of the terminal's other end close with `command`.
            drop(command);
            let pid = child.id() as i32;
            Ok(Self {
                master: Arc::new(File::from(master)),
                child: Mutex::new(child),
                pid,
            })
        }

        pub fn reader(&self) -> Reader {
            Reader(self.master.clone())
        }

        pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
            let mut master = &*self.master;
            master.write_all(data)?;
            master.flush()
        }

        pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
            let size = libc::winsize {
                ws_row: rows,
                ws_col: cols,
                ws_xpixel: 0,
                ws_ypixel: 0,
            };
            // SAFETY: TIOCSWINSZ with a valid winsize on an owned descriptor.
            if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }

        /// Blocks until the command exits; its exit code (None when killed by a signal).
        pub fn wait(&self) -> Option<i32> {
            loop {
                let status = {
                    let mut child = self.child.lock().ok()?;
                    match child.try_wait() {
                        Ok(Some(status)) => Some(status),
                        Ok(None) => None,
                        Err(_) => return None,
                    }
                };
                match status {
                    Some(status) => return status.code(),
                    None => std::thread::sleep(std::time::Duration::from_millis(50)),
                }
            }
        }

        /// TERM, then KILL, to the command's whole session.
        pub fn kill(&self) {
            // SAFETY: signals to the process group this terminal's command leads.
            unsafe {
                libc::kill(-self.pid, libc::SIGTERM);
            }
            let pid = self.pid;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(2));
                // SAFETY: as above; a group that already exited makes this a no-op.
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            });
        }
    }

    impl Drop for Terminal {
        fn drop(&mut self) {
            if let Ok(mut child) = self.child.lock()
                && matches!(child.try_wait(), Ok(None))
            {
                // SAFETY: as in `kill`.
                unsafe {
                    libc::kill(-self.pid, libc::SIGKILL);
                }
                let _ = child.wait();
            }
        }
    }
}
