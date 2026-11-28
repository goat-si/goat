//! Claude sign-in through a terminal (v1 ClaudeAuth.ts) against the fake CLI: the instance's
//! home is signed in, typed input never shows in a state, a wrong code fails, cancel stops it,
//! logout signs out.

use std::path::PathBuf;
use std::time::Duration;

use goat2_contracts::{
    ProviderAuthInteraction, ProviderAuthPhase, ProviderAuthResponse, ProviderAuthState,
    ProviderAuthTerminalSize, ServerProviderAuthStatus,
};
use goat2_engine_api::{EngineFactory, ProviderTarget};
use goat2_engine_claude::{ClaudeEngineFactory, ClaudeEngineOptions};
use tokio::sync::mpsc;

fn factory() -> ClaudeEngineFactory {
    let mut options = ClaudeEngineOptions::default();
    options.launch.binary = PathBuf::from(env!("CARGO_BIN_EXE_goat2-fake-claude"));
    ClaudeEngineFactory::new(options)
}

fn target(name: &str) -> (ProviderTarget, PathBuf) {
    let home = std::env::temp_dir().join(format!(
        "goat2-claude-auth-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&home).unwrap();
    (
        ProviderTarget {
            instance_id: "claudeAgent-work".into(),
            launch: None,
            home: Some(home.clone()),
            shared_home: None,
        },
        home,
    )
}

fn output(state: &ProviderAuthState) -> Option<&str> {
    match &state.interaction {
        Some(Some(ProviderAuthInteraction::Terminal { output, .. })) => Some(output),
        _ => None,
    }
}

async fn until(
    updates: &mut mpsc::UnboundedReceiver<ProviderAuthState>,
    seen: &mut Vec<ProviderAuthState>,
    done: impl Fn(&ProviderAuthState) -> bool,
) {
    loop {
        let state = tokio::time::timeout(Duration::from_secs(10), updates.recv())
            .await
            .expect("a sign-in update within 10 s")
            .expect("updates still open");
        let stop = done(&state);
        seen.push(state);
        if stop {
            return;
        }
    }
}

fn terminal(data: &str, size: Option<(u16, u16)>) -> ProviderAuthResponse {
    ProviderAuthResponse::Terminal {
        data: data.to_string(),
        size: size.map(|(cols, rows)| ProviderAuthTerminalSize { cols, rows }),
    }
}

async fn status(
    factory: &ClaudeEngineFactory,
    target: &ProviderTarget,
) -> ServerProviderAuthStatus {
    factory.probe_instance(target).await.unwrap().auth.status
}

#[tokio::test]
async fn sign_in_through_the_terminal_then_sign_out() {
    let factory = factory();
    let (target, home) = target("ok");
    assert!(factory.setup().can_authenticate);
    let methods = factory.auth_methods(&target).await.unwrap();
    assert_eq!(methods[0].id, "claude-login");
    assert_eq!(
        status(&factory, &target).await,
        ServerProviderAuthStatus::Unauthenticated
    );

    let (tx, mut updates) = mpsc::unbounded_channel();
    let start = factory.auth_start(&target, None, tx).await.unwrap();
    assert_eq!(start.phase, ProviderAuthPhase::Waiting);
    assert_eq!(start.instance_id.as_str(), "claudeAgent-work");
    let flow = start.flow_id.clone().unwrap();
    assert_eq!(output(&start), Some(""));

    let mut seen = Vec::new();
    until(&mut updates, &mut seen, |s| {
        output(s).is_some_and(|o| o.contains("Paste code"))
    })
    .await;
    assert!(
        output(seen.last().unwrap())
            .unwrap()
            .contains("https://claude.example.test/oauth")
    );
    factory
        .auth_respond(&target, &flow, "terminal", terminal("", Some((120, 40))))
        .await
        .unwrap();
    factory
        .auth_respond(&target, &flow, "terminal", terminal("good-code\r", None))
        .await
        .unwrap();
    until(&mut updates, &mut seen, |s| {
        s.phase == ProviderAuthPhase::Succeeded
    })
    .await;
    assert!(
        updates.recv().await.is_none(),
        "the sender is dropped after a terminal phase"
    );

    let phases: Vec<&ProviderAuthPhase> = seen.iter().map(|s| &s.phase).collect();
    let verifying = phases
        .iter()
        .position(|p| **p == ProviderAuthPhase::Verifying)
        .unwrap();
    assert!(
        phases[..verifying]
            .iter()
            .all(|p| **p == ProviderAuthPhase::Waiting)
    );
    assert_eq!(
        seen.last().unwrap().message.as_deref(),
        Some("Sign-in complete.")
    );
    assert!(
        seen.iter()
            .any(|s| output(s).is_some_and(|o| o.contains("cols=120"))),
        "the terminal was resized"
    );
    for state in &seen {
        assert!(
            !format!("{state:?}").contains("good-code"),
            "typed input in a state: {state:?}"
        );
    }
    assert_eq!(
        status(&factory, &target).await,
        ServerProviderAuthStatus::Authenticated
    );

    let out = factory.auth_logout(&target).await.unwrap();
    assert_eq!(out.phase, ProviderAuthPhase::Idle);
    assert_eq!(out.message.as_deref(), Some("Signed out."));
    assert_eq!(
        status(&factory, &target).await,
        ServerProviderAuthStatus::Unauthenticated
    );
    let _ = std::fs::remove_dir_all(home);
}

#[tokio::test]
async fn a_wrong_code_fails_with_v1_text() {
    let factory = factory();
    let (target, home) = target("bad");
    let (tx, mut updates) = mpsc::unbounded_channel();
    let flow = factory
        .auth_start(&target, None, tx)
        .await
        .unwrap()
        .flow_id
        .unwrap();
    let mut seen = Vec::new();
    until(&mut updates, &mut seen, |s| {
        output(s).is_some_and(|o| o.contains("Paste code"))
    })
    .await;
    factory
        .auth_respond(&target, &flow, "terminal", terminal("nope\r", None))
        .await
        .unwrap();
    until(&mut updates, &mut seen, |s| {
        s.phase == ProviderAuthPhase::Failed
    })
    .await;
    assert_eq!(
        seen.last().unwrap().message.as_deref(),
        Some("The provider login command did not finish successfully.")
    );
    assert_eq!(
        status(&factory, &target).await,
        ServerProviderAuthStatus::Unauthenticated
    );
    let _ = std::fs::remove_dir_all(home);
}

#[tokio::test]
async fn cancel_stops_the_sign_in() {
    let factory = factory();
    let (target, home) = target("cancel");
    let (tx, mut updates) = mpsc::unbounded_channel();
    let flow = factory
        .auth_start(&target, None, tx)
        .await
        .unwrap()
        .flow_id
        .unwrap();
    let mut seen = Vec::new();
    until(&mut updates, &mut seen, |s| {
        output(s).is_some_and(|o| o.contains("Paste code"))
    })
    .await;
    let cancelled = factory.auth_cancel(&target, &flow).await.unwrap();
    assert_eq!(cancelled.phase, ProviderAuthPhase::Cancelled);
    assert_eq!(cancelled.message.as_deref(), Some("Sign-in cancelled."));
    until(&mut updates, &mut seen, |s| {
        s.phase == ProviderAuthPhase::Cancelled
    })
    .await;
    assert!(updates.recv().await.is_none());
    assert!(
        factory
            .auth_respond(&target, &flow, "terminal", terminal("good-code\r", None))
            .await
            .is_err(),
        "a cancelled sign-in takes no input"
    );
    assert!(
        factory
            .auth_start(&target, Some("other".into()), mpsc::unbounded_channel().0)
            .await
            .is_err()
    );
    let _ = std::fs::remove_dir_all(home);
}
