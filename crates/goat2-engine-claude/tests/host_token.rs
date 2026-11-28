//! The host's UI bearer token (`GOAT2_HOST_TOKEN`) and GOAT's own identity never reach the Claude
//! CLI, from a session or a probe. Its own test binary: it sets the variables in this process's
//! environment, which the CLI would otherwise inherit.

mod support;

use std::path::PathBuf;

use goat2_contracts::{RuntimeMode, ServerProviderAuthStatus};
use goat2_engine_api::EngineFactory;
use goat2_engine_claude::{ClaudeEngineFactory, ClaudeEngineOptions};
use support::*;

#[tokio::test]
async fn the_host_token_never_reaches_claude() {
    // SAFETY: the only test in this binary, before any thread reads the environment.
    unsafe {
        std::env::set_var("GOAT2_HOST_TOKEN", "ui-secret");
        std::env::set_var("GOAT_THREAD_ID", "t1");
    }

    // A session: the fake logs the variables it was started with.
    let run = Run::new("wire/ask_user_question.ndjson");
    let handle = run
        .start("claude-sonnet-5-5", RuntimeMode::ApprovalRequired, None)
        .await;
    handle.session.shutdown().await;
    let start = &run.starts()[0];
    assert!(start["env"]["GOAT2_HOST_TOKEN"].is_null(), "{start}");
    assert!(start["env"]["GOAT_THREAD_ID"].is_null(), "{start}");

    // A probe: a stand-in CLI reports signed in only when neither variable reached it.
    let dir = run.dir.join("probe-bin");
    std::fs::create_dir_all(&dir).unwrap();
    let cli = dir.join("claude");
    std::fs::write(
        &cli,
        "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.332 (Claude Code)'; exit 0; fi\n\
         if [ -z \"$GOAT2_HOST_TOKEN$GOAT_THREAD_ID\" ]; then echo '{\"loggedIn\": true}'; \
         else echo '{\"loggedIn\": false}'; fi\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut options = ClaudeEngineOptions::default();
    options.launch.binary = PathBuf::from(&cli);
    let probe = ClaudeEngineFactory::new(options).probe().await.unwrap();
    assert_eq!(probe.auth.status, ServerProviderAuthStatus::Authenticated);
}
