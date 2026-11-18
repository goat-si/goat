# Next3 K6 · runs, queue and persisted events

READY for integration review. Lane `chase/t3-261114-next3-k6` head `2e0d7809989c6982d48821f4f6ca838aef095a8a`. Integration parent `2c0e0002a996ec5d46c708919be5a43f579176fa`.

## C4 compatibility and verification plan

- d19467a59e — preserve full legacy `thread.visited` event decoding. Compact visits adjust only read state in SQL and reducers. New clients accept both event shapes. Preserve the old detail-stream decoder and live read state using a legacy wire projection while keeping compact stored rows. Check stale visits, legacy persisted replay and compact storage. The change needs no SQL migration.
- fd9b2c3eaa — cancellation linkage is an optional subagent property in an existing row and event. Older clients decode the status they already know. Newer clients accept legacy records lacking the linkage. Older servers keep prior cancellation semantics. Exercise background-only cancellation, an already-finished task, a newer unrelated child run, and refusal to stop a descendant.
- 240446e2d9 / d806251188 — the former is already present in 15523029d1. Restart notices use the existing system_notice turn item in both client/server directions. Skip unsent limit continuations and queued prompts. Verify no new work or duplicate notice on a second reconciliation. Retain GOAT restart continuation, unanswered human input, and background-work bookkeeping.
- 2e0bd97e86 — existing Force stop request and response literals and stored records. Both clients use the same endpoint and old servers keep their current behavior. Keep later active runs on the same session, preserve shared-thread isolation, and keep sessions when projection reads fail.
- d9c0920449 — V1 import normalizes timestamps when building existing V2 event shapes. Either client decodes the projected V2 rows. Older servers still need parseable V1 input. Negative fixtures keep malformed dates from aborting startup or unarchiving a marked thread.
- Provider-neutral orchestration for Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Pi, Muse Code, fx and ACP. Thread subscriptions share client runtime across web, desktop and mobile. Cancellation is exercised at MCP and the server orchestration boundary. Restart and force-stop tests exercise queue behavior and the provider-neutral session manager. No new mutation, setting, provider protocol, or destination-environment path. Run the changed test files whole from apps/server with the tmp guard, then the changed-files gate. P1 is the coordinator's real-client pass.

## Prior art

- Upstream d19467a59e stores a small read-state delta and preserves the old persisted event decoder. GOAT separates the SQL and memory reducers and already negotiates compact stream encodings. Older subscribers still receive the full event shape. [Upstream commit](https://github.com/pingdotgg/t3code/commit/d19467a59e)
- Upstream fd9b2c3eaa writes a cancellation marker in the same command as the child stop after descendants accept the stop. GOAT already has a parent-to-child lock order for delegated review continuation and a separate delivery policy. The port preserves both. [Upstream commit](https://github.com/pingdotgg/t3code/commit/fd9b2c3eaa)
- Upstream d806251188 emits a stable system-notice item for visible cancelled turns and omits queued or unsent auto-resumes. GOAT already extracts limit recovery into RecoveryUsageLimit.ts, so that module identifies the unsent runs for the notice. [Upstream commit](https://github.com/pingdotgg/t3code/commit/d806251188)
- Upstream 2e0bd97e86 serializes provider-session acquisition and conditional release, checking for a promoted run on the same session. GOAT also releases authority and provider resources in this path, so the guard must cover the whole existing release. [Upstream commit](https://github.com/pingdotgg/t3code/commit/2e0bd97e86)
- Upstream d9c0920449 uses the neighboring valid timestamp or import clock, while preserving non-null archive and deletion markers. The importer still stores canonical timestamps in the V2 output. [Upstream commit](https://github.com/pingdotgg/t3code/commit/d9c0920449)

## Decisions

**b20bbc595d — Steer during setup.** The choice is whether the explicit Steer action should follow a preparing or starting turn once it can accept input, stay unavailable until a provider turn is running, or queue a separate turn. Prefer a deferred steer for explicit user intent, after separately checking GOAT's cross-thread `steer_when_ready` delivery path. Persist the intended run on the queued record (`steerWhenReadyRunId` upstream), dedupe by target attempt, and validate the same steering permissions on delivery. A held or ended target must leave a recoverable queued message. The wire cost is one optional run field. Old clients can display an ordinary queued run, new clients on old servers retain existing behavior, and old stored rows have no deferred steer.

**beb528ce4d — Model selection for queued scheduled sends.** The choice is whether a bound schedule follows the thread's model at delivery or freezes the enqueue-time model. Prefer late binding for bound sends that omit an explicit model, with pinned selections and fresh launches keeping their requested model. GOAT's bound `sendBound` already omits a model, while the new-thread branch passes the schedule's selection. Follow the existing notification retargeting path, with model-, provider- and command-specific validation when the queue item starts or becomes a steer. The cost is one optional `followsThreadSelection: true` field on the message event and projection. Older clients can ignore it, older servers keep enqueue-time behavior, and already queued rows lacking the field keep their recorded selection.

## Rows and ownership

| Upstream | Verdict | GOAT commit |
| --- | --- | --- |
| d19467a59e | Adapted. Compact visits keep legacy storage replay and a legacy wire path. | aca6f7002bae0b0b6305eccfce32dd87b262e479 |
| fd9b2c3eaa | Adapted. Background-only local task cancellation commits the linked run with Stop. GOAT keeps its existing active, cloud, remote and promoted-task paths. | 3b8d8f089bd587dd3c075ccdfc6337d77058c2cc |
| 240446e2d9 | Already present. GOAT re-arms the matching unsent limit continuation and hides the cancelled copy in `RecoveryUsageLimit.ts`. | 15523029d1 |
| d806251188 | Adapted. Stable timeline notice for a cancelled turn, with GOAT's queue and limit-recovery exclusions. | 555da5989f3b11cbd8fd22e74267da570013b66f |
| 2e0bd97e86 | Already present. GOAT binds teardown to the target under the thread lock in `ForceStopTeardown.ts` and atomically protects a newer busy turn in `ProviderSessionManager.ts`. The newer-run outcome stays `shared` with no sibling IDs, as tested in `ForceStopTeardown.test.ts`. | Present at f82d2df4b0960eb39bd36e4100b72b6f2758c7d2 (file history rooted at b59034d2b3) |
| d9c0920449 | Adapted. Normalize malformed stored V1 timestamps and retain archive state. The pre-existing fault-isolation test now injects a genuine transcript-read defect and keeps its assertions. | 93335e3479179b136a414021d4f37e56645d88da |
| b20bbc595d | Decision above | — |
| beb528ce4d | Decision above | — |

Review range `f82d2df4b0960eb39bd36e4100b72b6f2758c7d2..3b8d8f089bd587dd3c075ccdfc6337d77058c2cc` is adapted or GOAT-authored. The two move-first commits are `6c58f86c07` and `92ee990404`. No clean upstream cherry-picks. The integration merge used Git's ort strategy and changed no lockfile.

The retained integration test for fd9b2c3eaa originally expected the parent task to be completed. The row changes the parent assertion to interrupted and separately verifies that the child's provider turn remains completed. Tests for d19467a59e retain the previous compaction expectation for stored legacy visits, with separate assertions for the new event shape.

The implementation is in `apps/server/src/orchestration-v2/`. See `ThreadVisit.ts:13`, `ThreadVisitWire.ts:11`, `goat/DelegatedTaskCancellation.ts:43`, `RecoveryUsageLimit.ts:23`, `ProviderRuntimeRecoveryService.ts:528`, `ForceStopTeardown.ts:70`, `ProviderSessionManager.ts:2794`, and `legacy/LegacyV1ThreadImporter.ts:190`.

## Newer upstream overlaps

The following are the exact SHAs from `git log --oneline 93cbca3fcbd..8a6342e7613 -- <union of the eight row paths>` (exit 0). This includes broad shared-file overlap and decision-row web files. Recovery/session follow-ups include `34204a39e8`, `a68c367e4f`, `51cdf23265` and `4b99420d8e`. Delegation and queue follow-ups include `11c425b4b6`, `25fada9351`, `0df1967cfa`, `b79d277cdd`, `5da89cfceb`, `3209fa9534` and `7a72fe301c`. K6 ports only the assigned older rows.

`01cfac429d` `055b44919e` `1c818a8083` `2ebe7f8e22` `81fd06998c` `de7b5e05f6` `0597532f16` `25fada9351` `33542a53be` `6ef2c05410` `135d7a9801` `980f5d4128`
`2904c397ad` `0df1967cfa` `0597b9edcd` `c71f98cadf` `ccae953c46` `1adc05b844` `b79d277cdd` `c24255826b` `750e492ed6` `e05b087a34` `6e650b3849` `02f8a3280b`
`c02b98bb3f` `caef8c3847` `629d5083b7` `1b84e72a6d` `ad1b136599` `5da89cfceb` `e367ef0da1` `06150a08ec` `19b33eca4c` `51cdf23265` `03e05f6235` `21fe33c8d7`
`9c1dfbb5aa` `6d3f6423a3` `6071022cb7` `cb251b9abc` `8897a6ebe1` `7d9c365e17` `4f829644f6` `570640b160` `f36c8351d8` `2f30d98fab` `4fa5f0e0e6` `62d33c126a`
`b1050d3449` `4117bd42ec` `ab319a52dd` `11c425b4b6` `e2afd2546e` `34204a39e8` `d2a894a247` `3209fa9534` `12042ffb29` `d5726cb88c` `2e9418af79` `467ec62e08`
`85168744f7` `fa6ecb125b` `35b88636d4` `7a72fe301c` `e49d058439` `8be0e6c8eb` `2c5013d153` `a62bc8156d` `4dec8cf641` `3c8f3f2c3d` `f5ca0f9427` `3e17618212`
`a68c367e4f` `dfd2187ccb` `35e65e6446` `2dd810d0f6` `cbdf35f2f0` `5393882fb8` `6fae3c9303` `0035cb55bb` `e5c636219c` `74178f4712` `4d47d0b76e` `a767d23297`
`01c84c7c02` `8cbaf75055` `ec01233fb6` `2e33134186` `1f45f14ae8` `a4bf7922f5` `997b304dd6` `cc578d5f9a` `4954322f02` `719042d942` `629242b8d3` `2b596b8690`
`77ad2ebec5` `0a8aaa3ccb` `c5f842d4c7` `298c38d7f2` `4b99420d8e` `43ba62b9fc` `953ce60d12` `9e19b7f7e1` `3b18dc2935` `2f2730c113` `b2259d3c6c` `a8777e4c7a`
`33372a25a2` `ac180919a6` `a81ec88f58` `9d6da455e2` `e1f5b68281` `a4723422e7` `eea9d15ee2` `dea07a1b12` `2a468acfed` `2d80cb6bc7` `3c1be119b9` `b537916099`
`aaa3dbabb1` `931cd3afab`

## Verification

- Before the port, `vp test run src/orchestration-v2/runtimeLayer.test.ts` from apps/server with the tmp guard exited 1 on the full `thread.visited` event (175 passed, 1 failed). The combined server red run exited 1 and reproduced completed instead of interrupted for cancellation, omitted notices for startup and shutdown, and `Invalid date` on persisted V1 rows. The final green run covers all four.
- Seven changed server test files and seven other focused suites ran whole from `apps/server` under Node 26.12.1 on lane head `2e0d7809989c6982d48821f4f6ca838aef095a8a`. `GOAT_TEST_TMP_GUARD=fail vp test run --maxWorkers=4 <files below>` exited 0 with 532 passed across 14 files and zero failures or skips.
  - `integration/transferBudgetV2.integration.test.ts` — 1 passed
  - `src/mcp/OrchestratorMcpService.test.ts` — 103 passed
  - `src/mcp/TaskCancelNativeSubagent.integration.test.ts` — 1 passed
  - `src/orchestration-v2/DelegatedCompletionDelivery.test.ts` — 27 passed
  - `src/orchestration-v2/ForceStopTeardown.test.ts` — 7 passed
  - `src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts` — 25 passed
  - `src/orchestration-v2/ProviderRuntimeRecoveryStreaming.test.ts` — 1 passed
  - `src/orchestration-v2/ProviderSessionManager.test.ts` — 117 passed
  - `src/orchestration-v2/ThreadStop.test.ts` — 43 passed
  - `src/orchestration-v2/legacy/LegacyV1ThreadImporter.test.ts` — 6 passed
  - `src/orchestration-v2/runtimeLayer.dataPlane.test.ts` — 1 passed
  - `src/orchestration-v2/runtimeLayer.test.ts` — 175 passed
  - `src/relay/AgentAwarenessRelay.test.ts` — 23 passed
  - `src/ws.liveProjection.test.ts` — 2 passed
- The package gate `vp run check:changed origin/chase/t3-261114-next3` automatically selected web browser tests and was interrupted. The final run used its unchanged `node scripts/check-changed.ts origin/chase/t3-261114-next3` command under Node 26.12.1, with only the five selected web browser files excluded via the Vitest project and file selectors for pen-lidge. Exit 1. Formatting, lint, Knip, GraphQL, agent-surface audit, context budget, and all 38 typechecks passed. Vitest ran 556 files with 6,928 passed, one failed, and three suite skips. The sole failure is the integration baseline mismatch below.
- Baseline check on integration `2c0e0002a996ec5d46c708919be5a43f579176fa` from `apps/server` ran `GOAT_TEST_TMP_GUARD=fail vp test run --maxWorkers=1 src/storageCleanupShipping.test.ts src/orchestration-v2/ProviderRuntimeRecoveryStreaming.test.ts`. Exit 1, 11 passed and 1 failed. At `storageCleanupShipping.test.ts:211` Git 2.43.0 reports “Default branch is unavailable” where the test expects “Couldn't refresh origin/main.” Both worktrees are kept on integration and on the lane. The recovery streaming test kept its previous event sequence assertions and now checks the new notice before session teardown.
- `git diff --check origin/chase/t3-261114-next3` and `git diff --exit-code HEAD^1 HEAD -- pnpm-lock.yaml` exited 0. No dependency install after the merge.
- Stored legacy full visits rebuild on the new version. The current client subscribes to older servers using the unchanged request shape plus an optional field. The compatibility tests exercise both wire representations on the current server. Rebuilding a database with the new compact event using an older server binary was outside this lane.

## P1

- d19467a59e — open and revisit a thread from web, desktop, or mobile. Read state advances while the activity timestamp stays fixed.
- fd9b2c3eaa — cancel a delegated child after its provider turn ends with background work still running. The task card and task read show interrupted, and the parent receives no completion wake.
- d806251188 / 240446e2d9 — restart with a visible interrupted run and queued work. The transcript gives the restart reason for the cancelled run, and an unsent usage-limit continuation can be re-armed without a duplicate prompt.
- 2e0bd97e86 — Force stop a run with queued work that takes over its session during teardown. The follow-up retains the session.

## NOT RUN

NOT RUN: The five web browser files auto-selected by check:changed. The server-host run excluded them. P1 real web, desktop, and mobile client passes and captures belong to the coordinator.

NOT RUN: Separate older client or server binaries and a downgrade rebuild after compact events were written. Persisted legacy rows and both negotiated wire representations were exercised by fixtures.

NOT RUN: Lane CI, full CI suites, build, and release smoke. CI stays on integration PR #3700.


## Fix round 1 and the two ruled ports

Lane `chase/t3-261114-next3-k6` advanced from `2e0d7809989c6982d48821f4f6ca838aef095a8a` to `105adb36a661916cbc16c290ad0265be34548f5c` on Node 26.12.1. The integration base for the gate was `2c0e0002a996ec5d46c708919be5a43f579176fa`.

| Finding or upstream row | Lane commit | Failing-first evidence |
| --- | --- | --- |
| P2-1 | `6019dd07a3dc20d2dd1b921473fe0ccda9b570f7` | The continued review's untagged completion wake left a native subagent. The focused test returned `completed` where it expected `interrupted`. The marker and settlement now use that exact wake and dispose the parent delivery. The moved suite retains its explicit continuation-request layer. |
| P2-2 | `fe4941cfcc74f730996bfd56f035ab77611721e7` | The legacy stream emitted a seq-2 `thread.visited` containing seq-3 archive state. The test now expects a snapshot stamped seq 3, then the seq-4 unarchive on the same stream. A compact client receives the visit, archive and unarchive in order. A second red test returned an empty reply body after the snapshot evicted its source message. The deduper now resets its remembered bodies on a replacement snapshot. |
| P3 | `f142c3681143e0abeac9560ff1bf160047f40188` | A temporary local mutation wrote two events for the same restart notice and enabled notices for unsent usage-limit continuations. The new assertions failed with 2 persisted events instead of 1 and 2 instead of 0. After restoring production code, the two whole suites passed 181 tests. |
| `b20bbc595d` | `1a167449d1156114478e3c16d9ea7a73e957ee08` | 4/4 focused server cases failed before the port because direct and promoted steers rejected preparing/starting targets. The final tests cover both delivery paths, duplicate readiness events, a replaced attempt, an ended target, delivery-time refusal of a restart-only selection, and explicit recovery from the queue. |
| `beb528ce4d` | `105adb36a661916cbc16c290ad0265be34548f5c` | 3/5 focused server cases failed before the port. Bound continue and fresh-session sends used the enqueue-time model, and promotion lacked the late-binding marker. Pinned and legacy queued selections passed before and after. |

### Compatibility and surfaces

- `b20bbc595d` uses one optional persisted and wire run field, `steerWhenReadyAttemptId`. GOAT captures the attempt because a restart may reuse the run ID. Old queue rows lack the field. Old clients can decode and display the ordinary queued run. Older servers retain their existing processing of Steer. Automatic promotion uses a receipt keyed by the queued run and target attempt, runs the existing steering checks, and leaves a held queue entry when the attempt cannot receive it. The cross-thread MCP `steer_when_ready` waiting/retry path in `ThreadManagementService.ts` stays independent. Web and desktop use the composer planner, buttons, and keybindings. The shared queue workflow also serves mobile. Providers use the existing native steering or interrupt/restart capabilities. Resume or Send now can deliver a held queued message.
- `beb528ce4d` uses one optional `followsThreadSelection: true` field on the conversation message schema, which serves the stored `message.updated` event and projection. Absent means the queued selection is retained. A bound scheduled send that omits a model resolves the thread selection at delivery, including when it makes a fresh provider session in that same thread. Explicit model selections and new-thread launches retain their requested model. The queue start and promotion paths recheck the destination provider and goal command. This uses the existing schedule service, queue commands, and provider policy for all clients.
- The public user workflows keep the existing Steer, queue and schedule controls. The compatibility changes need no SQL migration. The coordinator owns independent review and real-client verification on PR #3700.

Limits: An older server's strict projection rebuild cannot decode compact `thread.visit-recorded` events written by this version.

### P2-3 Rule 3 rulings

The coordinator approved the retained cancellation expectation under IV, consistent with upstream `fd9b2c3eaa:635`. The provider run stays completed while the delegated task is interrupted.

Before `3b8d8f089b`

```ts
        const after = yield* service.taskStatus(scope, task.id);
        assert.equal(after.status, "completed");
        assert.notEqual(after.workState, "waiting_for_children");
```

After `3b8d8f089b`

```ts
        const after = yield* service.taskStatus(scope, task.id);
        assert.equal(
          childAfter.runs.find((run) => run.id === child.turn.runId)?.status,
          "completed",
        );
        assert.equal(after.status, "interrupted");
        const parentAfter = yield* orchestrator.getThreadProjection(parentThreadId);
        const endedTask = parentAfter.subagents.find((entry) => entry.id === task.id);
        assert.equal(endedTask?.status, "interrupted");
        assert.equal(endedTask?.completionDelivery?.state, "disposed");
        assert.notEqual(after.workState, "waiting_for_children");
```

Upstream `fd9b2c3eaa`

```ts
        const after = yield* service.taskStatus(scope, task.id);
        assert.equal(after.status, "interrupted");
        assert.equal(after.workState, "result_available");
        const settledTask = yield* parentTask;
        assert.equal(settledTask?.status, "interrupted");
        assert.notEqual(settledTask?.completedAt, null);
        assert.equal(settledTask?.cancelledRunId, child.turn.runId);
```

The coordinator approved the harness extraction in `6c58f86c07` under IV (vi). The declaration below is byte-identical after removing the new `export` keyword. SHA-256 of the shared declaration is `b455bf4596d60fbe5c43aa927f016cec32f06fd20d66ccc7301c29ba6402ecd5`.

Before in `runtimeLayer.test.ts`

```ts
const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      awaitRepositoryIdentity: () => Effect.succeed(null),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);
```

After in `runtimeLayer.testkit.ts`

```ts
export const layerSharedApplicationDataPlaneTest = Layer.mergeAll(
  RuntimeLayer.layer.pipe(Layer.provide(RuntimeLayer.layerProjectService)),
  RuntimeLayer.layerProjectService,
  RuntimeLayer.layerEventSink,
  RuntimeLayer.layerEventInfrastructure,
).pipe(
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      awaitRepositoryIdentity: () => Effect.succeed(null),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerPlatformTest),
);
```

### Round 1 verification

- With Node 26.12.1, `GOAT_TEST_TMP_GUARD=fail vp test run --maxWorkers=4` ran all 13 changed server test files whole from `apps/server`. Exit 0 with 265 passed, zero failed and zero skipped.
  - `integration/transferBudgetV2.integration.test.ts` — 1 passed
  - `src/mcp/TaskCancelNativeSubagent.integration.test.ts` — 1 passed
  - `src/orchestration-v2/DeferredSteering.integration.test.ts` — 5 passed
  - `src/orchestration-v2/DelegatedCompletionDelivery.test.ts` — 25 passed
  - `src/orchestration-v2/DelegatedReviewCompletion.test.ts` — 3 passed
  - `src/orchestration-v2/ProviderRuntimeRecoveryStreaming.test.ts` — 1 passed
  - `src/orchestration-v2/ScheduledQueuedSelection.integration.test.ts` — 5 passed
  - `src/orchestration-v2/UsageLimitRestart.test.ts` — 6 passed
  - `src/orchestration-v2/WireProjection.test.ts` — 34 passed
  - `src/orchestration-v2/legacy/LegacyV1ThreadImporter.test.ts` — 6 passed
  - `src/orchestration-v2/runtimeLayer.dataPlane.test.ts` — 1 passed
  - `src/orchestration-v2/runtimeLayer.test.ts` — 175 passed
  - `src/ws.liveProjection.test.ts` — 2 passed
- `git diff --check origin/chase/t3-261114-next3` and `git diff --exit-code 2e0d780998 HEAD -- pnpm-lock.yaml` both exited 0.
- `GOAT_TEST_TMP_GUARD=fail vp test run --maxWorkers=1 src/storageCleanupShipping.test.ts` on the lane head exited 1 with 10 passed and one failed at line 211. With pen-lidge Git 2.43.0, the fixture returns “Default branch is unavailable” where it expects “Couldn't refresh origin/main.” The identical mismatch was previously run on the integration base in this record.
- `node scripts/check-changed.ts origin/chase/t3-261114-next3` exited 1 on Node 26.12.1. The gate passed format, lint, both Knip passes, GraphQL generation, agent surface audit, agent context budget and all 38 package typechecks. Vitest ran 573 files, with 572 passed and one failed. It reported 9,186 passed tests, three skipped and one failed. The only failure was the confirmed Git 2.43.0 host mismatch at `src/storageCleanupShipping.test.ts:211`. The gate advertised 594 selectors before the 21 web browser exclusions below.

### Round 1 NOT RUN

NOT RUN: The 21 auto-selected web browser files below. The existing server-host wrapper excluded the browser and render projects and the browser file selectors. Real web, desktop and mobile passes are coordinator work.

- `apps/web/src/components/ChatView.logic.browser.test.ts`
- `apps/web/src/components/ChatView.browser.test.tsx`
- `apps/web/src/components/ChatView.fork.browser.test.tsx`
- `apps/web/src/components/ChatView.forkLegacyServer.browser.test.tsx`
- `apps/web/src/components/ChatView.handoffCompaction.browser.test.tsx`
- `apps/web/src/components/ChatView.modelPick.browser.test.tsx`
- `apps/web/src/components/ChatView.ssh.browser.test.tsx`
- `apps/web/src/components/ChatView.terminalFocus.browser.test.tsx`
- `apps/web/src/components/chat/ChatComposer.previewTabMention.browser.test.tsx`
- `apps/web/src/components/chat/ChatComposer.ssh.browser.test.tsx`
- `apps/web/src/components/chat/ChatComposer.terminalAnswer.browser.test.tsx`
- `apps/web/src/components/ThreadRouteView.browser.test.tsx`
- `apps/web/src/hooks/useRightPanelSurfaceClose.browser.test.tsx`
- `apps/web/src/components/Sidebar.drag.browser.test.tsx`
- `apps/web/src/components/Sidebar.shortcuts.browser.test.tsx`
- `apps/web/src/components/Sidebar.shortcuts.noBrowser.browser.test.tsx`
- `apps/web/src/components/ThreadRouteView.forkFamily.browser.test.tsx`
- `apps/web/src/components/chat/QueuedRunsControl.browser.test.tsx`
- `apps/web/src/components/chat/useQueuedRunEdit.browser.test.tsx`
- `apps/web/src/components/goatBot/GoatBotChatView.sync.browser.test.tsx`
- `apps/web/src/components/sidebar/useBotThreadKeys.browser.test.tsx`

NOT RUN: Separate older client/server binaries and a downgrade rebuild. Local checks used legacy fixtures and both wire paths.

NOT RUN: Lane CI, full CI, build and release smoke. CI stays on integration PR #3700.
