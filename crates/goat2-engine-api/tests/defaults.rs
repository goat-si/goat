//! The Part 2 trait defaults: a driver that implements only the required methods reports
//! `Unsupported` for probe, set_config and read_item instead of pretending to succeed.

use goat2_contracts::{
    EngineItemLocator, ModelSelection, ProviderCapabilities, ProviderInstanceId, RuntimeMode,
};
use goat2_engine_api::*;

fn caps() -> ProviderCapabilities {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../goat2-contracts/tests/fixtures/provider_capabilities/example.json"
    ))
    .expect("capabilities fixture");
    serde_json::from_str(&json).expect("capabilities decode")
}

struct MinimalFactory;

#[async_trait::async_trait]
impl EngineFactory for MinimalFactory {
    async fn start(&self, _spec: SessionSpec) -> Result<EngineHandle, EngineError> {
        Err(EngineError::Unavailable("test".into()))
    }
    fn capabilities(&self) -> ProviderCapabilities {
        caps()
    }
}

struct MinimalSession;

#[async_trait::async_trait]
impl EngineSession for MinimalSession {
    async fn start_turn(
        &self,
        _inputs: Vec<EngineInput>,
        _settings: &TurnSettings,
    ) -> TurnStartResult {
        TurnStartResult::Unknown {
            reason: "test".into(),
        }
    }
    async fn steer(&self, _turn_id: &str, _inputs: Vec<EngineInput>) -> SteerResult {
        SteerResult::Unknown {
            reason: "test".into(),
        }
    }
    async fn interrupt(&self, _turn_id: &str) -> Result<(), EngineError> {
        Ok(())
    }
    async fn answer_request(&self, _key: &str, _answer: RequestAnswer) -> Result<(), EngineError> {
        Ok(())
    }
    async fn shutdown(&self) {}
}

#[tokio::test]
async fn probe_and_set_config_default_to_unsupported() {
    let factory = MinimalFactory;
    assert!(matches!(
        factory.probe().await,
        Err(EngineError::Unsupported(_))
    ));
    assert!(factory.capabilities().turns.supports_interrupt);

    let settings = TurnSettings {
        model_selection: ModelSelection {
            instance_id: ProviderInstanceId::from("claudeAgent"),
            model: "claude-opus-5-5".into(),
            options: None,
        },
        runtime_mode: RuntimeMode::Auto,
    };
    assert!(matches!(
        MinimalSession.set_config(&settings).await,
        Err(EngineError::Unsupported(_))
    ));

    let locator = EngineItemLocator {
        turn_id: "turn-1".into(),
        item_id: "item-1".into(),
    };
    assert!(matches!(
        MinimalSession.read_item(&locator).await,
        Err(EngineError::Unsupported(_))
    ));
}
