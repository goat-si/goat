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

/// Review P2: two sign-in starts at once for one instance leave exactly one running flow; the
/// replaced one is cancelled (its stream ends), so no login runs that nobody can answer.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_starts_leave_one_answerable_flow() {
    let factory = std::sync::Arc::new(factory());
    for round in 0..10 {
        let (target, home) = target(&format!("race{round}"));
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        // Two OS threads released together, so the starts really overlap.
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handle = tokio::runtime::Handle::current();
        let start = |tx| {
            let (factory, target, barrier, handle) = (
                factory.clone(),
                target.clone(),
                barrier.clone(),
                handle.clone(),
            );
            std::thread::spawn(move || {
                barrier.wait();
                handle.block_on(factory.auth_start(&target, None, tx))
            })
        };
        let (a, b) = (start(tx_a), start(tx_b));
        let (a, b) = tokio::task::spawn_blocking(move || (a.join().unwrap(), b.join().unwrap()))
            .await
            .unwrap();
        let (a, b) = (a.unwrap().flow_id.unwrap(), b.unwrap().flow_id.unwrap());
        let cancel_a = factory.auth_cancel(&target, &a).await;
        let cancel_b = factory.auth_cancel(&target, &b).await;
        assert!(
            cancel_a.is_ok() != cancel_b.is_ok(),
            "exactly one flow is live and cancellable (round {round})"
        );
        // Both streams end with Cancelled: the replaced one at the swap, the other at cancel.
        for rx in [&mut rx_a, &mut rx_b] {
            let mut last = None;
            while let Ok(Some(state)) =
                tokio::time::timeout(Duration::from_secs(10), rx.recv()).await
            {
                last = Some(state.phase);
            }
            assert_eq!(last, Some(ProviderAuthPhase::Cancelled), "round {round}");
        }
        let _ = std::fs::remove_dir_all(home);
    }
}

/// Review P2: an open sign-in neither keeps a runtime from shutting down nor survives its
/// factory; dropping the factory cancels the flow and ends its stream.
#[test]
fn an_open_sign_in_does_not_hold_up_shutdown() {
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let factory = factory();
        let (target, home) = target("shutdown");
        let (tx, mut updates) = mpsc::unbounded_channel();
        runtime.block_on(async {
            factory.auth_start(&target, None, tx).await.unwrap();
            let mut seen = Vec::new();
            until(&mut updates, &mut seen, |s| {
                output(s).is_some_and(|o| o.contains("Paste code"))
            })
            .await;
        });
        drop(runtime);
        drop(factory);
        let mut last = None;
        while let Ok(state) = updates.try_recv() {
            last = Some(state.phase);
        }
        let _ = std::fs::remove_dir_all(home);
        let _ = done_tx.send(last);
    });
    let last = done_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the runtime and factory went away within 10 s");
    assert_eq!(last, Some(ProviderAuthPhase::Cancelled));
}
