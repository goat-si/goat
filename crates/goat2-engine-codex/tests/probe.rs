//! CodexEngineFactory::probe against goat2-fake-codex: the v1 probe sequence (initialize,
//! account/read, config/read, model/list pages) and its status, auth and model mapping.

mod support;

use std::time::Duration;

use goat2_contracts::{
    ProviderOptionDescriptor, ServerProviderAuthStatus, ServerProviderCli, ServerProviderState,
};
use goat2_engine_api::EngineFactory;
use goat2_engine_codex::transcript::{Entry, Transcript};
use goat2_engine_codex::{CodexEngineFactory, CodexEngineOptions};
use serde_json::{Value, json};
use support::fake::{load, write_temp};

/// initialize + initialized as recorded from codex 0.167.0 (the GOAT client identity), then the
/// config read for the cwd v1 takes the effective endpoint from.
fn handshake(codex_home: Option<&str>) -> Vec<Entry> {
    handshake_with_route(codex_home, json!({}))
}

fn handshake_with_route(codex_home: Option<&str>, route_config: Value) -> Vec<Entry> {
    let t = load("codex-0.167.0/basic.json");
    let mut entries: Vec<Entry> = t.entries[..3].to_vec();
    if let Entry::EmitInbound { frame, .. } = &mut entries[1] {
        // The recording redacts the user agent; this is the shape codex 0.167.0 sends.
        frame["result"]["userAgent"] = json!("T3 Code/0.167.0 (Mac OS 26.1.0; arm64) vscode/0.0.0");
        if let Some(home) = codex_home {
            frame["result"]["codexHome"] = json!(home);
        }
    }
    entries.push(Entry::ExpectOutbound {
        label: None,
        frame: json!({"id": 90, "method": "config/read", "params": {"cwd": "<cwd>", "includeLayers": false}}),
        wildcards: vec!["/params/cwd".into()],
    });
    entries.push(emit(json!({"id": 90, "result": {"config": route_config}})));
    entries
}

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

fn factory(entries: Vec<Entry>) -> CodexEngineFactory {
    let mut t = Transcript::new("probe");
    t.entries = entries;
    let path = write_temp(&t);
    CodexEngineFactory::new(CodexEngineOptions {
        program: env!("CARGO_BIN_EXE_goat2-fake-codex").into(),
        env_set: vec![("GOAT2_FAKE_CODEX_TRANSCRIPT".into(), path.into_os_string())],
        kill_grace: Duration::from_millis(500),
        client_version: "0.0.0".into(),
        ..CodexEngineOptions::default()
    })
}

fn model(slug: &str, default: bool, extra: Value) -> Value {
    let mut m = json!({"id": slug, "model": slug, "displayName": slug, "description": "", "hidden": false,
        "isDefault": default, "defaultReasoningEffort": "medium",
        "supportedReasoningEfforts": [{"reasoningEffort": "low", "description": ""}, {"reasoningEffort": "medium", "description": ""}, {"reasoningEffort": "xhigh", "description": ""}]});
    if let (Some(m), Some(extra)) = (m.as_object_mut(), extra.as_object()) {
        m.extend(extra.clone());
    }
    m
}

fn select<'a>(
    m: &'a goat2_contracts::ServerProviderModel,
    id: &str,
) -> Option<&'a ProviderOptionDescriptor> {
    m.capabilities
        .as_ref()?
        .option_descriptors
        .as_ref()?
        .iter()
        .find(|d| match d {
            ProviderOptionDescriptor::Select { id: i, .. }
            | ProviderOptionDescriptor::Boolean { id: i, .. } => i == id,
        })
}

#[tokio::test]
async fn a_codex_without_a_login_reports_sign_in() {
    let mut e = handshake(None);
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 2, "result": {"account": null, "requiresOpenaiAuth": true}}),
    ));
    let p = factory(e).probe().await.unwrap();
    assert!(p.installed);
    assert_eq!(p.version.as_deref(), Some("0.167.0"));
    assert_eq!(p.status, ServerProviderState::Error);
    assert_eq!(p.auth.status, ServerProviderAuthStatus::Unauthenticated);
    assert_eq!(
        p.message.as_deref(),
        Some("Codex CLI is not authenticated. Run `codex login` and try again.")
    );
    assert!(p.models.is_empty());
}

#[tokio::test]
async fn an_api_key_login_lists_every_page_with_configured_defaults() {
    let mut e = handshake(None);
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 2, "result": {"account": {"type": "apiKey"}, "requiresOpenaiAuth": true}}),
    ));
    e.push(expect(
        json!({"id": 3, "method": "config/read", "params": {"includeLayers": false}}),
    ));
    e.push(emit(json!({"id": 3, "result": {"config": {"service_tier": "fast", "openai_base_url": "http://127.0.0.1:8080/v1",
        "features": {"api_key_cyber_access_programs": false}}}})));
    e.push(expect(
        json!({"id": 4, "method": "model/list", "params": {}}),
    ));
    e.push(emit(json!({"id": 4, "result": {"nextCursor": "page-2", "data": [
        model("gpt-6.1-terra", true, json!({"serviceTiers": [{"id": "priority", "name": "Fast", "description": "Faster"}],
            "availableAccessPrograms": {"cyber": ["daybreakBlue"]}}))]}})));
    e.push(expect(
        json!({"id": 5, "method": "model/list", "params": {"cursor": "page-2"}}),
    ));
    e.push(emit(json!({"id": 5, "result": {"nextCursor": null, "data": [model("gpt-5.6-sol", false, json!({}))]}})));
    let p = factory(e).probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Ready, "{:?}", p.message);
    assert_eq!(p.auth.status, ServerProviderAuthStatus::Authenticated);
    assert_eq!(p.auth.auth_type.as_deref(), Some("apiKey"));
    assert_eq!(p.auth.label.as_deref(), Some("OpenAI API Key"));
    assert_eq!(p.auth.endpoint.as_deref(), Some("http://127.0.0.1:8080"));
    let slugs: Vec<_> = p.models.iter().map(|m| m.slug.as_str()).collect();
    assert_eq!(slugs, ["gpt-6.1-terra", "gpt-5.6-sol"]);
    // v1 PREFERRED_DEFAULT_CODEX_MODELS: gpt-5.6-sol wins over Codex's own isDefault.
    assert_eq!(p.models[0].is_default, None);
    assert_eq!(p.models[1].is_default, Some(true));
    assert_eq!(p.models[0].name, "GPT-6.1-Terra");
    let Some(ProviderOptionDescriptor::Select {
        options,
        current_value,
        ..
    }) = select(&p.models[0], "reasoningEffort")
    else {
        panic!()
    };
    assert_eq!(
        options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(),
        ["Low", "Medium", "Extra High"]
    );
    assert_eq!(current_value.as_deref(), Some("medium"));
    // config service_tier "fast" selects the priority tier (v1 applyConfiguredCodexServiceTier).
    let Some(ProviderOptionDescriptor::Select { current_value, .. }) =
        select(&p.models[0], "serviceTier")
    else {
        panic!()
    };
    assert_eq!(current_value.as_deref(), Some("priority"));
    // An API key with the programs turned off offers no cyber access.
    assert!(select(&p.models[0], "cyberAccessProgram").is_none());
}

#[tokio::test]
async fn a_chatgpt_login_lists_again_after_codex_refreshes_its_catalog() {
    let home = std::env::temp_dir().join(format!("goat2-probe-home-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    // A catalog written after the probe started (v1 requestCodexChatGptModels).
    std::fs::write(
        home.join("models_cache.json"),
        json!({"fetched_at": "2100-01-01T00:00:00Z"}).to_string(),
    )
    .unwrap();
    let mut e = handshake(Some(home.to_str().unwrap()));
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    e.push(emit(json!({"id": 2, "result": {"account": {"type": "chatgpt", "email": "person@example.com", "planType": "pro"}, "requiresOpenaiAuth": true}})));
    e.push(expect(
        json!({"id": 3, "method": "config/read", "params": {"includeLayers": false}}),
    ));
    e.push(emit(
        json!({"id": 3, "error": {"code": -32603, "message": "no config"}}),
    ));
    e.push(expect(
        json!({"id": 4, "method": "model/list", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 4, "result": {"data": [model("gpt-6-luna", true, json!({}))]}}),
    ));
    e.push(expect(
        json!({"id": 5, "method": "model/list", "params": {}}),
    ));
    e.push(emit(json!({"id": 5, "result": {"data": [model("gpt-6-luna", false, json!({})), model("gpt-6.1-terra", true, json!({}))]}})));
    let p = factory(e).probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Ready, "{:?}", p.message);
    assert_eq!(
        p.auth.label.as_deref(),
        Some("ChatGPT Pro 200 Subscription")
    );
    assert_eq!(p.auth.email.as_deref(), Some("person@example.com"));
    assert_eq!(p.models.len(), 2, "the refreshed catalog");
    assert_eq!(p.models[1].is_default, Some(true));
    let _ = std::fs::remove_dir_all(&home);
}

#[tokio::test]
async fn a_missing_binary_reports_could_not_start() {
    let f = CodexEngineFactory::new(CodexEngineOptions {
        program: "/nonexistent/codex".into(),
        ..CodexEngineOptions::default()
    });
    let p = f.probe().await.unwrap();
    assert!(!p.installed);
    assert_eq!(p.cli, Some(ServerProviderCli::Missing));
    assert_eq!(p.status, ServerProviderState::Error);
    assert_eq!(p.binary_path, None);
    assert!(
        p.message
            .unwrap()
            .starts_with("Could not start Codex CLI (`/nonexistent/codex`).")
    );
}

#[tokio::test]
async fn a_route_away_from_openai_needs_no_openai_login() {
    // v1 CodexProvider.ts:520-525 and CodexProviderAccount.ts:156-170: Codex keeps
    // requiresOpenaiAuth for its built-in provider even when the config sends requests elsewhere.
    let mut e = handshake_with_route(None, json!({"openai_base_url": "http://127.0.0.1:9999/v1"}));
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 2, "result": {"account": null, "requiresOpenaiAuth": true}}),
    ));
    e.push(expect(
        json!({"id": 3, "method": "config/read", "params": {"includeLayers": false}}),
    ));
    e.push(emit(
        json!({"id": 3, "result": {"config": {"openai_base_url": "http://127.0.0.1:9999/v1"}}}),
    ));
    e.push(expect(
        json!({"id": 4, "method": "model/list", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 4, "result": {"data": [model("local-model", true, json!({}))]}}),
    ));
    let p = factory(e).probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Ready, "{:?}", p.message);
    assert_eq!(p.auth.status, ServerProviderAuthStatus::Unknown);
    assert_eq!(p.auth.endpoint.as_deref(), Some("http://127.0.0.1:9999"));
    assert_eq!(p.models.len(), 1);
}

#[tokio::test]
async fn a_refused_model_list_is_a_failure_not_a_late_catalog() {
    // v1 propagates request failures (CodexProvider.ts:290-303,864-904); only the deadline makes
    // the catalog absent (warning).
    let mut e = handshake(None);
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 2, "result": {"account": {"type": "apiKey"}, "requiresOpenaiAuth": true}}),
    ));
    e.push(expect(
        json!({"id": 3, "method": "config/read", "params": {"includeLayers": false}}),
    ));
    e.push(emit(json!({"id": 3, "result": {"config": {}}})));
    e.push(expect(
        json!({"id": 4, "method": "model/list", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 4, "error": {"code": -32603, "message": "catalog unavailable"}}),
    ));
    let p = factory(e).probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Error);
    assert!(p.installed);
    let message = p.message.unwrap();
    assert!(
        message.starts_with("Codex app-server provider probe failed: model/list"),
        "{message}"
    );
    assert!(message.contains("catalog unavailable"), "{message}");
}

/// An API-key login whose first model/list page is `page`.
fn api_key_catalog(page: Value) -> Vec<Entry> {
    let mut e = handshake(None);
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 2, "result": {"account": {"type": "apiKey"}, "requiresOpenaiAuth": true}}),
    ));
    e.push(expect(
        json!({"id": 3, "method": "config/read", "params": {"includeLayers": false}}),
    ));
    e.push(emit(json!({"id": 3, "result": {"config": {}}})));
    e.push(expect(
        json!({"id": 4, "method": "model/list", "params": {}}),
    ));
    e.push(emit(json!({"id": 4, "result": page})));
    e
}

#[tokio::test]
async fn a_malformed_model_entry_fails_instead_of_a_partial_catalog() {
    // v1 decodes the whole model/list response with its schema; one bad entry fails the probe.
    let page =
        json!({"data": [model("gpt-6.1-terra", true, json!({})), {"displayName": "no slug"}]});
    let p = factory(api_key_catalog(page)).probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Error);
    assert!(p.models.is_empty(), "{:?}", p.models);
    let message = p.message.unwrap();
    assert!(message.contains("unreadable model"), "{message}");
}

/// Final review r1: `account/read` is checked whole against the pinned `GetAccountResponse` (v1
/// decodes it with Codex's schema), so a malformed answer fails the probe instead of showing a
/// signed-in or unknown account as Ready.
#[tokio::test]
async fn a_malformed_account_answer_fails_the_probe() {
    let cases = [
        (
            "no requiresOpenaiAuth",
            json!({"account": {"type": "apiKey"}}),
        ),
        (
            "empty account",
            json!({"account": {}, "requiresOpenaiAuth": true}),
        ),
        (
            "unknown account type",
            json!({"account": {"type": "magic"}, "requiresOpenaiAuth": true}),
        ),
        (
            "chatgpt without email",
            json!({"account": {"type": "chatgpt", "planType": "pro"}, "requiresOpenaiAuth": true}),
        ),
        (
            "chatgpt with an unknown plan",
            json!({"account": {"type": "chatgpt", "email": null, "planType": "galaxy"}, "requiresOpenaiAuth": true}),
        ),
        (
            "incomplete workspace routing",
            json!({"account": {"type": "apiKey"}, "requiresOpenaiAuth": true, "workspaceRouting": {"backendOrigin": "x"}}),
        ),
        (
            "string requiresOpenaiAuth",
            json!({"account": null, "requiresOpenaiAuth": "yes"}),
        ),
    ];
    for (name, answer) in cases {
        let mut e = handshake(None);
        e.push(expect(
            json!({"id": 2, "method": "account/read", "params": {}}),
        ));
        e.push(emit(json!({"id": 2, "result": answer})));
        let p = factory(e).probe().await.unwrap();
        assert_eq!(p.status, ServerProviderState::Error, "{name}");
        assert_ne!(
            p.auth.status,
            ServerProviderAuthStatus::Authenticated,
            "{name}"
        );
        assert!(p.models.is_empty(), "{name}");
        let message = p.message.unwrap();
        assert!(message.contains("unreadable account"), "{name}: {message}");
    }
}

#[tokio::test]
async fn an_initialize_answer_missing_a_required_field_fails_the_probe() {
    let mut e = handshake(None);
    if let Entry::EmitInbound { frame, .. } = &mut e[1] {
        frame["result"]
            .as_object_mut()
            .unwrap()
            .remove("platformOs");
    }
    // The probe stops after initialize; nothing else is expected.
    e.truncate(3);
    let p = factory(e).probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Error);
    assert!(p.models.is_empty());
}

#[tokio::test]
async fn a_malformed_cursor_fails_instead_of_ending_the_catalog() {
    let page = json!({"data": [model("gpt-6.1-terra", true, json!({}))], "nextCursor": 7});
    let p = factory(api_key_catalog(page)).probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Error);
    assert!(p.models.is_empty(), "{:?}", p.models);
    let message = p.message.unwrap();
    assert!(message.contains("unreadable nextCursor"), "{message}");
}

/// Review r3: an entry is checked against the whole pinned `Model` definition (v1 decodes the
/// response with Codex's schema), so a malformed nested field fails the catalog instead of
/// quietly dropping an option.
#[tokio::test]
async fn a_malformed_nested_model_field_fails_the_catalog() {
    let without = |key: &str| {
        let mut m = model("gpt-6.1-terra", true, json!({}));
        m.as_object_mut().unwrap().remove(key);
        m
    };
    let with = |extra: Value| model("gpt-6.1-terra", true, extra);
    let cases = [
        ("no displayName", without("displayName")),
        ("no description", without("description")),
        ("no hidden", without("hidden")),
        (
            "no supportedReasoningEfforts",
            without("supportedReasoningEfforts"),
        ),
        ("numeric displayName", with(json!({"displayName": 5}))),
        (
            "empty default effort",
            with(json!({"defaultReasoningEffort": ""})),
        ),
        (
            "effort without description",
            with(json!({"supportedReasoningEfforts": [{"reasoningEffort": "low"}]})),
        ),
        (
            "empty effort",
            with(
                json!({"supportedReasoningEfforts": [{"reasoningEffort": "", "description": ""}]}),
            ),
        ),
        (
            "tier without name",
            with(json!({"serviceTiers": [{"id": "priority", "description": ""}]})),
        ),
        ("null serviceTiers", with(json!({"serviceTiers": null}))),
        (
            "unknown cyber program",
            with(json!({"availableAccessPrograms": {"cyber": ["standard", "daybreakGreen"]}})),
        ),
        (
            "unknown modality",
            with(json!({"inputModalities": ["text", "video"]})),
        ),
        (
            "numeric defaultServiceTier",
            with(json!({"defaultServiceTier": 1})),
        ),
        (
            "upgradeInfo without model",
            with(json!({"upgradeInfo": {}})),
        ),
    ];
    for (name, bad) in cases {
        let page = json!({"data": [model("gpt-6.1-ember", false, json!({})), bad]});
        let p = factory(api_key_catalog(page)).probe().await.unwrap();
        assert_eq!(p.status, ServerProviderState::Error, "{name}");
        assert!(p.models.is_empty(), "{name}: {:?}", p.models);
        let message = p.message.unwrap();
        assert!(message.contains("unreadable model"), "{name}: {message}");
    }
    // Unknown fields and the nullable or defaulted ones stay accepted.
    let fine = with(
        json!({"someFutureField": {"x": 1}, "upgrade": null, "availableAccessPrograms": null,
        "serviceTiers": [{"id": "priority", "name": "Fast", "description": ""}], "inputModalities": ["text", "image", "audio"]}),
    );
    let p = factory(api_key_catalog(json!({"data": [fine]})))
        .probe()
        .await
        .unwrap();
    assert_eq!(p.status, ServerProviderState::Ready, "{:?}", p.message);
    assert_eq!(p.models.len(), 1);
}

#[cfg(unix)]
fn script(name: &str, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("goat2-probe-bin-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("codex");
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
#[tokio::test]
async fn a_missing_interpreter_is_not_a_missing_cli() {
    // v1: not found is also what a missing interpreter gives; only a missing command counts.
    let path = script("interp", "#!/nonexistent/interpreter\n");
    let f = CodexEngineFactory::new(CodexEngineOptions {
        program: path.clone(),
        ..CodexEngineOptions::default()
    });
    let p = f.probe().await.unwrap();
    assert!(p.installed, "{:?}", p.message);
    assert_ne!(p.cli, Some(ServerProviderCli::Missing));
    assert_eq!(p.status, ServerProviderState::Error);
    assert_eq!(p.binary_path.as_deref(), Some(path.to_str().unwrap()));
    assert!(
        p.message
            .unwrap()
            .starts_with("Codex app-server provider probe failed:")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn the_version_fallback_ends_its_whole_process_group() {
    // app-server fails at once, so the probe asks `codex --version`; that leaves a background
    // child, which must not outlive the probe.
    let pid_file = std::env::temp_dir().join(format!("goat2-probe-pid-{}", std::process::id()));
    let path = script(
        "version",
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then sleep 30 >/dev/null 2>&1 & echo $! > \"$PROBE_PID_FILE\"; echo \"codex-cli 9.9.9\"; exit 0; fi\nexit 1\n",
    );
    let f = CodexEngineFactory::new(CodexEngineOptions {
        program: path,
        env_set: vec![("PROBE_PID_FILE".into(), pid_file.clone().into_os_string())],
        ..CodexEngineOptions::default()
    });
    let p = f.probe().await.unwrap();
    assert_eq!(p.status, ServerProviderState::Error);
    assert_eq!(p.version.as_deref(), Some("9.9.9"));
    assert_eq!(p.cli, Some(ServerProviderCli::Present));
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    // SAFETY: signal 0 only checks that the process exists.
    let alive = unsafe { libc::kill(pid, 0) == 0 };
    assert!(!alive, "the --version child {pid} outlived the probe");
}

#[tokio::test]
async fn a_stalled_config_read_does_not_cost_the_catalog() {
    // v1 runs config/read and model/list together under the discovery deadline
    // (CodexProvider.ts:535-600): models that answer at once count even when config never does.
    let mut e = handshake(None);
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 2, "result": {"account": {"type": "apiKey"}, "requiresOpenaiAuth": true}}),
    ));
    e.push(expect(
        json!({"id": 3, "method": "config/read", "params": {"includeLayers": false}}),
    ));
    // No answer to config/read.
    e.push(expect(
        json!({"id": 4, "method": "model/list", "params": {}}),
    ));
    e.push(emit(
        json!({"id": 4, "result": {"data": [model("gpt-6.1-terra", true, json!({}))]}}),
    ));
    let f = factory(e);
    let p = goat2_engine_codex::probe::probe_with(&f.options, Duration::from_millis(2_500)).await;
    assert_eq!(p.status, ServerProviderState::Ready, "{:?}", p.message);
    assert_eq!(p.models.len(), 1);
}

#[tokio::test]
async fn a_silent_codex_times_out() {
    let mut e = handshake(None);
    e.push(expect(
        json!({"id": 2, "method": "account/read", "params": {}}),
    ));
    let f = factory(e);
    let started = std::time::Instant::now();
    let p = goat2_engine_codex::probe::probe_with(&f.options, Duration::from_millis(800)).await;
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(p.installed);
    assert_eq!(p.status, ServerProviderState::Error);
    assert_eq!(
        p.message.as_deref(),
        Some("Timed out while checking Codex app-server provider status.")
    );
}
