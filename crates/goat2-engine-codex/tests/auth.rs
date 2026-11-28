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
async fn cancel_ends_the_flow_and_its_codex_login() {
    let entries = session(login_started(
        2,
        "chatgpt",
        json!({"type": "chatgpt", "loginId": "login-3", "authUrl": "https://auth.openai.com/x"}),
    ));
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
    // The stream ends with the same terminal phase, then closes (engine API stream rule).
    assert_eq!(
        next(&mut updates).await.unwrap().phase,
        ProviderAuthPhase::Cancelled
    );
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
    // Nor an https URL that is not a URL (the host would drop it and keep "waiting").
    for bad in ["https://", "https:// auth.openai.com/x", "https://[::::]/"] {
        let entries = session(login_started(
            2,
            "chatgpt",
            json!({"type": "chatgpt", "loginId": "login-5", "authUrl": bad}),
        ));
        let f = CodexEngineFactory::new(options(entries));
        let (tx, mut updates) = mpsc::unbounded_channel();
        f.auth_start(&default_target(), None, tx).await.unwrap();
        let done = next(&mut updates).await.unwrap();
        assert_eq!(done.phase, ProviderAuthPhase::Failed, "{bad}");
        assert_eq!(done.authorization_url, None, "{bad}");
    }
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

// ---- review r1: races (cancel, logout, factory drop, expiry) ----

/// A wrapper that gives each Codex process its own transcript (t0.json, t1.json, ...) and
/// records its pid, so a test can see which process ran and whether it has ended.
#[cfg(unix)]
struct Multi {
    dir: std::path::PathBuf,
}

#[cfg(unix)]
impl Multi {
    fn new(name: &str, transcripts: Vec<Vec<Entry>>) -> (Self, CodexEngineOptions) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("goat2-auth-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (n, entries) in transcripts.into_iter().enumerate() {
            let mut t = Transcript::new("auth");
            t.entries = entries;
            std::fs::write(
                dir.join(format!("t{n}.json")),
                serde_json::to_string(&t).unwrap(),
            )
            .unwrap();
        }
        let wrapper = dir.join("codex");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nd='{}'\nn=$(cat \"$d/count\" 2>/dev/null || echo 0)\necho $((n+1)) > \"$d/count\"\necho $$ > \"$d/pid$n\"\nGOAT2_FAKE_CODEX_TRANSCRIPT=\"$d/t$n.json\" GOAT2_FAKE_CODEX_REALTIME=1 exec '{}' \"$@\"\n",
                dir.display(),
                env!("CARGO_BIN_EXE_goat2-fake-codex")
            ),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let options = CodexEngineOptions {
            program: wrapper,
            kill_grace: Duration::from_millis(500),
            client_version: "0.0.0".into(),
            ..CodexEngineOptions::default()
        };
        (Self { dir }, options)
    }

    /// Waits (up to 5 s) until the n-th Codex process has started.
    async fn started(&self, n: usize) {
        for _ in 0..250 {
            if let Ok(pid) = std::fs::read_to_string(self.dir.join(format!("pid{n}")))
                && !pid.trim().is_empty()
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("Codex process {n} never started");
    }

    /// Whether the n-th Codex process still exists (a process that never wrote its pid, because
    /// its group was ended first, does not).
    fn alive(&self, n: usize) -> bool {
        let Ok(pid) = std::fs::read_to_string(self.dir.join(format!("pid{n}"))) else {
            return false;
        };
        let Ok(pid) = pid.trim().parse::<i32>() else {
            return false;
        };
        // SAFETY: signal 0 only checks the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn ended(&self, n: usize) -> bool {
        for _ in 0..60 {
            if !self.alive(n) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }
}

#[cfg(unix)]
impl Drop for Multi {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A login that would complete 400 ms after it starts (then be confirmed), if nothing stopped it.
#[cfg(unix)]
fn completing_login(login: &str) -> Vec<Entry> {
    let mut entries = session(login_started(
        2,
        "chatgpt",
        json!({"type": "chatgpt", "loginId": login, "authUrl": "https://auth.openai.com/x"}),
    ));
    entries.push(Entry::EmitInbound {
        label: None,
        frame: json!({"method": "account/login/completed",
            "params": {"loginId": login, "success": true, "error": null}}),
        after_ms: Some(400),
    });
    entries.push(expect(
        json!({"id": 3, "method": "account/read", "params": {}}),
    ));
    entries.push(emit(
        json!({"id": 3, "result": {"account": {"type": "apiKey"}, "requiresOpenaiAuth": true}}),
    ));
    entries
}

/// Review r1 P1: after cancel answers, the flow sends nothing (not even a late Waiting or
/// Verifying), its stream is closed and its Codex has ended.
#[cfg(unix)]
#[tokio::test]
async fn after_cancel_nothing_more_is_sent_and_codex_has_ended() {
    let (multi, options) = Multi::new("cancel-race", vec![completing_login("l1")]);
    let f = CodexEngineFactory::new(options);
    let target = default_target();
    let (tx, mut updates) = mpsc::unbounded_channel();
    let flow = f
        .auth_start(&target, None, tx)
        .await
        .unwrap()
        .flow_id
        .unwrap();
    assert_eq!(
        next(&mut updates).await.unwrap().phase,
        ProviderAuthPhase::Waiting
    );
    let cancelled = f.auth_cancel(&target, &flow).await.unwrap();
    assert_eq!(cancelled.phase, ProviderAuthPhase::Cancelled);
    assert!(
        !multi.alive(0),
        "the flow's Codex ended before cancel answered"
    );
    // The login would have completed at 400 ms: only the terminal phase arrives.
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(
        updates.try_recv().unwrap().phase,
        ProviderAuthPhase::Cancelled
    );
    assert!(next(&mut updates).await.is_none());
}

/// Review r1 P1: logout during a flow ends it first (its stream gets exactly one terminal
/// state, Cancelled, and closes; its Codex has ended), then signs out in a new Codex.
#[cfg(unix)]
#[tokio::test]
async fn logout_during_a_flow_ends_it_with_one_terminal_state_first() {
    let logout = session(vec![
        expect(json!({"id": 2, "method": "account/logout", "params": {}})),
        emit(json!({"id": 2, "result": {}})),
    ]);
    let (multi, options) = Multi::new("logout-race", vec![completing_login("l2"), logout]);
    let f = CodexEngineFactory::new(options);
    let target = default_target();
    let (tx, mut updates) = mpsc::unbounded_channel();
    f.auth_start(&target, None, tx).await.unwrap();
    assert_eq!(
        next(&mut updates).await.unwrap().phase,
        ProviderAuthPhase::Waiting
    );
    let out = f.auth_logout(&target).await.unwrap();
    assert_eq!(out.phase, ProviderAuthPhase::Idle);
    assert_eq!(out.message.as_deref(), Some("Signed out."));
    assert!(
        !multi.alive(0),
        "the old login's Codex ended before logout ran"
    );
    let last = next(&mut updates).await.unwrap();
    assert_eq!(last.phase, ProviderAuthPhase::Cancelled);
    assert!(next(&mut updates).await.is_none());
    // A new flow starts cleanly after it.
    let (tx, _u) = mpsc::unbounded_channel();
    assert!(f.auth_start(&target, Some("nope".into()), tx).await.is_ok());
}

/// Review r1 P1: dropping the factory ends a waiting flow's Codex.
#[cfg(unix)]
#[tokio::test]
async fn dropping_the_factory_ends_a_waiting_flow() {
    let (multi, options) = Multi::new("drop", vec![completing_login("l3")]);
    let f = CodexEngineFactory::new(options);
    let (tx, mut updates) = mpsc::unbounded_channel();
    f.auth_start(&default_target(), None, tx).await.unwrap();
    assert_eq!(
        next(&mut updates).await.unwrap().phase,
        ProviderAuthPhase::Waiting
    );
    assert!(multi.alive(0));
    drop(f);
    assert!(
        multi.ended(0).await,
        "the flow's Codex ended with the factory"
    );
    assert!(next(&mut updates).await.is_none());
}

/// Review r1 P1: one deadline, set at start, bounds the whole flow: a login confirmed after it
/// is not a success, and the expiry is reported at the deadline.
#[cfg(unix)]
#[tokio::test]
async fn the_deadline_bounds_the_whole_flow_including_verification() {
    let mut entries = session(login_started(
        2,
        "chatgpt",
        json!({"type": "chatgpt", "loginId": "l4", "authUrl": "https://auth.openai.com/x"}),
    ));
    entries.push(emit(json!({"method": "account/login/completed",
        "params": {"loginId": "l4", "success": true, "error": null}})));
    entries.push(expect(
        json!({"id": 3, "method": "account/read", "params": {}}),
    ));
    // Confirmed only after the deadline.
    entries.push(Entry::EmitInbound {
        label: None,
        frame: json!({"id": 3, "result": {"account": {"type": "apiKey"}, "requiresOpenaiAuth": true}}),
        after_ms: Some(2_000),
    });
    let (multi, mut options) = Multi::new("deadline", vec![entries]);
    options.auth_timeout = Duration::from_millis(1_000);
    let f = CodexEngineFactory::new(options);
    let (tx, mut updates) = mpsc::unbounded_channel();
    let started_at = std::time::Instant::now();
    f.auth_start(&default_target(), None, tx).await.unwrap();
    let mut last = None;
    while let Some(state) = next(&mut updates).await {
        last = Some(state);
    }
    let last = last.unwrap();
    assert_eq!(last.phase, ProviderAuthPhase::Failed);
    assert_eq!(
        last.message.as_deref(),
        Some("Sign-in expired. Start again.")
    );
    assert!(
        started_at.elapsed() < Duration::from_millis(1_800),
        "{:?}",
        started_at.elapsed()
    );
    assert!(multi.ended(0).await);
}

/// Review r2 P1: a reader that falls behind still ends on the terminal phase: an update queued
/// before cancel is followed by Cancelled on the stream.
#[cfg(unix)]
#[tokio::test]
async fn a_late_reader_sees_cancelled_after_anything_queued() {
    let (_multi, options) = Multi::new("late-reader", vec![completing_login("l5")]);
    let f = CodexEngineFactory::new(options);
    let target = default_target();
    let (tx, mut updates) = mpsc::unbounded_channel();
    let flow = f
        .auth_start(&target, None, tx)
        .await
        .unwrap()
        .flow_id
        .unwrap();
    // Waiting is queued but not read yet.
    for _ in 0..200 {
        if !updates.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(updates.len(), 1, "Waiting is queued");
    f.auth_cancel(&target, &flow).await.unwrap();
    let mut seen = Vec::new();
    while let Some(state) = next(&mut updates).await {
        seen.push(state.phase);
    }
    assert_eq!(
        seen,
        [ProviderAuthPhase::Waiting, ProviderAuthPhase::Cancelled]
    );
}

/// A transcript whose initialize answer comes after `ms` (Codex stalled while starting).
#[cfg(unix)]
fn stalled_initialize(ms: u64) -> Vec<Entry> {
    let mut entries = load("codex-0.167.0/basic.json").entries[..3].to_vec();
    if let Entry::EmitInbound { after_ms, .. } = &mut entries[1] {
        *after_ms = Some(ms);
    }
    entries
}

/// Review r2 P1: cancel while Codex is still initializing: the process the flow started has
/// exited (not just been signalled) when cancel answers.
#[cfg(unix)]
#[tokio::test]
async fn cancel_while_codex_initializes_waits_for_its_exit() {
    let (multi, options) = Multi::new("init-cancel", vec![stalled_initialize(5_000)]);
    let f = CodexEngineFactory::new(options);
    let target = default_target();
    let (tx, mut updates) = mpsc::unbounded_channel();
    let flow = f
        .auth_start(&target, None, tx)
        .await
        .unwrap()
        .flow_id
        .unwrap();
    multi.started(0).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(multi.alive(0), "Codex is up and initializing");
    f.auth_cancel(&target, &flow).await.unwrap();
    assert!(
        !multi.alive(0),
        "the flow's Codex exited before cancel answered"
    );
    assert_eq!(
        next(&mut updates).await.unwrap().phase,
        ProviderAuthPhase::Cancelled
    );
    assert!(next(&mut updates).await.is_none());
}

/// Review r2 P1: the deadline passing while Codex initializes ends the process before the
/// expiry is reported.
#[cfg(unix)]
#[tokio::test]
async fn expiry_while_codex_initializes_ends_it_before_reporting() {
    let (multi, mut options) = Multi::new("init-expiry", vec![stalled_initialize(10_000)]);
    options.auth_timeout = Duration::from_millis(1_500);
    let f = CodexEngineFactory::new(options);
    let (tx, mut updates) = mpsc::unbounded_channel();
    f.auth_start(&default_target(), None, tx).await.unwrap();
    let end = next(&mut updates).await.unwrap();
    assert!(
        !multi.alive(0),
        "Codex exited before the expiry was reported"
    );
    assert_eq!(end.phase, ProviderAuthPhase::Failed);
    assert_eq!(
        end.message.as_deref(),
        Some("Sign-in expired. Start again.")
    );
    assert!(next(&mut updates).await.is_none());
}
