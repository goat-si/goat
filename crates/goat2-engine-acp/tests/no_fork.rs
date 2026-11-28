//! Every spawn path in the crate keeps std on posix_spawn, never fork (crate::process module
//! docs: on macOS a fork during a libSystem once-initializer SIGKILLs the child before exec).
//! std forks for a bare program name when the child's PATH differs from the host's, so each
//! path is driven with exactly that case. A `pthread_atfork` prepare hook runs in the parent on
//! every fork and never on posix_spawn. Its own test binary with one test, so no other test's
//! spawn can move the count.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use goat2_engine_acp::process::{ChildProcess, Launch};

static FORKS: AtomicUsize = AtomicUsize::new(0);

extern "C" fn count_fork() {
    FORKS.fetch_add(1, Ordering::SeqCst);
}

/// A PATH that is surely not the host's, holding sh.
const CHILD_PATH: &str = "/bin:/usr/bin:/goat2-no-fork-test";

#[tokio::test]
async fn bare_names_with_a_changed_path_never_fork() {
    // SAFETY: registers a plain counter; prepare handlers run in the forking thread.
    assert_eq!(
        unsafe { libc::pthread_atfork(Some(count_fork), None, None) },
        0
    );
    let env = BTreeMap::from([("PATH".to_owned(), CHILD_PATH.to_owned())]);

    // Agent sessions: inherited environment removed, PATH set.
    let mut launch = Launch::new("sh").arg("-c").arg("exit 0");
    launch.remove_env(["*".to_owned()]);
    launch.env_set.push(("PATH".into(), CHILD_PATH.into()));
    let mut child = ChildProcess::spawn(&launch).expect("spawn sh");
    child.shutdown().await;
    // PATH set over the inherited environment.
    let mut launch = Launch::new("sh").arg("-c").arg("exit 0");
    launch.env_set.push(("PATH".into(), CHILD_PATH.into()));
    let mut child = ChildProcess::spawn(&launch).expect("spawn sh");
    child.shutdown().await;
    assert_eq!(
        FORKS.load(Ordering::SeqCst),
        0,
        "ChildProcess::spawn forked"
    );

    // Probe commands (fx/grok --version, models, status): cleared environment.
    let result = goat2_engine_acp::probe::support::spawn_and_collect(
        Path::new("sh"),
        &["-c".to_owned(), "echo ok".to_owned()],
        &env,
        None,
        std::time::Duration::from_secs(30),
    )
    .await
    .expect("probe command")
    .expect("no timeout");
    assert_eq!(result.stdout.trim(), "ok");
    assert_eq!(FORKS.load(Ordering::SeqCst), 0, "spawn_and_collect forked");

    // The Grok probe's initialize-only ACP call: sh exits at once, so the call fails; only the
    // spawn matters here.
    let _ = goat2_engine_acp::probe::grok::acp_initialize_only(
        Path::new("sh"),
        &["-c".to_owned(), "exit 0".to_owned()],
        &env,
        None,
        serde_json::json!({}),
    )
    .await;
    assert_eq!(
        FORKS.load(Ordering::SeqCst),
        0,
        "acp_initialize_only forked"
    );

    // Grok skill discovery with the session's PATH.
    let context = goat2_engine_acp::flavor::PromptContext {
        cwd: String::new(),
        program: "sh".into(),
        launch_env: vec![("PATH".to_owned(), CHILD_PATH.to_owned())],
    };
    let _ = goat2_engine_acp::agents::grok_skills::discover_skills(Path::new("sh"), &context).await;
    assert_eq!(FORKS.load(Ordering::SeqCst), 0, "discover_skills forked");

    // A bare name found nowhere fails like std's spawn, without spawning.
    let mut missing = Launch::new("goat2-no-such-agent-binary");
    missing.env_set.push(("PATH".into(), CHILD_PATH.into()));
    let error = ChildProcess::spawn(&missing)
        .err()
        .expect("missing program");
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(FORKS.load(Ordering::SeqCst), 0);
}
