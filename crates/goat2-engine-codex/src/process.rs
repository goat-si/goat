//! Spawning `codex app-server` (or any child) in its own process group at lower CPU priority, and
//! ending the whole group.
//!
//! Unix: `process_group(0)` makes the child a group leader; `setpriority` in `pre_exec` lowers it
//! (and every descendant it spawns, such as agent tool commands) by `Launch::nice`; `kill(-pgid)`
//! ends the group. Windows: the direct child only (Job Objects are Part 2).

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

/// How to start a child.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    /// Exact variable names removed from the inherited environment.
    pub env_remove: Vec<OsString>,
    /// Prefixes: inherited variables whose names start with one of these are removed.
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

    /// The host's own agent identity must not leak into a Codex child.
    pub fn without_host_identity(mut self) -> Self {
        self.env_remove_prefixes
            .extend(["GOAT_".to_string(), "T3CODE_".to_string()]);
        self.env_remove.extend(
            [
                "CODEX_THREAD_ID",
                "CODEX_SESSION_ID",
                "CODEX_TOOL_CALL_ID",
                "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
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

const STDERR_TAIL_BYTES: usize = 64 * 1024;
/// The shortest time a group gets between TERM and KILL on an ordinary stop.
const TERM_MIN: Duration = Duration::from_millis(100);

/// The last 64 KB of the child's stderr, for diagnostics.
#[derive(Debug, Default)]
pub struct StderrTail {
    bytes: Vec<u8>,
}

impl StderrTail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > STDERR_TAIL_BYTES {
            let cut = self.bytes.len() - STDERR_TAIL_BYTES;
            self.bytes.drain(..cut);
        }
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

/// A running child that owns its process group.
pub struct ChildProcess {
    pid: u32,
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr_tail: Arc<Mutex<StderrTail>>,
    /// The stderr reader; awaited (bounded) on stop so the last lines reach the exit reason.
    stderr_reader: Option<tokio::task::JoinHandle<()>>,
    kill_grace: Duration,
    reaped: Option<ExitStatus>,
    group_gone: bool,
}

impl ChildProcess {
    /// Start the child with piped stdio in a new process group, `nice` lower than the host.
    pub fn spawn(launch: &Launch) -> io::Result<Self> {
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
        for name in &launch.env_remove {
            command.env_remove(name);
        }
        for (name, value) in &launch.env_set {
            command.env(name, value);
        }
        #[cfg(unix)]
        {
            command.process_group(0);
            let target = unix::target_priority(launch.nice);
            // SAFETY: setpriority is async-signal-safe; the closure allocates nothing.
            unsafe {
                command.pre_exec(move || {
                    if libc::setpriority(libc::PRIO_PROCESS, 0, target) != 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("child exited before its pid was read"))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr_tail = Arc::new(Mutex::new(StderrTail::default()));
        let stderr_reader = child.stderr.take().map(|mut stderr| {
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                loop {
                    match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut tail) = tail.lock() {
                                tail.push(&buffer[..n]);
                            }
                        }
                    }
                }
            })
        });
        Ok(Self {
            pid,
            child,
            stdin,
            stdout,
            stderr_tail,
            stderr_reader,
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
        // With the group gone its stderr pipe closes; let the reader take the last bytes so the
        // exit reason carries them (bounded: a stray holder of the pipe must not stall a stop).
        if let Some(reader) = self.stderr_reader.take() {
            let _ = tokio::time::timeout(Duration::from_millis(500), reader).await;
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
