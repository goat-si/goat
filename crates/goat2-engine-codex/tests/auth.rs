//! Codex sign-in through Codex's own login (src/auth.rs), against goat2-fake-codex: v1's
//! provider-auth phases and messages, each flow in the instance's own home.

mod support;

use std::time::Duration;

use goat2_contracts::{
    CredentialOwner, ProviderAuthInteraction, ProviderAuthPhase, ProviderAuthState,
    ProviderInstanceId,
};
use goat2_engine_api::{EngineFactory, ProviderTarget};
use goat2_engine_codex::transcript::{Entry, Transcript};
use goat2_engine_codex::{CodexEngineFactory, CodexEngineOptions};
use serde_json::{Value, json};
use support::fake::{load, write_temp};
use tokio::sync::mpsc;

fn emit(frame: Value) -> Entry {
    Entry::EmitInbound {
        label: None,
        frame,
        after_ms: None,
    }
}

fn expect(frame: Value) -> Entry {
    Entry::ExpectOutbound {
        label: None,
        frame,
        wildcards: Vec::new(),
    }
}

/// initialize + initialized as recorded from codex 0.167.0, then `rest`.
fn session(rest: Vec<Entry>) -> Vec<Entry> {
    let t = load("codex-0.167.0/basic.json");
    let mut entries: Vec<Entry> = t.entries[..3].to_vec();
    entries.extend(rest);
    entries
}

fn options(entries: Vec<Entry>) -> CodexEngineOptions {
    let mut t = Transcript::new("auth");
    t.entries = entries;
    let path = write_temp(&t);
    CodexEngineOptions {
        program: env!("CARGO_BIN_EXE_goat2-fake-codex").into(),
        env_set: vec![("GOAT2_FAKE_CODEX_TRANSCRIPT".into(), path.into_os_string())],
        kill_grace: Duration::from_millis(500),
        client_version: "0.0.0".into(),
        ..CodexEngineOptions::default()
    }
}

fn default_target() -> ProviderTarget {
    ProviderTarget {
        instance_id: ProviderInstanceId::new("codex"),
        launch: None,
        home: None,
        shared_home: None,
    }
}

async fn next(
    updates: &mut mpsc::UnboundedReceiver<ProviderAuthState>,
) -> Option<ProviderAuthState> {
    tokio::time::timeout(Duration::from_secs(10), updates.recv())
        .await
        .expect("an auth update in time")
}

fn login_started(id: u64, kind: &str, answer: Value) -> Vec<Entry> {
    vec![
        expect(json!({"id": id, "method": "account/login/start", "params": {"type": kind}})),
        emit(json!({"id": id, "result": answer})),
    ]
}

#[tokio::test]
async fn a_chatgpt_sign_in_runs_through_codex_login_with_v1_phases() {
    let url = "https://auth.openai.com/oauth/authorize?client_id=codex&state=s1";
    let mut entries = session(login_started(
        2,
        "chatgpt",
        json!({"type": "chatgpt", "loginId": "login-1", "authUrl": url}),
    ));
    entries.push(emit(json!({"method": "account/login/completed",
        "params": {"loginId": "login-1", "success": true, "error": null}})));
    entries.push(expect(
        json!({"id": 3, "method": "account/read", "params": {}}),
    ));
    entries.push(emit(
        json!({"id": 3, "result": {"account": {"type": "chatgpt",
        "email": "person@example.com", "planType": "pro"}, "requiresOpenaiAuth": true}}),
    ));
    let f = CodexEngineFactory::new(options(entries));
    assert!(f.setup().can_authenticate);
    let (tx, mut updates) = mpsc::unbounded_channel();
    let started = f
        .auth_start(&default_target(), Some("chatgpt".into()), tx)
        .await
        .unwrap();
    assert_eq!(started.phase, ProviderAuthPhase::Starting);
    assert_eq!(started.message.as_deref(), Some("Starting sign-in."));
    assert_eq!(started.credential_owner, Some(CredentialOwner::Provider));
    let flow = started.flow_id.clone().unwrap();
    assert!(started.expires_at.is_some());

    let waiting = next(&mut updates).await.unwrap();
    assert_eq!(waiting.phase, ProviderAuthPhase::Waiting);
    assert_eq!(waiting.flow_id.as_deref(), Some(flow.as_str()));
    assert_eq!(waiting.authorization_url.as_deref(), Some(url));
    assert_eq!(
        waiting.message.as_deref(),
        Some("Complete sign-in to continue.")
    );
    assert!(matches!(
        waiting.interaction,
        Some(Some(ProviderAuthInteraction::Browser { ref id, url: ref u, requires_consent: false, accepts_callback: None }))
            if *id == flow && u == url
    ));
    let verifying = next(&mut updates).await.unwrap();
    assert_eq!(verifying.phase, ProviderAuthPhase::Verifying);
    assert_eq!(verifying.authorization_url, None);
    let done = next(&mut updates).await.unwrap();
    assert_eq!(done.phase, ProviderAuthPhase::Succeeded);
    assert_eq!(done.message.as_deref(), Some("Sign-in complete."));
    assert_eq!(done.authorization_url, None);
    // The sender is dropped after the end.
    assert!(next(&mut updates).await.is_none());
}

#[tokio::test]
async fn a_device_code_sign_in_shows_the_code_and_reports_a_failed_login() {
    let mut entries = session(login_started(
        2,
        "chatgptDeviceCode",
        json!({"type": "chatgptDeviceCode", "loginId": "login-2",
            "verificationUrl": "https://auth.openai.com/codex/device", "userCode": "ABCD-1234"}),
    ));
    entries.push(emit(json!({"method": "account/login/completed",
        "params": {"loginId": "login-2", "success": false, "error": "denied"}})));
    let f = CodexEngineFactory::new(options(entries));
    let (tx, mut updates) = mpsc::unbounded_channel();
    f.auth_start(&default_target(), Some("chatgpt-device-code".into()), tx)
        .await
        .unwrap();
    let waiting = next(&mut updates).await.unwrap();
    assert!(matches!(
        waiting.interaction,
        Some(Some(ProviderAuthInteraction::DeviceCode { ref url, ref user_code, .. }))
            if url == "https://auth.openai.com/codex/device" && user_code == "ABCD-1234"
    ));
    let done = next(&mut updates).await.unwrap();
    assert_eq!(done.phase, ProviderAuthPhase::Failed);
    assert_eq!(
        done.message.as_deref(),
        Some("ChatGPT sign-in could not be completed. Start again.")
    );
    assert!(next(&mut updates).await.is_none());
}

#[tokio::test]
async fn cancel_ends_the_flow_and_cancels_codex_login() {
    let mut entries = session(login_started(
        2,
        "chatgpt",
        json!({"type": "chatgpt", "loginId": "login-3", "authUrl": "https://auth.openai.com/x"}),
    ));
    entries.push(expect(
        json!({"id": 3, "method": "account/login/cancel", "params": {"loginId": "login-3"}}),
    ));
    entries.push(emit(json!({"id": 3, "result": {"status": "canceled"}})));
    let f = CodexEngineFactory::new(options(entries));
    let target = default_target();
    let (tx, mut updates) = mpsc::unbounded_channel();
    let started = f.auth_start(&target, None, tx).await.unwrap();
    let flow = started.flow_id.unwrap();
    assert_eq!(
        next(&mut updates).await.unwrap().phase,
        ProviderAuthPhase::Waiting
    );
    // A stale flow id is refused and changes nothing.
    assert!(f.auth_cancel(&target, "not-this-flow").await.is_err());
    // One flow per instance.
    let (tx2, _u2) = mpsc::unbounded_channel();
    assert!(f.auth_start(&target, None, tx2).await.is_err());
    let cancelled = f.auth_cancel(&target, &flow).await.unwrap();
    assert_eq!(cancelled.phase, ProviderAuthPhase::Cancelled);
    assert_eq!(cancelled.message.as_deref(), Some("Sign-in cancelled."));
    // No further phase after the answer; the sender goes once Codex's login is cancelled.
    assert!(next(&mut updates).await.is_none());
}

#[tokio::test]
async fn an_unknown_method_or_an_unusable_login_answer_fails() {
    let f = CodexEngineFactory::new(options(session(Vec::new())));
    let (tx, _updates) = mpsc::unbounded_channel();
    let state = f
        .auth_start(&default_target(), Some("apiKey".into()), tx)
        .await
        .unwrap();
    assert_eq!(state.phase, ProviderAuthPhase::Failed);
    assert_eq!(
        state.message.as_deref(),
        Some("The provider did not advertise this sign-in method.")
    );
    // A login URL that is not http(s) is never shown.
    let entries = session(login_started(
        2,
        "chatgpt",
        json!({"type": "chatgpt", "loginId": "login-4", "authUrl": "javascript:alert(1)"}),
    ));
    let f = CodexEngineFactory::new(options(entries));
    let (tx, mut updates) = mpsc::unbounded_channel();
    f.auth_start(&default_target(), None, tx).await.unwrap();
    let done = next(&mut updates).await.unwrap();
    assert_eq!(done.phase, ProviderAuthPhase::Failed);
    assert_eq!(done.authorization_url, None);
    assert_eq!(
        done.message.as_deref(),
        Some("Sign-in failed. Start again.")
    );
}

#[tokio::test]
async fn logout_signs_the_instance_out_and_methods_name_the_account() {
    let mut entries = session(vec![
        expect(json!({"id": 2, "method": "account/logout", "params": {}})),
        emit(json!({"id": 2, "result": {}})),
    ]);
    let f = CodexEngineFactory::new(options(std::mem::take(&mut entries)));
    let state = f.auth_logout(&default_target()).await.unwrap();
    assert_eq!(state.phase, ProviderAuthPhase::Idle);
    assert_eq!(state.message.as_deref(), Some("Signed out."));

    let entries = session(vec![
        expect(json!({"id": 2, "method": "account/read", "params": {}})),
        emit(json!({"id": 2, "result": {"account": {"type": "chatgpt",
            "email": "person@example.com", "planType": "pro"}, "requiresOpenaiAuth": true}})),
    ]);
    let f = CodexEngineFactory::new(options(entries));
    let methods = f.auth_methods(&default_target()).await.unwrap();
    assert_eq!(methods.len(), 2);
    assert_eq!(methods[0].id, "chatgpt");
    assert_eq!(methods[0].name, "Sign in with ChatGPT");
    assert_eq!(
        methods[0].account_email.as_deref(),
        Some("person@example.com")
    );
    assert_eq!(
        methods[0].description.as_deref(),
        Some("Reconnect person@example.com.")
    );
    assert_eq!(methods[1].id, "chatgpt-device-code");
}

/// A second instance signs in inside its own home: Codex runs with CODEX_HOME set to it.
#[cfg(unix)]
#[tokio::test]
async fn an_instance_signs_in_inside_its_own_home() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("goat2-auth-home-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("shared")).unwrap();
    std::fs::create_dir_all(root.join("instance")).unwrap();
    let root = root.canonicalize().unwrap();
    let record = root.join("record");
    let wrapper = root.join("codex");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$CODEX_HOME\" > '{}'\nexec '{}' \"$@\"\n",
            record.display(),
            env!("CARGO_BIN_EXE_goat2-fake-codex")
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut o = options(session(vec![
        expect(json!({"id": 2, "method": "account/logout", "params": {}})),
        emit(json!({"id": 2, "result": {}})),
    ]));
    o.program = wrapper;
    let target = ProviderTarget {
        instance_id: ProviderInstanceId::new("codex_2"),
        launch: None,
        home: Some(root.join("instance")),
        shared_home: Some(root.join("shared")),
    };
    let state = CodexEngineFactory::new(o)
        .auth_logout(&target)
        .await
        .unwrap();
    assert_eq!(state.phase, ProviderAuthPhase::Idle);
    assert_eq!(state.instance_id, ProviderInstanceId::new("codex_2"));
    assert_eq!(
        std::fs::read_to_string(&record).unwrap().trim_end(),
        root.join("instance").display().to_string()
    );
    std::fs::remove_dir_all(&root).unwrap();
}
