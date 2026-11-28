//! SDK and RPC engines (lane P2-S, `goat2-engine-sdk`): Cursor, OpenCode and Muse run behind one
//! `apps/engine-helper` Node process per thread; Pi and OmO are driven from Rust over
//! `--mode rpc`. The host supplies what the drivers cannot see: where an attachment's saved file
//! is (the same rule as Codex) and where the Pi extension file lives under the data dir.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use goat2_contracts::{ChatAttachment, EngineDriver, ThreadId};
use goat2_engine_sdk::helper::AttachmentResolver;
use goat2_engine_sdk::{HelperFactory, HelperLaunch, PiFactory};

use crate::engine::EngineFactory;

/// The SDK engines, keyed by driver kind (v1 ProviderDriverKind slug) for the host's factory
/// registry. Pi and OmO are always registered: their CLIs come from PATH and the provider check
/// reports when one is missing. Cursor, OpenCode and Muse need the helper, so they are registered
/// only when `helper` is set (the Dev app sets GOAT2_ENGINE_HELPER_ENTRY / _NODE / _RUN_AS_NODE;
/// see [HelperLaunch::from_env]).
pub fn sdk_factories(
    data_dir: &Path,
    helper: Option<HelperLaunch>,
) -> BTreeMap<String, Arc<dyn EngineFactory>> {
    let threads = data_dir.join("threads");
    let resolver: AttachmentResolver =
        Arc::new(move |thread: &ThreadId, attachment: &ChatAttachment| {
            super::codex::attachment_path(&threads, thread, attachment)
        });
    let mut factories: BTreeMap<String, Arc<dyn EngineFactory>> = BTreeMap::new();
    for driver in [EngineDriver::Pi, EngineDriver::Omo] {
        let kind = driver.driver_kind().to_owned();
        if let Some(factory) = PiFactory::for_driver(driver) {
            let factory = factory
                .with_cache_dir(data_dir.join("cache").join("pi"))
                .with_attachment_resolver(resolver.clone());
            factories.insert(kind, Arc::new(factory));
        }
    }
    match helper {
        Some(launch) => {
            for driver in [
                EngineDriver::Cursor,
                EngineDriver::Opencode,
                EngineDriver::Muse,
            ] {
                let kind = driver.driver_kind().to_owned();
                if let Some(factory) = HelperFactory::new(driver, launch.clone()) {
                    factories.insert(
                        kind,
                        Arc::new(factory.with_attachment_resolver(resolver.clone())),
                    );
                }
            }
        }
        None => tracing::info!(
            "engine helper not configured (GOAT2_ENGINE_HELPER_ENTRY unset): Cursor, OpenCode and Muse are not registered"
        ),
    }
    factories
}

#[cfg(test)]
mod tests {
    use goat2_contracts::{BlobRef, ChatAttachmentType};

    use super::*;

    #[test]
    fn pi_and_omo_always_register_and_the_helper_engines_only_with_the_helper() {
        let dir = tempfile::tempdir().unwrap();
        let without: Vec<String> = sdk_factories(dir.path(), None).into_keys().collect();
        assert_eq!(without, ["omo", "pi"]);
        let with: Vec<String> = sdk_factories(
            dir.path(),
            Some(HelperLaunch::new("node", "/opt/engine-helper/dist/main.js")),
        )
        .into_keys()
        .collect();
        assert_eq!(with, ["cursor", "muse", "omo", "opencode", "pi"]);
    }

    #[test]
    fn registered_factories_report_their_own_capabilities() {
        let dir = tempfile::tempdir().unwrap();
        let factories = sdk_factories(dir.path(), Some(HelperLaunch::new("node", "/x/main.js")));
        for (kind, driver) in [
            ("cursor", EngineDriver::Cursor),
            ("opencode", EngineDriver::Opencode),
            ("muse", EngineDriver::Muse),
            ("pi", EngineDriver::Pi),
        ] {
            assert_eq!(
                factories[kind].capabilities(),
                goat2_engine_sdk::capabilities::for_driver(&driver).unwrap(),
                "{kind}"
            );
        }
    }

    #[test]
    fn the_resolver_is_the_hosts_saved_blob_rule() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("threads/t1/blobs")).unwrap();
        std::fs::write(dir.path().join("threads/t1/blobs/a.txt"), b"x").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"x").unwrap();
        let threads = dir.path().join("threads");
        let at = |path: &str| ChatAttachment {
            kind: ChatAttachmentType::File,
            id: "a".into(),
            name: "a.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 1,
            blob: Some(BlobRef {
                path: path.into(),
                size_bytes: 1,
            }),
        };
        let t1 = ThreadId::new("t1");
        assert_eq!(
            super::super::codex::attachment_path(&threads, &t1, &at("blobs/a.txt")),
            Some(threads.join("t1/blobs/a.txt"))
        );
        assert_eq!(
            super::super::codex::attachment_path(&threads, &t1, &at("../../secret.txt")),
            None
        );
    }
}
