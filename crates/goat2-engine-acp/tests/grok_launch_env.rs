//! Grok's xAI key on the merged launch environment, end to end through the driver and the mock
//! agent (final review 6 finding B2). v1 `applyStoredGrokApiKey` (provider-grok auth.ts:57-64)
//! fills `XAI_API_KEY` from the stored key when the *merged* environment (instance variables over
//! the process environment) has a blank one, and `resolveGrokAuthMethodId` (acpSupport.ts:164-168)
//! chooses the sign-in method from that same environment.
//!
//! This file is its own test binary with a single test, because it sets the host process's
//! `XAI_API_KEY` (the inherited key) and nothing else may read the environment meanwhile.

use std::collections::BTreeMap;
use std::sync::Arc;

use goat2_contracts::{EngineConfig, ModelSelection, RuntimeMode};
use goat2_engine_acp::{AcpEngineFactory, agents::grok::Grok};
use goat2_engine_api::{EngineFactory, LaunchSpec, McpEndpoint, SessionSpec};
use serde_json::Value;

const KEY: &str = "XAI_API_KEY";

/// Start Grok on the mock with a blank `XAI_API_KEY` launch override; the key the agent got and
/// the method it was asked to sign in with.
async fn launch(stored: Option<&'static str>) -> (Value, Option<String>) {
    let dir = tempfile::tempdir().unwrap();
    let env_log = dir.path().join("env.json");
    let requests = dir.path().join("requests.jsonl");
    let env: BTreeMap<String, String> = [
        (KEY, ""),
        ("GOAT_ACP_ENV_LOG_PATH", env_log.to_str().unwrap()),
        ("GOAT_ACP_ENV_LOG_NAMES", KEY),
        ("GOAT_ACP_REQUEST_LOG_PATH", requests.to_str().unwrap()),
        ("GOAT_ACP_AUTH_REQUIRED", "1"),
        (
            "GOAT_ACP_AUTH_METHODS",
            r#"[{"id":"xai.api_key","name":"xAI API key"},{"id":"cached_token","name":"Grok account"}]"#,
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let spec = SessionSpec {
        thread_id: "t".into(),
        engine: EngineConfig {
            provider_instance_id: "grok".into(),
            model_selection: ModelSelection {
                instance_id: "grok".into(),
                model: "grok-build".into(),
                options: None,
            },
            runtime_mode: RuntimeMode::FullAccess,
            cwd: dir.path().to_string_lossy().into_owned(),
        },
        resume: None,
        mcp: McpEndpoint {
            url: "http://127.0.0.1:9/mcp".into(),
            bearer_token: "fake".into(),
        },
        host_generation: 1,
        process_generation: 1,
        instructions: None,
        launch: Some(LaunchSpec {
            binary: Some(env!("CARGO_BIN_EXE_goat2-acp-mock-agent").into()),
            args: vec![],
            env,
        }),
    };
    let flavor = Grok {
        stored_api_key: stored.map(|key| {
            Arc::new(move || Some(key.to_owned()))
                as goat2_engine_acp::agents::grok_auth::StoredApiKey
        }),
        ..Grok::default()
    };
    let handle = AcpEngineFactory::new(Arc::new(flavor))
        .with_mcp_bridge(goat2_engine_acp::McpBridgeCommand::new(
            "/goat2-test/bin/goat2-acp-mcp-bridge",
            Vec::<String>::new(),
        ))
        .start(spec)
        .await
        .expect("start");
    handle.session.shutdown().await;
    let seen: Value = serde_json::from_str(&std::fs::read_to_string(&env_log).unwrap()).unwrap();
    let method = std::fs::read_to_string(&requests)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|m| m["method"] == "authenticate")
        .and_then(|m| m["params"]["methodId"].as_str().map(str::to_owned));
    (seen[KEY].clone(), method)
}

#[tokio::test]
async fn a_blank_key_override_gets_the_stored_key_and_auth_follows_the_merged_environment() {
    let api_key = Some("xai.api_key".to_owned());
    let cached = Some("cached_token".to_owned());
    for inherited in [None, Some("host-key-synthetic")] {
        // SAFETY: this binary runs only this test, on one thread; nothing reads the environment
        // while it changes.
        unsafe {
            match inherited {
                Some(value) => std::env::set_var(KEY, value),
                None => std::env::remove_var(KEY),
            }
        }
        // The blank override masks an inherited key; the stored key fills the merged blank.
        assert_eq!(
            launch(Some("stored-key-synthetic")).await,
            (Value::from("stored-key-synthetic"), api_key.clone()),
            "inherited {inherited:?}, stored key"
        );
        // Nothing to fill it with: the agent gets the blank and signs in with its own token.
        assert_eq!(
            launch(None).await,
            (Value::from(""), cached.clone()),
            "inherited {inherited:?}, no stored key"
        );
    }
    // SAFETY: as above.
    unsafe { std::env::remove_var(KEY) };
}
