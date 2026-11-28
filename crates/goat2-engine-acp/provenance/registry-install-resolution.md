# Registry install and resolution provenance

GOAT 2 path | v1 path@916b5ccc1b2 | treatment
--- | --- | ---
src/registry/index.rs | packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:124-159,328-367 | ported-to-Rust (was resolve.rs; merged into index.rs by slice reg-install)
src/registry/archive.rs | packages/provider-acp-registry/src/server/registryArchive.ts:1-12 | ported-to-Rust (was resolve.rs; see reg-install.md)
