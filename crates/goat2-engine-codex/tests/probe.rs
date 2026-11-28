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

/// initialize + initialized as recorded from codex 0.167.0 (the GOAT client identity).
fn handshake(codex_home: Option<&str>) -> Vec<Entry> {
    let t = load("codex-0.167.0/basic.json");
    let mut entries: Vec<Entry> = t.entries[..3].to_vec();
    if let Entry::EmitInbound { frame, .. } = &mut entries[1] {
        // The recording redacts the user agent; this is the shape codex 0.167.0 sends.
        frame["result"]["userAgent"] = json!("T3 Code/0.167.0 (Mac OS 26.1.0; arm64) vscode/0.0.0");
        if let Some(home) = codex_home {
            frame["result"]["codexHome"] = json!(home);
        }
    }
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
