# Lane L2_ssh (gpt-6.1-sol, read-only, 2026-10-12, base 32f7bda9b)

Read-only discovery completed; no files changed. Anchors reflect the current shared checkout.

**1. Archive supply and replacement**

- Supply order is compatible live/retained runtime → remotely installed requested version → bundle → local cache → explicit remote mirror → local `gh`: `packages/ssh/src/tunnel.ts:1794`, `:1820`, `:1839`, `:1845`, `:1851`, `:1867`. The acquisition expression is `"bundledArchive ?? localArchive ?? …downloadRuntimeArchiveWithGh"`.
- Insert public HTTPS acquisition at `tunnel.ts:1867`, after bundle/cache and before optional `gh` fallback. Preserve explicit mirror handling at `:1851`. Use `https://github.com/goat-si/goat-releases/releases/download/v${version}/${asset}` and the same directory’s `SHA256SUMS`.
- Required return interface is `{ fileName, bytes: Uint8Array, sha256: string }`, established by `packages/ssh/src/runtimeArchive.ts:72`; upload consumes `archive.sha256` and `archive.bytes` at `tunnel.ts:1882`, `:1888`. Match gh’s cache transaction: lock/recheck cache, scoped staging, checksum validation, canonical sidecar, sidecar-first publication (`packages/ssh/src/runtimeArchiveGh.ts:57`, `:122`, `:139`, `:145`). Missing checksum or mismatch must fail before SSH upload. Existing cache permits trusted user archives without sidecars (`runtimeArchive.ts:71`).

| Replacement path               | Current activity handling and outcome                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Older compatible owned runtime | `tunnel.ts:1776` requires first-connect refresh and `compareSemverVersions(...) < 0`. `:779` maps idle→pending, busy→`reused-busy`, other→`reused-unknown`. `:1187` rechecks immediately before replacement; busy/unknown reuses the live runtime.                                                                                                                                                      |
| Legacy takeover                | `:748` and `:758` mark verified legacy ownership `"NEEDS_OWNED_UPGRADE=1"` and return before the activity branch. `:972` checks UID, process start time and exact command; `:992` checks retained runner/state. These prove ownership, **not idleness**. `:1197` commits identity; `:1214` terminates without an activity check. This is structural legacy detection, not restricted to version 0.0.45. |
| Owned incompatible runtime     | `:784`–`:787` mark replacement when owning upgrades are allowed. Activity is checked only if `REFRESH_IF_IDLE=1` at `:1187`; ordinary incompatible replacement therefore has no busy/unknown veto. External/ineligible runtimes remain running and produce an error at `:789`.                                                                                                                          |
| Unknown live identity          | `:764`–`:771` fail conservatively: `"It was left running"`, preserving runner/state. Verified legacy adoption is the exception above.                                                                                                                                                                                                                                                                   |
| First-connect restriction      | `:2893` disables refresh once the key enters `firstConnectionDecisions`; `:2919` consumes the decision after successful ensure, including busy/unknown reuse. `:1996` also disables refresh in the cached selection. No pending retry exists.                                                                                                                                                           |
| Local synchronization          | `:2519`–`:2527` use `KeyedLock`, covering only this manager process. Existing remote atomic mkdir at `:610` protects **archive installation**, not runtime replacement.                                                                                                                                                                                                                                 |

Activity is reported through the loopback endpoint (`apps/server/src/http.ts:325`). `apps/server/src/cli/sshHelper.ts:390` validates HTTP 200, activity, version, PID and optional expected PID; invalid responses, missing endpoint, transport failure, oversized response or 1.5-second deadline yield `unknown` (`:411`, `:421`, `:437`). Shell helper failure also yields unknown (`tunnel.ts:1051`).

Busy means active queued/preparing/starting/running/waiting runs, pending/running/waiting nodes/subagents/tool items, pending/running provider turns, background work, or pending runtime requests (`apps/server/src/orchestration-v2/ProjectionStore.ts:5951`). Held queues and rolled-back work have exclusions.

**Recommended replacement changes:**

- `tunnel.ts:748`, `:773`, `:784`, `:1187`: apply one idle-only policy to every replacement reason, retaining existing ownership checks. Busy/unknown preserves process, runner and ownership files. Compatible runtimes can remain connected; incompatible runtimes need a structured pending/error result rather than passing `reuse_live_server`’s compatibility requirement (`:1159`).
- `:315`, `:1930`, `:1985`, `:2683`, `:2518`, `:2893`, `:2919`: carry a pending target/reason through launch and manager state; `createTunnelEntry` currently does not retain `remoteLaunch.refresh`. Consume the first-connect decision only when replacement finishes or no replacement is needed. Retry pending work on reconnect and a scoped interval; an idle-transition hook is optional additional integration.
- `:855`, `:1116`, `:1195`, `:1320`: add an atomic `mkdir "$STATE_DIR/replacement.lock"` around shared runner/identity publication and stop/start; compose cleanup with existing traps. After acquisition, re-probe identity/activity. Serialize explicit stop against replacement too. Track owner identity and use bounded contention handling.
- Lock-key judgment: `packages/ssh/src/command.ts:71` includes alias in the key; `:76` hashes it into the state directory. Different aliases can reach the same remote home, so a per-target directory lock alone does not guarantee host-wide serialization.

**Downgrades:** older-only refresh already refuses replacing equal/newer compatible runtimes (`tunnel.ts:1784`; proof: `tunnel.protocol-refresh.test.ts:18`, `"startup reuses an equal/newer release"`). There is **no blanket newer-runtime downgrade refusal** in legacy/incompatible replacement. CLI update separately refuses downgrades unless explicitly allowed (`apps/server/src/cli/update.ts:434`).

**2. Protocol constants and literals**

Definitions: `packages/shared/src/sshRuntimeProtocol.ts:2` exports SSH `1`; `packages/contracts/src/environment.ts:13`–`:14` export orchestration `2`/`"2"`.

Production consumers already use constants:

- SSH matching/shell substitution: `packages/ssh/src/tunnel.ts:140`, `:1459`.
- Server descriptor, persisted runtime and helper identity: `apps/server/src/environment/ServerEnvironment.ts:218`, `apps/server/src/serverRuntimeState.ts:70`, `apps/server/src/cli/sshHelper.ts:134`.
- WebSocket negotiation: `apps/server/src/ws.ts:606`, `:3147`.
- HTTP schema/auth: `packages/contracts/src/environmentHttp.ts:83`, `packages/client-runtime/src/state/environmentHttpAuth.ts:31`, `:35`.
- Client compatibility/socket URL and update compatibility: `packages/client-runtime/src/connection/compatibility.ts:14`, `:40`, `outdatedHostUpdate.ts:209`.
- Verification script: `apps/server/scripts/verify-background-live.ts:275`, `:299`.

**The cited HTTP schema is already fixed:** `environmentHttp.ts:83` reads `Schema.Literal(ORCHESTRATION_PROTOCOL_VERSION_TEXT)`.

Transitive compatibility consumers: client resolver `resolver.ts:310`, onboarding `onboarding.ts:126`, descriptor changes `layer.ts:60`; web cloud list `apps/web/src/components/cloud/CloudEnvironmentConnectList.tsx:46`; mobile cloud presentation `apps/mobile/src/features/cloud/cloudEnvironmentPresentation.ts:24`.

**Replace current-protocol literals with constants** at these anchors, all under `packages/ssh/src/`:

- `tunnel.core.test.ts:1065`, `:2346`.
- `tunnel.protocol.fixture.ts:274`.
- `tunnel.runnerSwitch.fixture.ts:75`, `:113`, `:315`.
- `tunnel.protocol-compat.test.ts:23`, `:57`, `:87`, `:98`.
- `tunnel.protocol-identity.test.ts:36`, `:43`, `:50`, `:171`, `:204`, `:213`.
- `tunnel.protocol-replacement.test.ts:78`, `:197`, `:241`, `:284`, `:300`.
- `tunnel.protocol-acquisition.test.ts:23`, `:50`, `:59`, `:101`, `:116`, `:150`, `:169`, `:200`.
- `tunnel.protocol-manager.test.ts:33`, `:102`; `tunnel.protocol-legacy.test.ts:130`.
- `tunnel.protocol-stop.test.ts:37`, `:208`, `:296`, `:306`.
- `tunnel.protocol-refresh.test.ts:24`, `:46`, `:72`.

Also replace `"orchestrationProtocol=2"` in `packages/client-runtime/src/connection/resolver.test.ts:243`, `:281`.

**Keep intentional legacy/mismatch literals:** absent-version fallback `1` in `compatibility.ts:13`, `layer.ts:57`, `outdatedHostUpdate.ts:209`; schema integer example `packages/contracts/src/environment.test.ts:20`; malformed `"1"`/fraction/negative/unsafe values in `apps/server/src/cli/sshHelper.test.ts:91`, `:160`; incompatible `99`/`9` SSH fixture cases, including `tunnel.protocol-stop.test.ts:109`.

Constant-based tests already cover server environment/runtime/helper, client compatibility/resolver/registry/onboarding/outdated updates/HTTP auth, web/mobile cloud presentation, WS negotiation, `transferBudgetV2.integration.test.ts:251`, and `boundedSnapshotTransport.test.ts:254`.

Name/literal searches also find unrelated ACP `protocolVersion: 1/2`, MCP date versions, CDP `"1.3"` and activation protocol `1`; these must retain their own protocol semantics.

**3. Release fetch/cache/retry**

- `packages/shared/src/cliRelease.ts:8` still targets `"goat-si/goat"`; `:57` derives downloads and `:101` derives release listing. Change it to `goat-si/goat-releases`; this affects gh acquisition too (`runtimeArchiveGh.ts:79`).
- CLI listing (`apps/server/src/cli/update.ts:58`) walks up to ten 100-item pages with 30-second request deadlines, filtering by channel. No listing cache or retry exists. Add channel/repository-keyed bounded caching and transient-error retry here.
- CLI asset acquisition delegates at `update.ts:480` to `apps/server/src/cloud/pinnedRuntime.ts`: HTTPS checksums/archive at `:200`, `:215`, SHA256 validation `:222`, installed-runtime cache `:282`, process-local install semaphore `:380`. Add asset retries in `fetchReleaseAsset` (`:131`); shared verified archive caching would touch this installer and the new SSH supplier.
- The cited dispatch lines have moved: `SshRemoteDispatch.ts:763` concerns session rejection. Actual runner configuration is `:790`–`:811`: local cache defaults to `<baseDir>/runtime/archives`, bundled directory/mirror are optional, and `"keepExistingRunner: true"`. It does not fetch releases itself.

Unresolved judgments: old runtimes lacking the activity endpoint remain permanently unknown under idle-only policy; automatic takeover cannot safely infer idle. Atomic mkdir serializes replacers but does not prevent new work starting between activity check and kill—strict idle guarantees require server-side admission/drain coordination. Parent should decide that scope, host-wide lock identity, retry lifetime, and whether gh remains a fallback.
