//! Spawning an ACP agent in its own process group at lower CPU priority, and ending the whole
//! group. Same mechanics as lane B's `goat2-engine-codex/src/process.rs` (drivers do not depend on
//! each other, so the file is carried here); v1 equivalent: `packages/provider-acp/src/server/
//! posixProcessTree.ts` (ACP agents own a detached process group, TERM then KILL).
//!
//! Unix: `process_group(0)` makes the child a group leader; `setpriority` from the host right
//! after the spawn lowers it (and every descendant it spawns, such as agent tool commands) by
//! `Launch::nice`; `kill(-pgid)` ends the group. Windows: the direct child only (Job Objects are
//! Part 2).
//!
//! No `pre_exec` hook: one makes std fork and exec instead of `posix_spawn`, and on macOS a fork
//! while another host thread is inside a libSystem once-initializer (libnotify, reached through
//! `getpwuid_r` and name lookups) aborts the forked child in `_notify_fork_child`
//! (`_os_once_gate_corruption_abort`, SIGKILL) before it runs the agent. Seen as agents dying at
//! `initialize` under parallel load.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::stderr::StderrTail;

/// Called with each stderr line, without its line ending.
pub type StderrHook = Arc<dyn Fn(&str) + Send + Sync>;

/// In a launch command's `env_remove` (see [Launch::remove_env]): a name ending in `*` removes
/// every inherited variable with that prefix, so `*` alone removes the whole inherited
/// environment and the child gets exactly the variables set for it. Registry agents use it to
/// run with the complete environment the registry resolved (v1 AcpRegistrySupport.ts:1739-1743,
/// 1840-1856; final review finding 3).
pub const REMOVE_INHERITED: &str = "*";

/// How to start a child.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// Exact variable names removed from the inherited environment.
    pub env_remove: Vec<OsString>,
    /// Prefixes: inherited variables whose names start with one of these are removed. The empty
    /// prefix removes the whole inherited environment.
    pub env_remove_prefixes: Vec<String>,
    pub env_set: Vec<(OsString, OsString)>,
    /// Added to the host's own priority (higher = lower priority). 10 by default.
    pub nice: i32,
    /// How long `shutdown` and `terminate_group` wait between steps.
    pub kill_grace: Duration,
}

impl Launch {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env_remove: Vec::new(),
            env_remove_prefixes: Vec::new(),
            env_set: Vec::new(),
            nice: 10,
            kill_grace: Duration::from_secs(2),
        }
    }

    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// Remove these names from the inherited environment: exact names, or prefixes written with a
    /// trailing `*` ([REMOVE_INHERITED] removes everything).
    pub fn remove_env(&mut self, names: impl IntoIterator<Item = String>) {
        for name in names {
            match name.strip_suffix('*') {
                Some(prefix) => self.env_remove_prefixes.push(prefix.to_owned()),
                None => self.env_remove.push(name.into()),
            }
        }
    }

    /// The host's own agent identity must not leak into an agent child.
    pub fn without_host_identity(mut self) -> Self {
        self.env_remove_prefixes
            .extend(["GOAT_".to_string(), "T3CODE_".to_string()]);
        self.env_remove.extend(
            [
                "CODEX_THREAD_ID",
                "CODEX_SESSION_ID",
                "CODEX_TOOL_CALL_ID",
                "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
                // The GOAT 2 host's UI bearer token: agent commands must never see it (lane B,
                // goat2-engine-codex/src/process.rs:65; v1 has no such token).
                "GOAT2_HOST_TOKEN",
            ]
            .map(OsString::from),
        );
        self
    }
}

/// How the child ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitSummary {
    pub status: Option<ExitStatus>,
    /// True when the group had to be signalled.
    pub signalled: bool,
}

impl std::fmt::Display for ExitSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.status {
            Some(status) => write!(f, "{status}"),
            None => f.write_str("exit status unknown"),
        }
    }
}

/// The shortest time a group gets between TERM and KILL on an ordinary stop.
const TERM_MIN: Duration = Duration::from_millis(100);

/// A running child that owns its process group.
pub struct ChildProcess {
    pid: u32,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr_tail: Arc<Mutex<StderrTail>>,
    /// Turns true when the agent's stderr reached end of file.
    stderr_closed: tokio::sync::watch::Receiver<bool>,
    kill_grace: Duration,
    reaped: Option<ExitStatus>,
    group_gone: bool,
}

impl ChildProcess {
    /// Start the child with piped stdio in a new process group, `nice` lower than the host.
    pub fn spawn(launch: &Launch) -> io::Result<Self> {
        Self::spawn_with_stderr(launch, None)
    }

    /// [Self::spawn], calling `on_stderr_line` for every stderr line (Antigravity prints its
    /// sign-in URL there, v1 `antigravityAuthSupport.ts`).
    pub fn spawn_with_stderr(
        launch: &Launch,
        on_stderr_line: Option<StderrHook>,
    ) -> io::Result<Self> {
        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = &launch.cwd {
            command.current_dir(cwd);
        }
        if launch.env_remove_prefixes.iter().any(String::is_empty) {
            // Nothing is inherited: the child gets exactly `env_set`, whatever the host process
            // holds at spawn time.
            command.env_clear();
        } else {
            for (name, _) in std::env::vars_os() {
                let text = name.to_string_lossy();
                if launch
                    .env_remove_prefixes
                    .iter()
                    .any(|prefix| text.starts_with(prefix.as_str()))
                {
                    command.env_remove(&name);
                }
            }
        }
        for name in &launch.env_remove {
            command.env_remove(name);
        }
        for (name, value) in &launch.env_set {
            command.env(name, value);
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("child exited before its pid was read"))?;
        #[cfg(unix)]
        {
            let target = unix::target_priority(launch.nice);
            // SAFETY: plain syscall on our own just-spawned child. Lowering a child's priority is
            // always permitted; a child that already exited (ESRCH) has nothing left to lower.
            unsafe {
                libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, target);
            }
        }
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr_tail = Arc::new(Mutex::new(StderrTail::new(
            crate::stderr::home_directories(),
        )));
        let (closed_tx, stderr_closed) = tokio::sync::watch::channel(child.stderr.is_none());
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                // Bounded chunks: a newline-free stream cannot grow host memory (v1
                // AcpJsonRpcConnection.test.ts:419-441). The tail takes every chunk at once (v1
                // AcpSessionRuntime.ts:835), the hook whole lines.
                crate::stderr::read_bounded(
                    stderr,
                    |chunk| {
                        if let Ok(mut tail) = tail.lock() {
                            tail.push(chunk);
                        }
                    },
                    |line| {
                        if let Some(hook) = &on_stderr_line {
                            let text = String::from_utf8_lossy(line);
                            hook(text.trim_end_matches(['\r', '\n']));
                        }
                    },
                )
                .await;
                let _ = closed_tx.send(true);
            });
        }
        Ok(Self {
            pid,
            child,
            stdin,
            stdout,
            stderr_tail,
            stderr_closed,
            kill_grace: launch.kill_grace,
            reaped: None,
            group_gone: false,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Take the child's stdin (once).
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.stdin.take()
    }

    /// Take the child's stdout (once).
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.stdout.take()
    }

    /// Wait, at most `limit`, until the agent's stderr is closed (it exited), so an error built
    /// next includes its last words.
    pub async fn wait_stderr_closed(&self, limit: Duration) {
        let mut closed = self.stderr_closed.clone();
        let _ = tokio::time::timeout(limit, closed.wait_for(|done| *done)).await;
    }

    /// The last stderr output, sanitized (v1 `sanitizeAcpStderrExcerpt`): it ends up in errors and
    /// exit reasons the host stores, so credentials, sign-in links and home paths are removed.
    pub fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|tail| tail.text())
            .unwrap_or_default()
    }

    /// Ordinary stop: close stdin, then always signal the group (the leader exiting does not
    /// prove its descendants did), TERM then KILL. One `kill_grace` deadline covers the whole
    /// stop, as v1 forces a kill 5 s after asking the process to stop; TERM always gets at least
    /// `TERM_MIN` before KILL.
    pub async fn shutdown(&mut self) -> ExitSummary {
        let deadline = tokio::time::Instant::now() + self.kill_grace;
        self.stdin.take();
        if self.reaped.is_none()
            && let Ok(Ok(status)) = tokio::time::timeout_at(deadline, self.child.wait()).await
        {
            self.reaped = Some(status);
        }
        let term_until = deadline.max(tokio::time::Instant::now() + TERM_MIN);
        self.end_group(term_until).await
    }

    /// Stop-timer path: TERM the group, wait `kill_grace`, KILL; no stdin grace, so it returns
    /// within about one `kill_grace`.
    pub async fn terminate_group(&mut self) -> ExitSummary {
        self.stdin.take();
        let term_until = tokio::time::Instant::now() + self.kill_grace;
        self.end_group(term_until).await
    }

    /// Kill the whole group now (host memory policy, Drop).
    pub fn kill_group(&mut self) {
        self.stdin.take();
        self.signal_group(Signal::Kill);
        let _ = self.child.start_kill();
    }

    /// Same as [Self::kill_group].
    pub fn kill_now(&mut self) {
        self.kill_group();
    }

    /// Sum of the resident memory of every live member of the group, in bytes. 0 when the group
    /// is gone. Uses `/bin/ps -A -o pgid=,rss=` (KiB on macOS and Linux).
    pub fn group_rss_bytes(&self) -> io::Result<u64> {
        #[cfg(unix)]
        {
            unix::group_rss_bytes(self.pid)
        }
        #[cfg(not(unix))]
        {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "group memory is measured on unix only",
            ))
        }
    }

    /// Whether any member of the group is still alive.
    pub fn group_alive(&self) -> bool {
        #[cfg(unix)]
        {
            !self.group_gone && unix::group_alive(self.pid)
        }
        #[cfg(not(unix))]
        {
            self.reaped.is_none()
        }
    }

    async fn end_group(&mut self, deadline: tokio::time::Instant) -> ExitSummary {
        let mut signalled = false;
        if self.group_alive() {
            signalled = true;
            self.signal_group(Signal::Term);
            while self.group_alive() && tokio::time::Instant::now() < deadline {
                if self.reaped.is_none()
                    && let Ok(Some(status)) = self.child.try_wait()
                {
                    self.reaped = Some(status);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            if self.group_alive() {
                self.signal_group(Signal::Kill);
            }
        }
        if self.reaped.is_none() {
            let _ = self.child.start_kill();
            if let Ok(Ok(status)) =
                tokio::time::timeout(Duration::from_secs(1), self.child.wait()).await
            {
                self.reaped = Some(status);
            }
        }
        // KILLed members can linger for a moment before the system reaps them; callers (and the
        // host's leftover-group check) rely on the group being gone once this returns.
        let gone_by = tokio::time::Instant::now() + Duration::from_secs(1);
        while signalled && self.group_alive() && tokio::time::Instant::now() < gone_by {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // With the leader reaped, an empty group stays empty and its pgid is free for the system
        // to hand to a new group (another session's agent): never signal it again, Drop included.
        // While the leader is unreaped (a zombie) its pid cannot be reused, so no mark is needed.
        if self.reaped.is_some() && !self.group_alive() {
            self.group_gone = true;
        }
        ExitSummary {
            status: self.reaped,
            signalled,
        }
    }

    fn signal_group(&mut self, signal: Signal) {
        if self.group_gone {
            return;
        }
        #[cfg(unix)]
        {
            if !unix::signal_group(self.pid, signal) {
                // ESRCH: the group is empty; never signal this pgid again (it could be reused).
                self.group_gone = true;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = signal;
            let _ = self.child.start_kill();
        }
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        self.signal_group(Signal::Kill);
    }
}

/// [ChildProcess::group_rss_bytes] for a process group id held elsewhere.
pub fn group_rss_bytes_of(pgid: u32) -> io::Result<u64> {
    #[cfg(unix)]
    {
        unix::group_rss_bytes(pgid)
    }
    #[cfg(not(unix))]
    {
        let _ = pgid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "group memory is measured on unix only",
        ))
    }
}

#[derive(Debug, Clone, Copy)]
enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
mod unix {
    use super::Signal;
    use std::io;
    use std::process::Command;

    /// The host's priority plus `nice`, capped at 19.
    pub fn target_priority(nice: i32) -> i32 {
        // SAFETY: plain syscall. getpriority can legitimately return -1, so errno is cleared first.
        let current = unsafe {
            *errno_location() = 0;
            libc::getpriority(libc::PRIO_PROCESS, 0)
        };
        (current + nice).clamp(-20, 19)
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    unsafe fn errno_location() -> *mut libc::c_int {
        unsafe { libc::__error() }
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    unsafe fn errno_location() -> *mut libc::c_int {
        unsafe { libc::__errno_location() }
    }

    /// Returns false when the group no longer exists.
    pub fn signal_group(pgid: u32, signal: Signal) -> bool {
        let sig = match signal {
            Signal::Term => libc::SIGTERM,
            Signal::Kill => libc::SIGKILL,
        };
        // SAFETY: plain syscall on our own child's group id.
        let rc = unsafe { libc::kill(-(pgid as libc::pid_t), sig) };
        rc == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    pub fn group_alive(pgid: u32) -> bool {
        // SAFETY: signal 0 only checks existence.
        let rc = unsafe { libc::kill(-(pgid as libc::pid_t), 0) };
        rc == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    pub fn group_rss_bytes(pgid: u32) -> io::Result<u64> {
        let output = Command::new("/bin/ps")
            .args(["-A", "-o", "pgid=,rss="])
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other(format!("ps failed: {}", output.status)));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut total_kib: u64 = 0;
        for line in text.lines() {
            let mut fields = line.split_whitespace();
            let (Some(group), Some(rss)) = (fields.next(), fields.next()) else {
                continue;
            };
            if group.parse::<u32>().ok() == Some(pgid) {
                total_kib += rss.parse::<u64>().unwrap_or(0);
            }
        }
        Ok(total_kib * 1024)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    /// Ported from lane B's goat2-engine-codex/tests/process.rs:152-155 (80fc24dbd9): the host's
    /// UI bearer token is GOAT2_, which the GOAT_ prefix rule does not catch (round 7 part 2.1).
    #[tokio::test]
    async fn the_host_ui_token_is_not_inherited_but_other_host_settings_are() {
        // SAFETY: test-only environment mutation before spawning; no other test reads these.
        unsafe {
            std::env::set_var("GOAT2_HOST_TOKEN", "ui-secret");
            std::env::set_var("GOAT2_ACP_PROCESS_TEST_SETTING", "/tmp/parity");
        }
        let launch = Launch::new("/bin/sh")
            .arg("-c")
            .arg("echo \"[$GOAT2_HOST_TOKEN][$GOAT2_ACP_PROCESS_TEST_SETTING]\"")
            .without_host_identity();
        let mut child = ChildProcess::spawn(&launch).unwrap();
        let stdout = child.take_stdout().unwrap();
        let mut line = String::new();
        tokio::io::BufReader::new(stdout)
            .read_line(&mut line)
            .await
            .unwrap();
        assert_eq!(line.trim_end(), "[][/tmp/parity]");
        child.shutdown().await;
    }

    /// Once the leader is reaped and its group is empty, the pgid can be given to an unrelated
    /// new group (another session's agent). Drop must then send nothing: before this fix a
    /// stopped child's Drop sent kill(-pgid) again, which would kill whatever group the system
    /// had since given that id.
    #[tokio::test]
    async fn a_stopped_group_is_never_signalled_again() {
        let exited = Launch::new("/bin/sh").arg("-c").arg("exit 0");
        let mut child = ChildProcess::spawn(&exited).unwrap();
        child.shutdown().await;
        assert!(
            child.group_gone,
            "an exited, reaped group must be marked gone"
        );

        let running = Launch::new("/bin/sh").arg("-c").arg("exec sleep 30");
        let mut child = ChildProcess::spawn(&running).unwrap();
        let summary = child.terminate_group().await;
        assert!(summary.signalled);
        assert!(
            child.group_gone,
            "a killed, reaped group must be marked gone"
        );
    }

    /// The agent still runs `nice` lower than the host after the priority moved out of
    /// `pre_exec` (which forced fork+exec; see the module docs).
    #[cfg(unix)]
    #[tokio::test]
    async fn the_agent_runs_at_the_lowered_priority() {
        let launch = Launch::new("/bin/sh").arg("-c").arg("exec sleep 30");
        let mut child = ChildProcess::spawn(&launch).unwrap();
        let expected = unix::target_priority(launch.nice);
        // SAFETY: plain syscall reading our own child's priority.
        let got = unsafe { libc::getpriority(libc::PRIO_PROCESS, child.pid() as libc::id_t) };
        child.terminate_group().await;
        assert_eq!(got, expected);
        assert!(expected > 0 || launch.nice == 0);
    }
}
