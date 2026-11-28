# Registry install, settings and resolution provenance (slice reg-install)

Reference: GOAT v1 commit 916b5ccc1b2. One row per GOAT 2 file; line ranges are v1's.

| GOAT 2 path | v1 path@916b5ccc1b2 (lines) | treatment |
| --- | --- | --- |
| `src/registry/contracts.rs` | `packages/contracts/src/acpRegistry.ts` (1-362, all); `packages/contracts/src/model.ts` (7-104, provider option descriptors and `ModelCapabilities`); `packages/contracts/src/providerInstance.ts` (7-15,24, `ProviderInstanceId`); `packages/contracts/src/baseSchemas.ts` (294-300, `ThreadId`/`ProjectId`) | ported-to-Rust (serde types with v1 JSON names; every Effect check as a `normalize` rule) |
| `src/registry/schema.rs` | `packages/contracts/src/baseSchemas.ts` (8-29, `TrimmedString`, `isNonBlank`); Effect 4.0.5 `Schema.ts` (7636, 7924, 8525-8550) and `SchemaAST.ts` (4312-4330) messages | adapted (check helpers that reproduce Effect's "Expected ..." text and `at [...]` paths) |
| `src/registry/settings.rs` | `packages/provider-acp-registry/src/settings.ts` (1-113, all); `customModels.ts` (1-11, all); `packages/contracts/src/model.ts` (106-114, `CustomModelEntry`/`CustomModelSetting`) | ported-to-Rust (decode with v1 defaults, trimming, type checks and the details filter) |
| `src/registry/local_presets.rs` | `packages/provider-acp-registry/src/localPresets.ts` (1-24, all) | verbatim values (labels, commands, args, inlined icons, hints, docs URLs) |
| `src/registry/package.rs` | `registryPackageSpec.ts` (1-22, all); `registryPackageCommand.ts` (4-12); `AcpRegistrySupport.ts` (163-167, 899-915) | ported-to-Rust |
| `src/registry/command_path.rs` | `packages/shared/src/shell.ts` (99-154, 326-332, 370-423); `packages/shared/src/shellPathEntries.ts` (1-23); `managedCommandPath.ts` (1-33, all); `localCommandPath.ts` (1-30, all); `AcpRegistrySupport.ts` (534-546) | ported-to-Rust (paths joined with the host separator) |
| `src/registry/archive.rs` | `registryArchive.ts` (1-44, all); `AcpRegistrySupport.ts` (79, 1382-1418) | adapted (same entry rule; listing and extraction in process with tar/flate2/bzip2/zip instead of `tar`/`unzip` processes; zip writes refuse escaping links) |
| `src/registry/runtime_temp.rs` | `registryRuntimeTemp.ts` (1-122) | ported-to-Rust (lease drop replaces `acquireRelease`) |
| `src/registry/environment.rs` | `environmentCheck.ts` (1-24, all); `sessionEnvironmentKey.ts` (1-51, all) | ported-to-Rust (configuration origin carried with the options instead of a `WeakMap`) |
| `src/registry/display.rs` | `shellDisplayToken.ts` (1-5, all); `agentVersion.ts` (1-5, all) | ported-to-Rust |
| `src/registry/install.rs` | `AcpRegistrySupport.ts` (74-88, 169-180, 209-225, 229-318, 468-471, 513-520, 717-1244, 1246-1444, 1903-1943); `registryHttpsUrl.ts` (3-16, download URL check) | ported-to-Rust (v1 messages and limits; HTTP through an `ArchiveDownload` trait) |
| `src/registry/catalog.rs` | `AcpRegistrySupport.ts` (320-466, 509-581, 1446-1970); `registryRuntimeTemp.ts` (124-146); `registryResolveRefresh.ts` (1-52, via `cache.rs`); `adapter.ts` (150-179, 268-269, 350-369, the launch order) | ported-to-Rust (catalog service; `launch` is new glue that returns `RegistryAgentFlavor`) |
| `src/registry/coordinator.rs` | `AcpRegistryRuntimeCoordinator.ts` (1-423, all) | ported-to-Rust (generic payloads; broadcast channels replace unbounded PubSub) |
| `src/registry/catalog_tests.rs` | `AcpRegistrySupport.test.ts` (116-347, 349-567, 909-1026, 1297-1509); `AcpRegistrySupport.binaryInstall.test.ts` (1-208); `AcpRegistrySupport.noInstall.test.ts` (1-106); `AcpRegistrySupport.npmShim.test.ts` (1-77); `AcpRegistrySupport.testkit.ts` (1-134) | adapted (same scenarios; a 127.0.0.1 HTTP server replaces the fake `HttpClient`) |
| `src/registry/testing/npm.fixture.sh` | `src/server/testing/AcpRegistrySupport.npm.fixture.sh` (1-41, all) | verbatim |
| `src/registry/testing/uv.fixture.sh` | `src/server/testing/AcpRegistrySupport.uv.fixture.sh` (1-22, all) | verbatim |
| `src/registry/index.rs` | `AcpRegistrySupport.ts` (82, 320-367, 594-626, 693-705, 1478-1528); `registryIndexCache.ts` (17-40) | ported-to-Rust (this slice: v1 decode messages, enum distribution kind, byte-exact launch identity; settings moved to `settings.rs`) |
| `src/registry/cache.rs` | `AcpRegistrySupport.ts` (647-708); `registryResolveRefresh.ts` (12-52) | ported-to-Rust (this slice: v1 fetch messages; retry uses `RegistryError`) |
| `src/registry/local.rs` | `mcpTransport.ts` (3-26); `AcpRegistrySupport.ts` (1557-1567, 1715-1776, 1839-1857) | ported-to-Rust (local lookup now uses `command_path.rs`, including Windows PATHEXT) |
| `src/registry/mod.rs` | `packages/provider-acp-registry/src/server.ts` (module list) | adapted (module and public exports) |

Source paths without a package prefix are under `packages/provider-acp-registry/src/server/`.

