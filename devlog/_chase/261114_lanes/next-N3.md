# N3: Effect 4.1 and the non-blocking spawner

Lane N3 of the next catch-up PR (goat-si/goat#3519), cycle 261114. Branch chase/t3-261114-n3-effect-41 on pen-mac-studio, worked by Opus (claude-opus-5-5) through the Codex harness. Owner ruling O26 A. Class C4 (dependency move).

The lane moves GOAT from Effect 4.0.5 to 4.1.3 and alchemy from 2.0.0-beta.80 to beta.85, and ports four upstream rows that need 4.1. Its prerequisite is upstream 57cd05904d (Effect 4.1.2, alchemy beta.85), which carries the infra hunks of bc1ea26cc0. The rows are L458 aa58dc6d22 (Effect 4.1.3), L136 0f5ecef914 (an unloadable GOAT home prints its refusal), L236 e9eb473d52 (Storage Cleanup uses one lstat per entry) and L239 65e4272db1 (the non-blocking spawner). Under 4.1 the gate, the fork audit and the catch-semantics audit found seven regressions in GOAT. They are fixed test-first in six commits, described under "Regressions found and fixed under 4.1" and "Catch semantics in Effect 4.1.3 (coordinator item 6a)".

Integration head contained: 5c798a3072eab155e0ae222dda3dcd33641c0bcc, merged in 65a69a24cb, plus origin/dev 1d41f2c97f, merged in 89d6b2d024. Local head when this draft was written: 9ac4aa0688. Final pushed head: 9ac4aa0688af8fb5c801ef5a8481f282422f35ee (verified on origin with git ls-remote).

## Rows ported

These are the 37 first-parent commits from git log --first-parent origin/dev..HEAD at local head 9ac4aa0688, in branch order within each group. The final pushed head is 9ac4aa0688af8fb5c801ef5a8481f282422f35ee.

### Move-outs (verbatim, before the code that needed the room)

| sha | subject | note |
|---|---|---|
| c412c55e14478114324f2571738da6abcef69066 | refactor(server): move four blocks out of files at their code budget |  |
| 363fc594f1ff127923e275cb3fe00ed2e9a27281 | refactor(ssh): move three blocks out of files at their code budget |  |
| dfedb6d383eac24ae95969cb90f99aa609e0197f | refactor(provider-acp-registry): move two blocks out of files at their code budget |  |
| 7d3c8669622c5f9b7932435f624544a57c5b09c9 | refactor(shared): move readSafeSqliteInteger out of nodeSqliteClient.ts |  |
| 368cf328d3b419d5766abdabd851cb88d167b0cc | refactor(provider-core): move two maintenanceResolver test helpers into a testkit |  |
| 6b918262407d367a44b116d3752c9da556c57190 | refactor(relay): move linkedEnvironmentRecord into Api.testkit.ts |  |
| 2c5a96945c1b46255f03da9f748ee72929343679 | refactor(server): move layerProviderEventLoggers out of server.ts |  |
| 284485011523aca9eb57442ba1893ae38a8acd68 | refactor(shared): move classifyError out of nodeSqliteClient.ts |  |
| 1dbdd044c327226f541e3ad60255d983cd6f1400 | refactor(server): move two test helpers out of files the next merge leaves at budget |  |
| 4a4e988fdb1f2612c5043544665d44d7043b9e17 | refactor(provider-acp): move the two subagent status predicates out of the ACP adapter |  |

### Port rows

| sha | subject | note |
|---|---|---|
| 0793dd3a0c35bf678a31992597848725aa5e4aeb | chore(deps): upgrade Effect to 4.1.2 and alchemy to beta.85 (port of upstream 57cd05904d) | 57cd05904d, with bc1ea26cc0's infra hunks; the message names both |
| 43bf05f914b5d6021c48b19865a848118ad097d1 | chore(deps): upgrade Effect to 4.1.3 (port of upstream aa58dc6d22) | aa58dc6d22 (L458) |
| 96797a9779d5d92c626cf78f00aaf51763ded2c0 | fix(server): an unloadable GOAT home prints its refusal, not a stack trace (port of upstream 0f5ecef914) | 0f5ecef914 (L136) |
| 5847e6f5a7d46f222fdb876fd79f2189a9972a4f | perf(server): Storage Cleanup probes each entry with one lstat (port of upstream e9eb473d52) | e9eb473d52 (L236) |
| 98b3c41bc49376ec92424b54aa27095c40620c22 | fix(server): a hung network mount no longer freezes the server when it spawns a process (port of upstream 65e4272db1) | 65e4272db1 (L239) |
| f7d7009622693b4c44d2bd1becddb4e702ebf62f | refactor(server): drop McpHttpServer.layer, which nothing uses after the port | follow-up to the port (knip) |

### Fixes found under 4.1

| sha | subject | note |
|---|---|---|
| f8eeb86c21509cd54c76be1159fb66b476ad115f | fix(server): in-process MCP calls no longer die when the caller leaves out a service the tool never reads | gate 5 |
| 373b22790bf63322ff236c4ba4513d7f6034618a | fix(server): MCP tool handlers run with the services the server built them with, over the caller's | gate 5 |
| 0728a1e058778dd40d10455bc5ca1c97943b5bb8 | fix(provider-core): a Codex request after its session closed fails with the client's error again | gate 5 |
| ffbce8a8fad4ac94c03cbdb137cfaa3af45644a9 | fix(server): ACP Stop and Codex survivor adoption still settle after their session scope closed | fork audit |
| f6d1b1589872e61c3131964d68599fbd955a1e6d | fix(shared): a write SQLite already rolled back fails with its SqlError again | catch audit |
| 9ac4aa0688af8fb5c801ef5a8481f282422f35ee | fix(server): a failed Claude query open keeps its typed error when disposal also fails | catch audit |

### Test-harness commits (rule 3, authorised)

| sha | subject | note |
|---|---|---|
| 5c1ab6fa2fef39be194ab7d2151706d7f0723319 | test(server): the hung-receipt test waits for the last receipt's record instead of counting scheduler turns |  |
| bf113e026a325e074a17a19d995479f87811e22e | test(server): the unlinked-guest test finds the guest's input by who sent it, not by position |  |

### Merges

| sha | subject | note |
|---|---|---|
| 3a176989e16c22f9691fdd374554cacfe42befa8 | Merge origin/chase/t3-261114-next (e7b14604c2) into lane N3 |  |
| 634ca5728d3a8f722197696743bb10e3a172e65f | Merge origin/chase/t3-261114-next (a7992962cd) into lane N3 |  |
| e874072087f95ebb69347f99beb6be4dc9133705 | Merge origin/dev (3ed0b802b6) into lane N3 |  |
| cf7a23a5638f62bb091afb48099c38f81c1f06c9 | Merge origin/chase/t3-261114-next (0f43887b43) into lane N3 |  |
| b0d48dd78afe3f8411634452513050fa01486b8f | Merge origin/chase/t3-261114-next (b2fb30748a) into lane N3 |  |
| 889902b71c277952022b5229dd45947c4b92e572 | Merge origin/dev (97c0dd32c4) into lane N3 |  |
| 741aebdd36a379bb30bb5965ca92983e167ea9d0 | Merge origin/chase/t3-261114-next (44d7d60d20) into lane N3 |  |
| 19fe33fdee577eb7b31892af9da97bdd9d612726 | Merge origin/dev (26847e90dc) into lane N3 |  |
| 65a69a24cbcddc67a0938bf7d607a276e56ab1ef | Merge origin/chase/t3-261114-next (5c798a3072) into lane N3 | integration head named by the coordinator |
| 89d6b2d024e96b8b3d9aa83da9aa9fae07d1df4c | Merge origin/dev (1d41f2c97f) into lane N3 | dev |


Files each merge took from both sides (git show --cc --name-only: the result differs from every parent, so the file was auto-merged from both sides or resolved by hand). Textual conflicts resolved by hand: in 65a69a24cb only pnpm-lock.yaml (regenerated by the installer from the merged manifests, comparison under Lockfile and pins) and oxlint-plugin-goat/code-budgets.json (larger side per entry, then lowered by update-code-budgets to real lengths); in 3a176989e1 tunnel.managed-reuse.test.ts was adapted (args.map(String), Layer.mergeAll(NodeServices, NodeCrypto)) and code-budgets.json taken from next and re-lowered; in 634ca5728d N3's duplicate readSafeSqliteInteger was dropped in favour of N2's in sqliteCheckpointWorker.ts. The other entries below auto-merged; each merged tree passed typecheck before the next step.

| merge | files from both sides |
|---|---|
| 3a176989e1 | `apps/server/src/git/GitManager.ts` `apps/server/src/git/GitManagerTestHarness.ts` `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` `apps/server/src/sshRemote/SshRemoteDispatch.cloud.test.ts` `apps/server/src/terminal/Manager.test.ts` `apps/server/src/vcs/testing/gitFixture.ts` `devlog/_chase/010_fork_delta.md` `packages/ssh/src/tunnel.core.test.ts` `packages/ssh/src/tunnel.managed-reuse.test.ts` `packages/ssh/src/tunnel.ts`  |
| 634ca5728d | `apps/server/src/orchestration-v2/EffectWorker.testkit.ts` `oxlint-plugin-goat/code-budgets.json` `packages/shared/src/nodeSqliteClient.ts`  |
| e874072087 | none |
| cf7a23a563 | `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` `apps/server/src/orchestration-v2/runtimeLayer.test.ts` `apps/server/src/server.ts` `apps/server/src/usage/UsageService.test.ts` `oxlint-plugin-goat/code-budgets.json`  |
| b0d48dd78a | none |
| 889902b71c | none |
| 741aebdd36 | `apps/server/src/goatclaw/DecisionInbox.ts` `apps/server/src/mcp/McpHttpServer.ts` `apps/server/src/mcp/OrchestratorMcpService.childWork.test.ts` `apps/server/src/mcp/OrchestratorMcpService.executedModel.test.ts` `apps/server/src/mcp/OrchestratorMcpService.lazyThreads.test.ts` `apps/server/src/mcp/OrchestratorMcpService.reviewContinuation.testkit.ts` `apps/server/src/mcp/OrchestratorMcpService.ts` `apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts` `apps/server/src/mcp/threadAccess.ts` `apps/server/src/mcp/toolkits/thread/handlers.test.ts` `apps/server/src/orchestration-v2/ProjectionStore.test.ts` `apps/server/src/orchestration-v2/runtimeLayer.ts` `oxlint-plugin-goat/code-budgets.json`  |
| 19fe33fdee | none |
| 65a69a24cb | `apps/server/src/checkpointing/CheckpointDiffQuery.ts` `apps/server/src/goatclaw/DecisionInbox.ts` `apps/server/src/mcp/LaunchWatchService.ts` `apps/server/src/mcp/OrchestratorMcpService.ts` `apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts` `apps/server/src/orchestration-v2/runtimeLayer.ts` `oxlint-plugin-goat/code-budgets.json` `packages/provider-acp/src/server/adapter.ts` `packages/provider-pi/src/server/test/fakePi.ts` `pnpm-lock.yaml`  |
| 89d6b2d024 | `apps/web/src/components/ChatView.tsx`  |

### Budgets

| sha | subject | note |
|---|---|---|
| 9864ee2dd72c114754cd88571c3bf2caebece702 | chore(lint): lower the code budgets of files lane N3 shrank |  |
| d3d53afe115aa863919c4d76a9104d28a02b51b3 | chore(lint): lower the code budgets of McpHttpServer.ts and nodeSqliteClient.ts |  |
| 9d98d717747a73aa83ad1b1ce6e077d24ffc12ea | chore: code budgets at the merged tree's real lengths after the dev merge |  |

Upstream test edits carried: 57cd05904d's own test edits are carried as upstream wrote them where GOAT has the file. aa58dc6d22 and e9eb473d52 have none. 0f5ecef914's assertion goes into GOAT's "rejects an unloadable home" test; its other test edits were already carried in #3212 as bootService.render.test.ts. 65e4272db1's NonBlockingSpawner.test.ts is new; its Claude and Muse tests were already in GOAT (#2533, #3260).

The port touched 442 files mechanically (an import or provider swap only) and adapted 458 files by hand. Both lists are at the end of this record.

## Rulings

Rulings 1 to 5 and Sequencing are quoted from n3-rec-rulings.md, which holds them verbatim. The later blocks are quoted from next-N3-coordinator-rulings.md in its order, under its headings.



### 1. Alchemy

> Coordinator decision, 2026-11-16, lane N3, decision:797807a9-1db5-49fd-9f87-5e0bb31a2e9b: MOVE-ALCHEMY. Upstream 57cd05904d is itself "chore(deps): upgrade Effect to 4.1.2 and alchemy to beta.85 (#26833)": its pnpm-workspace.yaml moves alchemy and the @alchemy.run packages to 2.0.0-beta.85, adds @alchemy.run/test, and moves @distilled.cloud/cloudflare to 1.0.0-rc.18 in the same commit as effect and @effect/* 4.1.2. The owner's ruling O26 A (run the Effect 4.1 lane: 4.1.2, then 4.1.3) names 57cd05904d as its first step, so porting that commit as upstream wrote it is inside the ruling; the lane brief's "only effect and its own packages may move" was too narrow and is replaced by: the lockfile may move exactly what upstream 57cd05904d and aa58dc6d22 move (effect, @effect/*, alchemy, @alchemy.run/*, @distilled.cloud/*, the added @alchemy.run/test and @effect/platform-bun if upstream adds it) and their transitive packages, nothing else. Conditions (C4): (a) exact pins equal to upstream's at those commits; every pnpm-workspace.yaml list that names these packages by version (catalog, overrides, the release-age and build allow lists, patchedDependencies) is updated to the same versions, with no entry left at beta.80 or rc.13; (b) the record lists every package the lockfile adds, removes or changes and which of the named moves explains it; no install scripts newly allowed without saying so; (c) GOAT's patches/alchemy@2.0.0-beta.80.patch is re-ported onto beta.85 and shown hunk by hunk in the record: each old hunk is carried, changed (why) or dropped because beta.85 has it; upstream's patches at that commit (@alchemy.run__test@2.0.0-beta.85.patch, @effect__vitest@4.1.2.patch) are taken as upstream has them plus GOAT's own hunks; (d) the infra/relay and infra/task-cache typecheck and tests run in the gate (the PostgreSQL relay files on a host that has it, or on a NOT RUN line with the reason); (e) nothing is deployed: no alchemy deploy, plan or destroy against any account; the record says the next real relay or task-cache deploy will be the first on beta.85 and names what to check then; (f) third-party licence notices follow the new versions if any of these packages ship in an artifact.

### 2. Rule 3 authorisation

> Coordinator authorisation, 2026-11-16, rule 3, lane N3 (Effect 4.1). (1) Authorised: six assertions change from expect(err._tag) to expect("_tag" in err ? err._tag : undefined) with the same expected value, because callTool's error union now includes McpErrorBase: apps/server McpHttpServer.test.ts:957, agentSurface/search.test.ts:248 and :275, toolkits/core.test.ts:1223 and :1686, toolkits/ssh/handlers.test.ts:732. (2) Authorised: the test "a digest that cannot be computed is omitted, so the snapshot stays JSON" in OpenCodexInventory.test.ts is removed, because in Effect 4.1 Digest.digest has no failure channel, so the case cannot be built. Conditions: the record quotes the 4.1 signature that shows it; the orElseSucceed fallback in OpenCodexInventory.ts is removed in the same commit, with no dead fallback left; and the record says what happens now if hashing throws (a defect: where is it caught, and does the inventory snapshot still serialise). No other expectation in an existing dev test may change or be removed in this lane without asking; upstream's own test edits in 57cd05904d, aa58dc6d22, 0f5ecef914, e9eb473d52 and 65e4272db1 are carried as upstream wrote them and listed in the record.

### 3. Code budgets

> Coordinator ruling, 2026-11-16, lane N3, code budgets. No entry is raised (AGENTS.md: move code instead of raising the baseline). In this order: (1) Upstream's own line stays wherever the file has room: upstream 57cd05904d writes Layer.mergeAll(NodeServices.layer, NodeCrypto.layer) inline, and GOAT follows it line for line in upstream files. (2) In a file that is AT or over its entry, or would cross 1000 lines, only because of the NodeCrypto additions, use one shared GOAT layer instead (one new GOAT-owned module exporting NodeServices merged with NodeCrypto; name and place it where both server and packages can import it without a cycle), swapping the import and the provider so the file's line count does not grow. That is a GOAT difference in those files only: list them in the record and add one fork-delta line. (3) The files that still exceed (McpHttpServer.ts +65, serverSettings.test.ts +54, tunnel.core.test.ts +30, OrchestratorMcpService.test.ts +23, tunnel.ts +21, and any of McpOAuth.test.ts, DesktopSshEnvironment.test.ts, acp-registry driver.ts still over 1000) get verbatim move-outs, each byte-identical apart from imports and exports, grouped one commit per package, placed BEFORE the port commit in the branch's history (the branch is unpushed, so reorder locally). A commit that moves a test updates scripts/lib/goat-rename in the same commit when a rule names it. (4) After the port, lower every entry of a file that shrank to its real length.

### Sequencing

> Sequencing for N3 (new): #3519's integration branch origin/chase/t3-261114-next (cb3d03bdce: dev c66dc0f1fd plus lanes N1, N16, N11) already holds approved code that the 4.1 move must cover (new server files and tests from N16 and N11 use NodeServices and crypto). N3 merges origin/chase/t3-261114-next into its branch before its gate and adapts those files too, so that N3 lands on the integration branch with typecheck at 0 errors there; READY names the integration head it contains. Every lane that sends READY after N3 is merged merges the new integration head and adapts before its gate (N2 and N5 first). One documented type assertion in layerMcpTransport is noted: it must not be a cast to any, and the reviewer will look at it. The mobile native fingerprint outcome and one manual full CI run on the branch stay required. A fresh N3 thread in the same worktree at 08eeb93f83 is fine: Opus, the full brief plus these answers and the previous child's report.

### 4. Alchemy move, two points

> Coordinator rulings, 2026-11-16, lane N3, on the alchemy move (two points raised by the child).
>
> (1) bc1ea26cc0 (upstream "chore(infra): bump Alchemy to 2.0.0-beta.84", skipped in cycle 261029 as an infrastructure bump GOAT did not need: card 10.018 row 11). Moving to beta.85 makes its infra hunks necessary, so that skip is reversed. It may stay inside the 57cd05904d port commit (the lockfile cannot be split), on these conditions: the commit message names both upstream commits (57cd05904d, and bc1ea26cc0 for the infra hunks); the record lists bc1ea26cc0's 27 files one by one as carried, adapted or left out with the reason; card 10.026 gets a row "bc1ea26cc0: skip of 261029 reversed, carried in lane N3 because Effect 4.1 needs alchemy beta.85" and #3176 gets a matching note. Two hunks need care: (a) Drizzle.Postgres { client: { prepare: false } } in infra/relay/src/db.ts changes how the deployed relay talks to PostgreSQL: carry it as upstream wrote it and name it in the record under "first deploy on beta.85: what to check"; (b) the text upstream removed from docs/operations/release.md and .github/workflows/deploy-relay.yml says a forced deploy replaces the Postgres runtime role and its password (alchemy-run/alchemy#1832). Remove that warning in GOAT ONLY with evidence that beta.85 no longer does it (the upstream issue closed with a fix released at or before beta.85: gh issue view on alchemy-run/alchemy, read only, cite it in the record). Without that evidence the warning stays, in both files. Workflow files are release surface: change nothing else in deploy-relay.yml.
>
> (2) Pins. The extra override @effect/sql-d1 4.1.2 is accepted on this rule: wherever a fresh resolution today picks a newer version than upstream's own pnpm-lock.yaml had at 57cd05904d and the newer one does not fit (a peer on a later effect), GOAT pins the version upstream's lockfile has at that commit. So: check that upstream's lockfile at 57cd05904d has @effect/sql-d1 4.1.2 and say so in the record; put a one-line comment beside the override; at aa58dc6d22 set it to what upstream's lockfile has there, or remove it if a fresh resolution then matches. Run the same comparison for every effect, @effect/*, alchemy, @alchemy.run/* and @distilled.cloud/* package in the lockfile against upstream's lockfile at the same commit and list any other difference with its reason. Removing the dead alchemy>@prisma/dev override is accepted if beta.85 has no such dependency and upstream's workspace file dropped it too; say which.
>
> (3) The relay PostgreSQL fixture cannot start on pen-mac-studio: that part goes on the NOT RUN line there and must pass in the lane's manual full CI run (the job "Connect auth PostgreSQL boundaries" and the relay tests on a hosted runner); READY cites that run.

### 5. Rule 3, third request (storageCleanup.test.ts)

> "Coordinator authorisation, 2026-11-16, rule 3, lane N3, third request: authorised. In apps/server/src/storageCleanup.test.ts, "counts the pnpm virtual store only when its store forces copies", the FileSystem spy may record lstat calls as well as stat calls (one added line), because upstream e9eb473d52 (row L236) replaces the readLink probe plus stat with one fs.lstat and changes no test itself; every expectation of that test stays as it was. The lstat swap is kept: it is the row."

### Freeze lifted, order reversed, and the gate failures (2026-11-16 16:50 UTC; quote verbatim)

> Coordinator decision, 2026-11-16 16:50 UTC: the freeze of chase/t3-261114-next is LIFTED and the order is reversed. Reason: N3's gate on 44d7d60d20 failed with failures still undiagnosed (one of them security-relevant), so N3 is hours from READY (fixes, a 2.5 h gate, the full CI run, a C4 review); three finished lanes must not wait behind that and then each adapt to Effect 4.1 on its own. New order: the finished lanes merge now on Effect 4.0.5; N3 merges the integration head ONCE, when its own fixes are done, adapts whatever those lanes added, and gates once on that tree.
> Integration head now: 8540be97ac (44d7d60d20 plus the N6 follow-up e74a5be389; merge commit by git commit-tree, tree equal to the lane head's tree, plain push; #3519 body updated; quick CI runs on it).
>
> For N3 (relay verbatim; quote the two decisions in next-N3.md):
> (1) Do NOT merge or gate again until your own failures are understood and fixed with focused tests. Then ask the lane coordinator for the integration head, merge origin/chase/t3-261114-next once at that head, adapt, and run the one gate. I refreeze the branch for the length of that gate when you say you are starting it.
> (2) ChannelUnlinkedAccess.test.ts comes FIRST, before anything else. An unlinked person seeing one of the owner's threads is an authorisation failure until proven otherwise, and your own diagnosis of retryKeys.test.ts gives a likely cause: under Effect 4.1 the per-request context overrides what a tool captured at registration, where 4.0 did the opposite. So: (a) find the root cause of the channel failure and of the three handlers.goatclaw.test.ts failures; (b) audit EVERY place in apps/server and packages where a tool handler, a toolkit layer, the MCP transport, a channel or Bot path, or the in-process MCP middleware you added provides or captures identity, scope, caller thread, permission ceiling or memory grant through the Effect context: list each with path:line and say which value wins under 4.1 when both a registration-time and a request-time value exist, and whether a caller can supply the request-time one; (c) any place where a caller-supplied or stale context can now win over the server's own is a P0 for this lane: fix it in code so the server's value wins by construction (not by test setup), test first, and show the failing test; (d) put the audit list in the record.
> (3) retryKeys.test.ts: rule 3 is NOT authorised yet. A harness change is acceptable only after (2)(b) shows that production never sets the thread context at registration for those tools, with path:line; then send the request with the exact before and after of the harness lines, and I answer. No expectation may change.
> (4) GrokTextGeneration.test.ts (the fake grok exits 127, node not found): establish whether Effect 4.1's ChildProcess replaces the child's environment unless extendEnv is set, then audit every spawn in apps/server and packages (provider CLIs, git, ssh, the terminal, scripts) for the same loss of PATH and HOME: a provider CLI that cannot find node on a user's machine is a break of every turn. List each spawn site and whether it sets the environment explicitly. Upstream matching code is not proof for GOAT's spawn sites. Fix in code, test first.
> (5) The two ssh script tests and CodexAppServerIsolation.integration.test.ts: use the baseline child's report to say for each whether it fails on 44d7d60d20 with Effect 4.0.5 on the same Mac; known issues are cited by number, new ones get an issue.
> (6) If your context runs low again, stop at a clean local commit and report HEAD, done and remaining, as before; the lane coordinator starts a fresh thread in the same worktree.
> (7) The stale /Users/jun/developer/goat/.git/packed-refs.lock from Nov 7 on pen-mac-studio: leave it; I tell the owner.

### ChannelUnlinkedAccess rule 3 authorisation (verbatim)

> Coordinator authorisation, 2026-11-16, rule 3, lane N3, apps/server/src/channels/ChannelUnlinkedAccess.test.ts, "never shows them the owner's other threads": AUTHORISED as a harness change with the expectations unchanged. I read the test at the integration head: it finds the guest's entry by position (seen.filter((entry) => entry.text === "what is running?").at(-1), :302), which is right only while the owner's conversation happens to be handled first; the guest is identified server-side by a principalId starting with "unlinked:" (ChannelGateway.ts:208, :214), and the diagnosis (the guest's input has scopes ["orchestration:operate"] and recent threads []; the owner's has the thread title) says nothing leaks. The three edits: (1) :277 the seen entry gains readonly who: string; (2) :281 gains who: input.requester.principalId; (3) :302 becomes seen.find((entry) => entry.text === "what is running?" && entry.who.startsWith("unlinked:")). assert.deepStrictEqual(guest?.titles, []) and the owner assertion stay as they are.
> Conditions: (a) add two assertions beside the existing ones so the test cannot pass on a missing entry or a mislabelled one: assert.isDefined(guest, "the guest's input was built") and that the owner entry found has who equal to the owner's principalId; (b) the commit shows the test failing on the port before the edit with its message and passing after, and the record keeps the logged guest and owner inputs as the evidence that this was ordering, not access; (c) the ORDER itself is a finding, not only a test detail: say in the record which Effect 4.1 change makes two channel conversations ingested in sequence get handled in the other order (the scheduling primitive, with path:line of GOAT's channel runtime), and prove with an existing or a new test that messages within ONE conversation are still handled in arrival order under 4.1; if two messages of one conversation can now be handled out of order, that is a regression to fix in code before READY, test first. channelSessionReceiptDelivery.test.ts (8 sends where 9 are expected) may be the same cause: diagnose them together, and say for each what a user would see in production. No other expectation in an existing dev test may change in this lane without asking.
>
> Also from the coordinator: 373b22790b (registration context applied innermost, so retryKeys.test.ts and handlers.goatclaw.test.ts pass unchanged) is the right kind of fix; no rule 3 is needed for those two. The audit table (n3-rec-audit.md) and the spawn list (n3-spawn-audit.txt) go into the record. The Grok failures count as pre-existing on this Mac only with the issue number cited (goat#3425 if it matches; otherwise a new issue). The integration head to merge, once the two regressions are fixed, is whatever the lane coordinator gives you then; today it is c5d8d872d0, and N7 part 2 and N9b part 1 are expected to land before N3 is ready, so ask for the head when your fixes are done.

### channelSessionReceiptDelivery rule 3 authorisation and part 4 decisions (verbatim)

> Coordinator authorisation, 2026-11-16, rule 3, lane N3, apps/server channelSessionReceiptDelivery.test.ts, "starts another receipt while eight receipt transports are hung": AUTHORISED as a harness change with the expectations unchanged. The three edits as requested: a Deferred lastRecorded and a lastSent flag set by the send mock for key "last"; the test's layer gets a ChannelWake whose wake completes lastRecorded once lastSent is true (and whose next never fires); after TestClock.adjust("1 second") the test awaits lastRecorded. assert.lengthOf(sent, 9) and the "delivered" assertion stay as they are. Why the meaning is kept: the TestClock stands at 1 second while the test waits, the eight hung sends can only end at their 4 second timeout, and nothing else advances the clock, so the ninth receipt can only be recorded while the eight are still hung; if it is never sent the test fails (it does not pass on a timeout).
> Conditions: (a) the commit message or the record shows the test failing on the port before the edit with its message (8 where 9 is expected) and passing after, and says in one sentence what changed under Effect 4.1 (the ninth send needs one more scheduler turn after the clock moves; no time passes) and that production is unaffected because nothing there asserts on a turn count; (b) the ChannelWake replacement is local to this one test's layer; no shared testkit default changes; (c) no sleep, yieldNow loop or retry is added anywhere. No other expectation in an existing dev test may change in this lane without asking.
>
> Coordinator decisions, 2026-11-16, lane N3 part 4:
> (1) 0728a1e058 (a request forked into a closed session scope ran under 4.0.5 and is interrupted unstarted under 4.1.3, so after an unexpected Codex app-server exit mid-turn the thread stayed running): ACCEPTED as the right fix, test first as shown. The audit you started is REQUIRED before READY and widened: every Effect.forkIn (with or without startImmediately), every FiberSet.run, FiberMap.run and FiberHandle.run that can be called after its set or scope has closed, every Effect.forkScoped that can run while its scope is closing, and every finalizer that forks, in apps/server and packages. For each site: path:line, whether the scope or set can already be closed when it runs, what 4.0.5 did and what 4.1.3 does, and the user-visible result (a turn left running, an event never written, a cleanup never run). Each site that changes behaviour gets a test-first fix. The list goes into the record. This class matters more than the test failures: a fork that silently does not run is how a thread stays "running" or a process is never stopped.
> (2) The channel order finding (condition (c) of the ChannelUnlinkedAccess authorisation): ACCEPTED. Conversations run concurrently by design (ChannelRuntime.ts:134-156) and their relative order was never a contract; order inside one conversation is enforced by the ledger (ChannelLedger.ts:1001-1014) and ChannelScenarios.test.ts:708 passes on 4.1. The record says so in those words, with what a user can see (two people writing at the same moment in different conversations may be answered in the other relative order).
> (3) The pre-existing failures with their issue numbers (goat#3363, goat#3425, goat#3403): accepted as cited.
> (4) The integration head for N3. When N3 says its fixes and the fork audit are done, the lane coordinator tells me at once and N3 does this meanwhile: a trial merge of origin/chase/t3-261114-next (no gate) to see the conflicts. Two reviewed lanes are about to land (N7 part 2 at 132a0f1f6f and N9b part 1 at 7fe3d68aa5, both in fresh review now; plus N13b's one-test follow-up). If their reviews are back within 45 minutes of N3 asking, they are merged first and N3 takes that head; otherwise N3 takes the head on origin at that moment. From the moment I name the head, chase/t3-261114-next is FROZEN until N3 is merged: lanes approved meanwhile wait, then merge the post-N3 head and adapt to Effect 4.1 with focused tests.

### Head not waiting for N7 part 2 (verbatim)

> For N3: the integration head is 5c798a3072 as of now. N7 part 2 is in a second fix round, so N3 does NOT wait for it: when N3's fixes and the fork audit are done, tell me, and I name the head on origin at that moment and freeze the branch until N3 is merged. If N7 part 2 is re-reviewed and merged before that, it is simply part of the head; if not, it merges the post-N3 head afterwards.

### Integration head named and frozen, and the part 4 instructions (2026-11-16 17:51 UTC; verbatim)

> Coordinator decision, 2026-11-16 17:51 UTC: THE INTEGRATION HEAD FOR N3 IS 5c798a3072eab155e0ae222dda3dcd33641c0bcc (verified on origin with git ls-remote at 17:51 UTC), and chase/t3-261114-next is FROZEN from now until N3 is merged. Nothing else is merged into it meanwhile. Lanes that become READY during the freeze (N7 part 2's second fix round, N9b part 2) are reviewed as usual and then wait; after N3 lands each merges the post-N3 head and adapts to Effect 4.1 with focused tests.
>
> For N3 part 4 (relay verbatim; quote in next-N3.md):
> (1) Merge origin/chase/t3-261114-next at 5c798a3072 once. pnpm-lock.yaml: do not hand-pick hunks. Take the merged manifests (package.json files, pnpm-workspace.yaml, patches) and regenerate the lockfile with the repository's installer, then show in the record that the result keeps both sides: the pinned effect, @effect, alchemy, @alchemy.run and @distilled.cloud packages equal to upstream's lockfile at the commits N3 ports (the list N3 already made), the @effect/sql-d1 override, jsonc-parser 3.3.1 under packages/provider-cursor and the @cursor/sdk patch hash 57f50212... from lane N9b, and that NOTHING ELSE moved against the two parents (a scripted comparison of resolved versions, printed in the record); vp i --frozen-lockfile passes afterwards. code-budgets.json: every entry at the file's real length by countLines in the merged tree, none raised; a file that is over gets a verbatim move-out commit first, as before.
> (2) Adapt the newly merged lanes' files to Effect 4.1 until typecheck is 0 (the reviewers named these: N8 remoteTaskFollowUp.ts, launchWatchFollower.ts, cli/thread.ts, the stream merge in ThreadManagementService.ts, tests' TestClock and forkChild use; N6 and N7 part 1 files in orchestration-v2 and mcp; N9b part 1 workspaceMcpServers.ts (ChildProcess.make, spawnAndCollect, HostProcess), the Cursor adapter's ChildProcessSpawner, promptAckChecks.ts (forkScoped startImmediately, Fiber.pollUnsafe, Scope.provide); N13a and N13b are web only). The fork-into-a-closed-scope audit must be re-run over the files these lanes added: any startImmediately fork there (promptAckChecks.ts is a test; look for production ones) gets the same verdict line.
> (3) The one gate: vp run check:changed on the merged, adapted tree, on pen-mac-studio, with the goat#3238 serverCwd hangs stopped only by PIDs traced to your own gate as before. Every failure is either fixed or cited with its issue number and the proof that it fails the same way on 5c798a3072 with Effect 4.0.5 on that Mac.
> (4) After a passing gate: push chase/t3-261114-n3-effect-41 (plain push), then dispatch the ONE manual full CI run on that branch (gh workflow run goat-ci.yml --ref chase/t3-261114-n3-effect-41) and send the URL and time at once. A full run of #3519 on 5c798a3072 is in progress now (the ci:full label); wait for it to finish before you dispatch yours. The relay PostgreSQL tests and "Connect auth PostgreSQL boundaries" are proven by that CI run, since pen-mac-studio cannot start PostgreSQL.
> (5) ffbce8a8fa (packages/shared/src/forkInScope.ts; the ACP interruptTurn and CodexSurvivorContinuation fixes) and 0728a1e058 are ACCEPTED as the kind of fix asked for; they are reviewed with the lane. The audit file n3-forkin-audit.md goes into the record with its stated limits as written (the 485 plain fork sites judged from the version semantics, not read one by one; the finalizer scan can miss helpers that fork inside a called function).
> (6) Two more things for the record before READY, which a read-only subagent can prepare while the gate runs: (a) the Effect 4.1.3 change in how catch treats causes that mix failures and defects: state it exactly with the Effect source file:line on both versions, then list where GOAT relies on the old behaviour in places where a wrong answer is costly: the server's last-resort handlers and guardErrors paths, the effect worker and its outbox settlement, ProviderSessionManager and the adapters' ingest-failure handlers, RunExecutionService, the channel delivery worker, the MCP transport's error mapping. For each: path:line, what a mixed cause does now, and whether an error that used to be caught and recorded can now escape as a defect (one error must never take down the server) or a defect that used to escape is now swallowed. A site that changes gets a test-first fix. If the honest answer is that this cannot be bounded by a search, say so and say what was checked. (b) File the goat issue for OpenCodexChildBootstrap.ts:850 (the setup session is not revoked when shutdown interrupts a readiness check; on both Effect versions, so it predates N3) with the path:line and what is left behind, and cite its number in the record.
> (7) READY then carries: the head on origin, the full CI run's URL and result, the gate line, the list of rule 3 authorisations used (six assertions _tag, the removed digest test, the lstat spy line, ChannelUnlinkedAccess, channelSessionReceiptDelivery), the three audits (registration context, spawn sites, forks), the lockfile comparison, the alchemy patch hunk comparison, the native fingerprint line, and NOT RUN. The lane then gets two fresh C4 reviews (server semantics and security; packages, infra, lockfile and patches) before the merge.

## Decisions and adaptations

- Budget ruling step 2: shared layer packages/shared/src/nodeServicesWithCrypto.ts (export ./nodeServicesWithCrypto in packages/shared/package.json) is `Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)`. 32 files that were at their budget import it in place of @effect/platform-node/NodeServices (list under Code budgets).
- layerMcpTransport (apps/server/src/mcp/McpHttpServer.ts): the transport is asserted to `Layer<Success, Error, Exclude<Services, HttpRouter.Request<"Requires", McpSchema.McpServerClient>>>` with a one-line `@effect-diagnostics-next-line unsafeEffectTypeAssertion:off` reason. It is a typed Exclude, not a cast to any. Effect 4.1 types the HTTP transport as requiring McpServerClient per request, where 4.0 typed it as providing it; 2026-07-28 calls still get none.
- McpClientAuthenticator's service key follows its new file (goat/mcp/McpAuthMiddleware/McpClientAuthenticator), because the deterministicKeys diagnostic requires it. Nothing reads the key string, and McpHttpServer re-exports the class. This is the one difference beyond imports and exports in the move-outs.
- aa58dc6d22: Toolkit.handle takes Schema.Json in 4.1.3. registerImageTool's handle takes Schema.Json as upstream wrote it. Three GOAT test helpers that pass typed parameters to toolkit.handle mark the JSON boundary with `as Schema.Json` (connection/handlers.test.ts, project/handlers.test.ts, ssh/launch.testkit.ts); no expectation changed.
- L136 (0f5ecef914): GOAT carried the systemd refusal in #3212 without CliError.userMessage, which needs 4.1. This adds the getter on BootServiceBaseDirUnsupportedError (cloud/systemdPath.ts) and upstream's assertion to GOAT's "rejects an unloadable home" test.
- L236 (e9eb473d52): GOAT already walks eight entries at a time (storageCleanupMeasurement.ts, #3260). The row's remaining change is one fs.lstat in place of the readLink probe plus stat. The pnpm-store test's spy also records lstat (ruling 5).
- L239 (65e4272db1): GOAT already had the Claude (ClaudeProcessSpawn.ts) and Muse (envTrampoline) parts and their tests from #2533 and #3260. This adds NonBlockingSpawner.ts, its upstream test and the server.ts wiring. On Linux the server spawns through it, so a hung network mount in a working directory no longer freezes the server; macOS keeps the native spawner.
- Integration merge e7b14604c2: tunnel.managed-reuse.test.ts (N11 moved the managed-reuse test out of tunnel.core.test.ts) carries the port's args.map(String) and provides Layer.mergeAll(NodeServices.layer, NodeCrypto.layer) inline as upstream does (ruling 3 step 1). origin/dev 5688d26760 was already inside e7b14604c2.
- Integration merge a7992962cd (634ca5728d): N3's duplicate readSafeSqliteInteger was dropped, because N2 already had it in sqliteCheckpointWorker.ts.
- Gate 1's knip run found McpHttpServer.layer unused after the port; f7d7009622 removes it.
- Lint fixes in the port commit: unused SecureRandom and Layer imports and unused `random` variables (DesktopConnectionCatalogStore.test, tunnel.core.test, CodexInstallation.update.test, PreviewAutomationBroker.test, AcpJsonRpcConnection.test, tunnel.runtime-fallback.test, relayClient.test). ToolDispatch.ts hoists Schema.is to module constants. wsHeartbeat.ts drops an oxlint-disable goat/guard-error-emitters directive that is no longer needed: the rule does not flag `extends NodeWS.WebSocket` from @effect/platform-node/NodeWS, and the constructor still listens for 'error'.

## Lockfile and pins

The lockfile moves only what ruling 1 allows: effect, @effect/*, alchemy, @alchemy.run/*, @distilled.cloud/* and their transitive packages. From dev c66dc0f1fd to the N3 head it adds 57 package versions and removes 187.

| move | what it explains |
|---|---|
| effect 4.0.5 to 4.1.3, @effect/* 4.0.x to 4.1.2 | @effect/sql-d1 pinned at 4.1.1; @effect/platform-bun added because upstream adds it |
| alchemy 2.0.0-beta.80 to beta.85 | the split @alchemy.run/* packages: acme, axiom, cloudflare, cloudflare-runtime, docker, drizzle, node-utils, planetscale, sql and test added; floci removed |
| @distilled.cloud/* rc.13 to rc.18 | the rc.18 set |
| transitives of the moves | workerd, @cloudflare/workerd-*, @cloudflare/workers-types, rolldown and its bindings, @oxc-project/types, @puppeteer/browsers, mime, modern-tar |
| removed second copies | versions only alchemy beta.80 pulled in: aws-sdk, smithy, octokit, mongodb, sharp, esbuild 0.25.12, drizzle-kit and drizzle-orm rc.5-ab785fc, graphql 16.11.0, libsodium, and @distilled.cloud doppler, fly-io, gcp, hetzner, infisical, neon, prisma, railway, stripe and zerossl. Where a name remains (drizzle-orm, drizzle-kit, esbuild, sharp, graphql), its other version stays. |

Comparison with upstream: at 57cd05904d, all 31 effect, @effect/*, alchemy, @alchemy.run/* and @distilled.cloud/* packages in pnpm-lock.yaml have upstream's versions. At aa58dc6d22 every package of those families still matches. Three transitive versions differ because a resolution today picks newer patch releases: @cloudflare/workers-types 5.20261115.1 (upstream 5.20261026.1), @puppeteer/browsers 3.2.7 (3.2.6) and mime 4.1.2 (4.1.1).

| pin | value and reason |
|---|---|
| @effect/sql-d1 override | 4.1.1. Ruling 4 (2) expected 4.1.2, but upstream's own lockfile at 57cd05904d has 4.1.1, and that is what GOAT pins. A fresh resolution picks 4.1.4, whose peer is effect ^4.1.4; 4.1.1 has peer effect ^4.1.1. At aa58dc6d22 upstream's lockfile still has 4.1.1 and a fresh resolution still picks 4.1.4, so the override stays at 4.1.1 with a one-line comment beside it. |
| alchemy>@prisma/dev override | removed. beta.80 depended on @prisma/dev ^0.20.0, and beta.85 has no such dependency. Upstream dropped the override in bc1ea26cc0: it is present at bc1ea26cc0^ and absent at bc1ea26cc0 and at 57cd05904d. |
| pnpm-workspace.yaml lists | catalog, overrides, release-age and build allow lists and patchedDependencies all name beta.85, rc.18 and 4.1.x; no entry is left at beta.80 or rc.13. |
| install scripts | allowBuilds is unchanged. Of the added versions installed on this Mac, only workerd@1.20261026.1 declares a script (postinstall), and allowBuilds already holds `workerd: false`, so it does not run. Nothing is newly allowed. |
| licence notices | none of these packages ships in a GOAT artifact (infra and dev tooling only); effect ships under its unchanged MIT licence. |

The merge with the integration head regenerated the lockfile; the scripted comparison is under "Merge with the integration head and dev".

<details>
<summary>Lockfile: the 57 added and 187 removed package versions (c66dc0f1fd to N3 head)</summary>


Added:
- @alchemy.run/acme@2.0.0-beta.85
- @alchemy.run/axiom@2.0.0-beta.85
- @alchemy.run/cloudflare-runtime@2.0.0-beta.85
- @alchemy.run/cloudflare@2.0.0-beta.85
- @alchemy.run/docker@2.0.0-beta.85
- @alchemy.run/drizzle@2.0.0-beta.85
- @alchemy.run/node-utils@2.0.0-beta.85
- @alchemy.run/planetscale@2.0.0-beta.85
- @alchemy.run/sql@2.0.0-beta.85
- @alchemy.run/test@2.0.0-beta.85
- @cloudflare/workerd-darwin-64@1.20261026.1
- @cloudflare/workerd-darwin-arm64@1.20261026.1
- @cloudflare/workerd-linux-64@1.20261026.1
- @cloudflare/workerd-linux-arm64@1.20261026.1
- @cloudflare/workerd-windows-64@1.20261026.1
- @cloudflare/workers-types@5.20261115.1
- @distilled.cloud/acme@1.0.0-rc.18
- @distilled.cloud/aws4signer@1.0.0-rc.18
- @distilled.cloud/aws@1.0.0-rc.18
- @distilled.cloud/axiom@1.0.0-rc.18
- @distilled.cloud/cloudflare@1.0.0-rc.18
- @distilled.cloud/core@1.0.0-rc.18
- @distilled.cloud/iceberg@1.0.0-rc.18
- @distilled.cloud/planetscale@1.0.0-rc.18
- @effect/atom-react@4.1.2
- @effect/graphql-generator@4.1.2
- @effect/openapi-generator@4.1.2
- @effect/platform-bun@4.1.2
- @effect/platform-node-shared@4.1.2
- @effect/platform-node@4.1.2
- @effect/sql-d1@4.1.1
- @effect/sql-pg@4.1.2
- @effect/sql-sqlite-do@4.1.2
- @effect/vitest@4.1.2
- @oxc-project/types@0.153.0
- @puppeteer/browsers@3.2.7
- @rolldown/binding-android-arm-eabi@1.2.13
- @rolldown/binding-android-arm64@1.2.13
- @rolldown/binding-darwin-arm64@1.2.13
- @rolldown/binding-darwin-x64@1.2.13
- @rolldown/binding-freebsd-x64@1.2.13
- @rolldown/binding-linux-arm-gnueabihf@1.2.13
- @rolldown/binding-linux-arm64-gnu@1.2.13
- @rolldown/binding-linux-arm64-musl@1.2.13
- @rolldown/binding-linux-ppc64-gnu@1.2.13
- @rolldown/binding-linux-s390x-gnu@1.2.13
- @rolldown/binding-linux-x64-gnu@1.2.13
- @rolldown/binding-linux-x64-musl@1.2.13
- @rolldown/binding-openharmony-arm64@1.2.13
- @rolldown/binding-win32-arm64-msvc@1.2.13
- @rolldown/binding-win32-x64-msvc@1.2.13
- alchemy@2.0.0-beta.85
- effect@4.1.3
- mime@4.1.2
- modern-tar@0.8.6
- rolldown@1.2.13
- workerd@1.20261026.1

Removed:
- @alchemy.run/cloudflare-runtime@2.0.0-beta.80
- @alchemy.run/floci@2.0.0-beta.80
- @alchemy.run/node-utils@2.0.0-beta.80
- @aws-crypto/sha256-browser@5.2.0
- @aws-crypto/sha256-js@5.2.0
- @aws-crypto/supports-web-crypto@5.2.0
- @aws-crypto/util@5.2.0
- @aws-sdk/client-cognito-identity@3.1062.0
- @aws-sdk/core@3.974.17
- @aws-sdk/credential-provider-cognito-identity@3.972.41
- @aws-sdk/credential-provider-env@3.972.43
- @aws-sdk/credential-provider-http@3.972.45
- @aws-sdk/credential-provider-ini@3.972.49
- @aws-sdk/credential-provider-login@3.972.48
- @aws-sdk/credential-provider-node@3.972.51
- @aws-sdk/credential-provider-process@3.972.43
- @aws-sdk/credential-provider-sso@3.972.48
- @aws-sdk/credential-provider-web-identity@3.972.48
- @aws-sdk/credential-providers@3.1062.0
- @aws-sdk/nested-clients@3.997.16
- @aws-sdk/signature-v4-multi-region@3.996.31
- @aws-sdk/token-providers@3.1062.0
- @aws-sdk/types@3.974.5
- @aws-sdk/util-locate-window@3.965.5
- @aws-sdk/xml-builder@3.972.27
- @aws/lambda-invoke-store@0.2.4
- @cloudflare/unenv-preset@2.16.1
- @cloudflare/workerd-darwin-64@1.20260918.1
- @cloudflare/workerd-darwin-arm64@1.20260918.1
- @cloudflare/workerd-linux-64@1.20260918.1
- @cloudflare/workerd-linux-arm64@1.20260918.1
- @cloudflare/workerd-windows-64@1.20260918.1
- @cloudflare/workers-types@5.20261004.1
- @distilled.cloud/acme@1.0.0-rc.13
- @distilled.cloud/aws@1.0.0-rc.13
- @distilled.cloud/axiom@1.0.0-rc.13
- @distilled.cloud/cloudflare@1.0.0-rc.13
- @distilled.cloud/core@1.0.0-rc.13
- @distilled.cloud/doppler@1.0.0-rc.13
- @distilled.cloud/fly-io@1.0.0-rc.13
- @distilled.cloud/gcp@1.0.0-rc.13
- @distilled.cloud/hetzner@1.0.0-rc.13
- @distilled.cloud/infisical@1.0.0-rc.13
- @distilled.cloud/neon@1.0.0-rc.13
- @distilled.cloud/planetscale@1.0.0-rc.13
- @distilled.cloud/prisma@1.0.0-rc.13
- @distilled.cloud/railway@1.0.0-rc.13
- @distilled.cloud/stripe@1.0.0-rc.13
- @distilled.cloud/zerossl@1.0.0-rc.13
- @drizzle-team/brocli@0.12.0
- @effect/atom-react@4.0.5
- @effect/graphql-generator@4.0.5
- @effect/openapi-generator@4.0.5
- @effect/platform-node-shared@4.0.5
- @effect/platform-node@4.0.5
- @effect/sql-d1@4.0.0
- @effect/sql-pg@4.0.5
- @effect/sql-sqlite-bun@4.0.0-rc.112
- @effect/sql-sqlite-do@4.0.5
- @effect/vitest@4.0.5
- @esbuild/aix-ppc64@0.25.12
- @esbuild/android-arm64@0.25.12
- @esbuild/android-arm@0.25.12
- @esbuild/android-x64@0.25.12
- @esbuild/darwin-arm64@0.25.12
- @esbuild/darwin-x64@0.25.12
- @esbuild/freebsd-arm64@0.25.12
- @esbuild/freebsd-x64@0.25.12
- @esbuild/linux-arm64@0.25.12
- @esbuild/linux-arm@0.25.12
- @esbuild/linux-ia32@0.25.12
- @esbuild/linux-loong64@0.25.12
- @esbuild/linux-mips64el@0.25.12
- @esbuild/linux-ppc64@0.25.12
- @esbuild/linux-riscv64@0.25.12
- @esbuild/linux-s390x@0.25.12
- @esbuild/linux-x64@0.25.12
- @esbuild/netbsd-arm64@0.25.12
- @esbuild/netbsd-x64@0.25.12
- @esbuild/openbsd-arm64@0.25.12
- @esbuild/openbsd-x64@0.25.12
- @esbuild/openharmony-arm64@0.25.12
- @esbuild/sunos-x64@0.25.12
- @esbuild/win32-arm64@0.25.12
- @esbuild/win32-ia32@0.25.12
- @esbuild/win32-x64@0.25.12
- @img/sharp-darwin-arm64@0.35.4
- @img/sharp-darwin-x64@0.35.4
- @img/sharp-freebsd-wasm32@0.35.4
- @img/sharp-libvips-darwin-arm64@1.3.3
- @img/sharp-libvips-darwin-x64@1.3.3
- @img/sharp-libvips-linux-arm64@1.3.3
- @img/sharp-libvips-linux-arm@1.3.3
- @img/sharp-libvips-linux-ppc64@1.3.3
- @img/sharp-libvips-linux-riscv64@1.3.3
- @img/sharp-libvips-linux-s390x@1.3.3
- @img/sharp-libvips-linux-x64@1.3.3
- @img/sharp-libvips-linuxmusl-arm64@1.3.3
- @img/sharp-libvips-linuxmusl-x64@1.3.3
- @img/sharp-linux-arm64@0.35.4
- @img/sharp-linux-arm@0.35.4
- @img/sharp-linux-ppc64@0.35.4
- @img/sharp-linux-riscv64@0.35.4
- @img/sharp-linux-s390x@0.35.4
- @img/sharp-linux-x64@0.35.4
- @img/sharp-linuxmusl-arm64@0.35.4
- @img/sharp-linuxmusl-x64@0.35.4
- @img/sharp-wasm32@0.35.4
- @img/sharp-webcontainers-wasm32@0.35.4
- @img/sharp-win32-arm64@0.35.4
- @img/sharp-win32-ia32@0.35.4
- @img/sharp-win32-x64@0.35.4
- @js-temporal/polyfill@0.5.1
- @mongodb-js/saslprep@1.4.13
- @neon/functions@0.11.0
- @octokit/auth-token@6.0.0
- @octokit/core@7.0.6
- @octokit/endpoint@11.0.3
- @octokit/graphql@9.0.3
- @octokit/openapi-types@27.0.0
- @octokit/openapi-webhooks-types@12.1.0
- @octokit/plugin-paginate-rest@14.0.0
- @octokit/plugin-request-log@6.0.0
- @octokit/plugin-rest-endpoint-methods@17.0.0
- @octokit/request-error@7.1.0
- @octokit/request@10.0.10
- @octokit/rest@22.0.1
- @octokit/types@16.0.0
- @octokit/webhooks-methods@6.0.0
- @octokit/webhooks@14.2.0
- @oxc-project/types@0.146.0
- @puppeteer/browsers@3.2.2
- @rolldown/binding-android-arm-eabi@1.2.5
- @rolldown/binding-android-arm64@1.2.5
- @rolldown/binding-darwin-arm64@1.2.5
- @rolldown/binding-darwin-x64@1.2.5
- @rolldown/binding-freebsd-x64@1.2.5
- @rolldown/binding-linux-arm-gnueabihf@1.2.5
- @rolldown/binding-linux-arm64-gnu@1.2.5
- @rolldown/binding-linux-arm64-musl@1.2.5
- @rolldown/binding-linux-ppc64-gnu@1.2.5
- @rolldown/binding-linux-s390x-gnu@1.2.5
- @rolldown/binding-linux-x64-gnu@1.2.5
- @rolldown/binding-linux-x64-musl@1.2.5
- @rolldown/binding-openharmony-arm64@1.2.5
- @rolldown/binding-win32-arm64-msvc@1.2.5
- @rolldown/binding-win32-x64-msvc@1.2.5
- @smithy/core@3.34.1
- @smithy/credential-provider-imds@4.3.8
- @smithy/fetch-http-handler@5.4.6
- @smithy/is-array-buffer@2.2.0
- @smithy/node-http-handler@4.7.7
- @smithy/signature-v4@5.4.6
- @smithy/types@4.18.0
- @smithy/util-buffer-from@2.2.0
- @smithy/util-utf8@2.3.0
- @types/aws-lambda@8.10.161
- @types/webidl-conversions@7.0.3
- @types/whatwg-url@11.0.5
- alchemy@2.0.0-beta.80
- before-after-hook@4.0.0
- bowser@2.14.1
- bson@6.10.4
- drizzle-kit@1.0.0-rc.5-ab785fc
- drizzle-orm@1.0.0-rc.5-ab785fc
- effect@4.0.5
- esbuild@0.25.12
- graphql@16.11.0
- jsbi@4.3.2
- json-with-bigint@3.5.8
- libsodium-wrappers@0.8.4
- libsodium@0.8.4
- memory-pager@1.5.0
- mime@4.1.0
- modern-tar@0.8.5
- mongodb-connection-string-url@3.0.2
- mongodb@6.21.0
- rolldown@1.2.5
- sharp@0.35.4
- smart-buffer@4.2.0
- socks@2.8.9
- sparse-bitfield@3.0.3
- tr46@5.1.1
- universal-user-agent@7.0.3
- webidl-conversions@7.0.0
- whatwg-url@14.2.0
- workerd@1.20260918.1

</details>

## Alchemy patch, hunk by hunk

GOAT's patches/alchemy@2.0.0-beta.80.patch, re-ported onto beta.85 (ruling 1 (c)).

| old hunk (alchemy@2.0.0-beta.80.patch) | outcome on beta.85 |
|---|---|
| lib/Drizzle/Postgres.d.ts and .js, src/Drizzle/Postgres.ts (pgClient options) | dropped: beta.84 and later take config.client (@alchemy.run/drizzle lib/Postgres.d.ts:58). The caller moved to `{ client: { prepare: false } }`. |
| lib/Test/Vitest.js, src/Test/Vitest.ts (vitest to vite-plus/test) | moved: now upstream's patches/@alchemy.run__test@2.0.0-beta.85.patch (lib/Vitest.js), taken verbatim |
| lib/Artifacts.js (settle waiters on failure, GOAT's) | carried unchanged into patches/alchemy@2.0.0-beta.85.patch. beta.85's lib/Artifacts.js is the same blob, 648209c, and still calls Deferred.succeed only on success. |
| lib/Drizzle/Schema.js and src (reconstruct check, GOAT's) | dropped: @alchemy.run/drizzle beta.85 lib/Schema.js:233 readPreviousSnapshot calls kit.reconstruct natively |

patches/@effect__vitest@4.1.2.patch is upstream's, taken in the port commit.

## bc1ea26cc0: its 27 files

Ruling 4 (1) reverses 261029's skip of bc1ea26cc0 (card 10.018 row 11), because beta.85 needs its infra hunks. Card 10.026 row "bc1ea26cc0: skip of 261029 reversed, carried in lane N3 because Effect 4.1 needs alchemy beta.85": added under 판정 변경 on card 10.026 in the same records commit. Matching #3176 note: added as an unticked bc1ea26cc0 line at the end of the Dependencies section (2026-11-16, one --body-file edit; read-back identical), next to the N3 notes on 0f5ecef914, e9eb473d52, 65e4272db1 and aa58dc6d22.

| file | outcome |
|---|---|
| .github/workflows/deploy-relay.yml | left out: GOAT has no relay deploy workflow in .github/workflows |
| docs/operations/release.md | carried: the #1832 forced-deploy warning is removed (evidence below) |
| infra/relay/alchemy.run.ts | carried: alchemy/{Axiom,Cloudflare,Drizzle,Planetscale} to @alchemy.run/* |
| infra/relay/package.json | carried: @alchemy.run/{axiom,cloudflare,drizzle,planetscale} catalog deps, alchemy catalog: |
| infra/relay/src/agentActivity/ApnsDeliveryQueue.test.ts | carried (import path) |
| infra/relay/src/agentActivity/ApnsDeliveryQueue.ts | carried (import path), plus 57cd05904d's SecureRandom |
| infra/relay/src/agentActivity/FcmDeliveries.test.ts | carried (import path) |
| infra/relay/src/agentActivity/FcmDeliveryQueueConsumer.ts | carried (import path) |
| infra/relay/src/agentActivity/FcmDeliveryQueueSender.ts | carried (import path) |
| infra/relay/src/db.ts | carried (import paths) |
| infra/relay/src/environments/ManagedEndpointProvider.test.ts | carried (import path) |
| infra/relay/src/environments/ManagedEndpointProvider.ts | carried (import path) |
| infra/relay/src/hooks/HookInboxObject.ts | carried (import path) |
| infra/relay/src/monitoring.ts | carried (import path) |
| infra/relay/src/observability.ts | carried (import path) |
| infra/relay/src/queues.ts | carried (import path) |
| infra/relay/src/worker.ts | carried: import paths plus `Drizzle.Postgres(hyperdrive.connectionString, { client: { prepare: false } })`. The ruling names db.ts, but the hunk is in worker.ts in upstream too. |
| infra/relay/src/zone.ts | carried (import path) |
| infra/task-cache/alchemy.run.ts | carried (import paths) |
| infra/task-cache/package.json | carried: @alchemy.run/{axiom,cloudflare} catalog deps, alchemy catalog: |
| infra/task-cache/src/observability.ts | carried (import path) |
| infra/task-cache/src/resources.ts | carried (import path) |
| infra/task-cache/src/worker.ts | carried (import paths) |
| patches/alchemy@2.0.0-beta.80.patch | removed; GOAT's own copy is re-ported (patch table above) |
| patches/alchemy@2.0.0-beta.84.patch | left out: superseded by beta.85. Upstream itself renamed it to @alchemy.run__test@2.0.0-beta.85.patch in 57cd05904d. |
| pnpm-lock.yaml | regenerated for beta.85 (lockfile section) |
| pnpm-workspace.yaml | adapted to the 57cd05904d end state; alchemy>@prisma/dev dropped as upstream did in bc1ea26cc0 |

GOAT-only files with the same import move, outside bc1ea26cc0: AccountRateLimitObject.ts and its test, ApnsDeliveries.test.ts, ApnsDeliveryQueueConsumer.ts, DeliveryAuthorization.test.ts, retiredInventoryBinding.ts, HookInboxObject.test.ts (alchemy/Test/* to @alchemy.run/test/*) and accounts/test/PolicyWorkerFixture.ts.

Evidence that beta.85 no longer replaces the Postgres runtime role on a forced deploy (alchemy-run/alchemy#1832, read-only gh):

| check | result |
|---|---|
| gh issue view 1832 -R alchemy-run/alchemy | CLOSED/COMPLETED 2026-10-07T10:21:27Z, "--force drops diff-level stables, so an unchanged PostgresRole is replaced (credentials rotated) on every forced deploy", closed by PR #2103 |
| gh pr view 2103 | MERGED 2026-10-07T10:21:25Z, "fix(planetscale): --force no longer replaces unchanged roles", merge 833a0e754a22d340d178f29ede41e3b6f9097b1d |
| npm release times | beta.81 2026-10-05; beta.82 2026-10-12, the first release after the merge; beta.85 2026-11-02 |
| installed beta.85 | alchemy/src/Plan.ts:890 "(#1832)"; @alchemy.run/planetscale src/Branch.ts, src/Postgres/PostgresDatabase.ts, src/MySQL/MySQLDatabase.ts |

## First deploy on beta.85: what to check

Nothing was deployed: no alchemy deploy, plan or destroy ran against any account. The next real relay or task-cache deploy is the first on beta.85. Check then:

| what | how to tell it worked |
|---|---|
| Relay Worker: `Drizzle.Postgres(hyperdrive.connectionString, { client: { prepare: false } })` in infra/relay/src/worker.ts changes how the deployed relay talks to PostgreSQL | statements behind Hyperdrive run unnamed, and no "prepared statement already exists" error appears |
| Forced deploy no longer replaces the Postgres runtime role (#1832 fix) | the role and its password are unchanged after a forced run |
| Task-cache Worker deploy through @alchemy.run/cloudflare | the deploy succeeds and the Artifacts patch is applied (its pnpm patch hash is in the lockfile) |

## Digest

Ruling 2 (2) removes the test "a digest that cannot be computed is omitted, so the snapshot stays JSON" from OpenCodexInventory.test.ts, because the case cannot be built on 4.1. Effect 4.1.2 effect/dist/crypto/Digest.d.ts:98:

```ts
readonly digest: (algorithm: Algorithm, data: Uint8Array) => Effect.Effect<Uint8Array>;
```

The signature has no error channel. The orElseSucceed fallback in OpenCodexInventory.ts is gone in the same commit: digest() at OpenCodexInventory.ts:182-186 is Digest.digest(sha256, utf8(JSON.stringify(value))) with no fallback.

If hashing throws, the throw becomes a defect. NodeCrypto runs createHash inside Effect.sync (@effect/platform-node-shared 4.1.2 dist/NodeCrypto.js:74). Nothing in OpenCodexInventory catches it: collect (OpenCodexInventory.ts:267) dies, and read = Effect.cachedWithTTL(collect()) (:519) yields that defect. Callers do not catch defects either: OpenCodexUpdateHost.ts:202 uses Effect.option, which maps failures only. So no snapshot is produced at all, and there is no partly hashed snapshot to serialise. Every snapshot that is produced carries string digests (Hex.encode) and stays JSON. createHash("sha256") throws only on an OpenSSL fault.

## Code budgets

No entry is raised (ruling 3). The steps ran in the ruling's order.

Step 1: upstream's inline `Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)` stays wherever the file has room, line for line with upstream.

Step 2: 32 files that were at their entry only because of the NodeCrypto additions use the shared layer @goat/shared/nodeServicesWithCrypto instead, so their line counts do not grow. This is a GOAT difference in these files only. N3 adds one line under code-budgets in devlog/_chase/010_fork_delta.md (git diff origin/dev...HEAD):

> - Effect 4.1 (261114 N3): upstream 57cd05904d는 `Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)`를 줄마다 인라인으로 쓴다. 그 줄 때문에 budget을 넘는 GOAT 파일 32개는 대신 GOAT 공유 레이어 `@goat/shared/nodeServicesWithCrypto`(`packages/shared/src/nodeServicesWithCrypto.ts`)를 import한다(목록: `devlog/_chase/261114_lanes/next-N3.md`). 이 파일들의 upstream 변경을 받을 때 그 import를 유지한다.


| shared layer users |
|---|
| apps/desktop/src/backend/DesktopBackendConfiguration.test.ts |
| apps/desktop/src/ssh/DesktopSshEnvironment.test.ts |
| apps/server/scripts/record-codex-app-server-replay-fixture.ts |
| apps/server/src/auth/McpOAuth.test.ts |
| apps/server/src/channels/slack/SlackChannelSettings.test.ts |
| apps/server/src/mcp/OrchestratorMcpService.test.ts |
| apps/server/src/mcp/PreviewAutomationBroker.test.ts |
| apps/server/src/mcp/ThreadReplicaService.test.ts |
| apps/server/src/mcp/toolkits/core.test.ts |
| apps/server/src/mcp/toolkits/project/handlers.test.ts |
| apps/server/src/memory/MemoryHubScenarios.test.ts |
| apps/server/src/memory/MemoryHubService.test.ts |
| apps/server/src/memory/MemoryHubSyncScenarios.test.ts |
| apps/server/src/memory/MemorySyncService.test.ts |
| apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts |
| apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.test.ts |
| apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts |
| apps/server/src/orchestration-v2/CloudIngress.integration.test.ts |
| apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts |
| apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts |
| apps/server/src/serverSettings.test.ts |
| apps/server/src/sshRemote/SshHostSetup.test.ts |
| apps/server/src/sshRemote/SshWorkspaceSync.test.ts |
| apps/server/src/terminal/Manager.test.ts |
| apps/server/src/vcs/GitVcsDriver.test.ts |
| apps/server/src/workspace/WorkspaceFileSystem.test.ts |
| packages/provider-acp-registry/src/server/AcpRegistrySupport.test.ts |
| packages/provider-core/src/server/maintenanceResolver.test.ts |
| packages/ssh/src/tunnel.core.test.ts |
| packages/ssh/src/tunnel.pending-manager.test.ts |
| packages/ssh/src/tunnel.runtime-status.test.ts |
| scripts/mobile-native-client.ts |

The serverSettings.test.ts, OrchestratorMcpService.test.ts, McpOAuth.test.ts and DesktopSshEnvironment.test.ts overages the ruling named went away with the shared layer, and tunnel.core.test.ts needed 3 lines, not 30.

Step 3: verbatim move-outs, byte-identical apart from imports and exports (and the one service key noted above), one commit per package, placed before the port commit. No test moved between files, so goat-rename TEST_TITLES did not change.

| commit | package | what moved |
|---|---|---|
| c412c55e14 | server | the /mcp auth middleware, McpHttpServer.ts to mcp/McpAuthMiddleware.ts; memorySessionPermit, ws.ts to wsMemorySessionPermit.ts; dispatchFailure and outsideThread, SshHostSetup.ts to sshHostResults.ts; probeSessionId and probeClient, SshHostSetup.test.ts to SshHostSetup.probe.testkit.ts |
| 363fc594f1 | ssh | REMOTE_NODE_ENV_SCRIPT, tunnel.ts to remoteNodeEnvScript.ts; MACOS_BIND_PRELOAD, tunnel.core.test.ts to tunnel.core.fixture.ts; decodeProviders and decodeSshHostResult, tunnel.runtime-status.test.ts to tunnel.runtime-status.fixture.ts |
| dfedb6d383 | provider-acp-registry | makeUnsupportedTextGeneration, driver.ts to unsupportedTextGeneration.ts; HttpsUrl, AcpRegistrySupport.ts to registryHttpsUrl.ts |
| 7d3c866962 | shared | readSafeSqliteInteger, nodeSqliteClient.ts to nodeSqliteParameters.ts |
| 368cf328d3 | provider-core | writeExecutable and linkIntoPackage, maintenanceResolver.test.ts to maintenanceResolver.testkit.ts |
| 6b91826240 | relay | linkedEnvironmentRecord, Api.test.ts to Api.testkit.ts |
| 2c5a96945c | server (before L239) | layerProviderEventLoggers, server.ts to provider/ProviderEventLoggersLayer.ts |
| 2844850115 | shared (before the a7992962cd merge) | classifyError, nodeSqliteClient.ts to nodeSqliteErrors.ts |
| 1dbdd044c3 | server (before the 44d7d60d20 merge) | the ProjectionStore orphan helper and the toolkit secret store test helpers |
| 4a4e988fdb | provider-acp | a block of adapter.ts to acpSubagentStatus.ts, so ffbce8a8fa fits (adapter.ts entry 8559 to 8550) |

Before the move-outs the overages left after step 2 were: apps/server McpHttpServer.ts +65, ws.ts +1, sshRemote/SshHostSetup.ts +1, sshRemote/SshHostSetup.test.ts +2; packages/ssh tunnel.ts +21, tunnel.core.test.ts +3, tunnel.runtime-status.test.ts +1; packages/provider-acp-registry AcpRegistrySupport.ts +3, driver.ts at 1001 lines (over 1000); packages/shared nodeSqliteClient.ts +1; infra/relay src/http/Api.test.ts +3 (a Context.empty() second argument on three app.handler calls).

Step 4: entries lowered to real lengths in 9864ee2dd7 (62 entries, none raised), d3d53afe11 (McpHttpServer.ts, nodeSqliteClient.ts) and ffbce8a8fa (provider-acp adapter.ts 8559 to 8550). After each integration merge, code-budgets.json was taken from next and re-lowered for the files N3 changed. After the dev merge, 9d98d71774 sets every entry to the merged tree's real length (node oxlint-plugin-goat/update-code-budgets.ts, exit 0). None is raised against either parent.

| file | measure | before | after |
|---|---|---|---|
| apps/desktop/src/preview/Manager.ts | lines | 3680 | 3673 |
| apps/desktop/src/snapShot/DesktopSnapShot.test.ts | lines | 2205 | 2197 |
| apps/desktop/src/snapShot/DesktopSnapShot.ts | lines | 1767 | 1766 |
| apps/server/src/assets/AssetAccess.test.ts | lines | 1675 | 1673 |
| apps/server/src/assets/AssetAccess.ts | lines | 1078 | 1077 |
| apps/server/src/auth/EnvironmentAuth.ts | lines | 1454 | 1140 |
| apps/server/src/auth/SessionStore.ts | lines | 1288 | 1108 |
| apps/server/src/cloud/CloudLink.ts | lines | 1307 | 1304 |
| apps/server/src/cloud/ManagedEndpointRuntime.test.ts | lines | 1321 | 1302 |
| apps/server/src/cloud/bootService.test.ts | lines | 1431 | 1272 |
| apps/server/src/device/DeviceService.test.ts | lines | 1249 | 1233 |
| apps/server/src/device/DeviceService.ts | lines | 1131 | 1125 |
| apps/server/src/http.ts | nonNull | 3 | 2 |
| apps/server/src/mcp/LaunchWatchService.ts | lines | 2049 | 2048 |
| apps/server/src/mcp/McpHttpServer.test.ts | lines | 1334 | 1268 |
| apps/server/src/mcp/McpHttpServer.ts | lines | 1222 | 1135 |
| apps/server/src/mcp/OrchestratorMcpService.test.ts | lines | 4977 | 4963 |
| apps/server/src/mcp/OrchestratorMcpService.ts | lines | 4090 | 4065 |
| apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts | lines | 1326 | 1325 |
| apps/server/src/mcp/toolkits/project/handlers.test.ts | lines | 1380 | 1376 |
| apps/server/src/memory/MemorySyncService.test.ts | lines | 7366 | 7365 |
| apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts | lines | 8987 | 8629 |
| apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts | lines | 16924 | 16510 |
| apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts | lines | 11224 | 10941 |
| apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts | lines | 9759 | 9133 |
| apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts | lines | 8405 | 8289 |
| apps/server/src/orchestration-v2/FoundationPersistence.test.ts | lines | 3616 | 3520 |
| apps/server/src/orchestration-v2/ProjectionStore.test.ts | lines | 8041 | 7917 |
| apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts | lines | 2491 | 2451 |
| apps/server/src/orchestration-v2/ProviderSessionManager.test.ts | lines | 6326 | 5975 |
| apps/server/src/orchestration-v2/PullRequestSyncReactor.ts | nonNull | 6 | 5 |
| apps/server/src/orchestration-v2/PullRequestWatchReactor.ts | nonNull | 3 | 2 |
| apps/server/src/orchestration-v2/ThreadLaunchService.test.ts | lines | 2680 | 2594 |
| apps/server/src/orchestration-v2/ThreadSettlementService.test.ts | lines | 1602 | 1599 |
| apps/server/src/orchestration-v2/runtimeLayer.test.ts | lines | 10003 | 9935 |
| apps/server/src/preview/ServerBrowser.test.ts | lines | 2614 | 2611 |
| apps/server/src/provider/CodexChatGptAuth.test.ts | lines | 1822 | 1732 |
| apps/server/src/provider/CodexChatGptAuth.ts | lines | 1004 | undefined |
| apps/server/src/provider/ProviderHostSync.ts | lines | 1110 | 1104 |
| apps/server/src/provider/ProviderRegistry.test.ts | lines | 3000 | 2971 |
| apps/server/src/server.ts | lines | 1339 | 1324 |
| apps/server/src/serverSettings.test.ts | lines | 3136 | 3135 |
| apps/server/src/sshRemote/SshHostSetup.test.ts | lines | 1881 | 1864 |
| apps/server/src/sshRemote/SshHostSetup.ts | lines | 1579 | 1563 |
| apps/server/src/sshRemote/SshRemoteDispatch.test.ts | lines | 4496 | 4419 |
| apps/server/src/storageCleanup.test.ts | lines | 2141 | 2140 |
| apps/server/src/usage/UsageService.test.ts | lines | 3119 | 3055 |
| apps/server/src/vcs/GitVcsDriver.ts | lines | 1812 | 1765 |
| apps/server/src/vcs/GitVcsDriverCore.test.ts | lines | 6304 | 6275 |
| apps/server/src/vcs/GitVcsDriverCore.ts | lines | 5409 | 5401 |
| apps/server/src/ws.ts | lines | 3535 | 3522 |
| infra/relay/src/http/Api.test.ts | lines | 1455 | 1446 |
| infra/relay/src/http/Api.ts | lines | 1556 | 1555 |
| packages/client-runtime/src/operations/commands.ts | lines | 1219 | 1202 |
| packages/provider-acp-registry/src/server/AcpRegistrySupport.ts | lines | 1989 | 1979 |
| packages/provider-acp/src/server/adapter.ts | lines | 8573 | 8559 |
| packages/provider-core/src/server/maintenanceResolver.test.ts | lines | 1663 | 1653 |
| packages/provider-opencode/src/server/v2/adapter.ts | lines | 4237 | 4231 |
| packages/ssh/src/tunnel.core.test.ts | lines | 2889 | 2883 |
| packages/ssh/src/tunnel.runtime-status.test.ts | lines | 1066 | 1065 |
| packages/ssh/src/tunnel.ts | lines | 4870 | 4794 |
| scripts/build-desktop-artifact.test.ts | lines | 3036 | 3017 |

"undefined" means the entry was removed: the file is now under the threshold that needs one.

Dev-merge note: in the code-budgets.json merge, ThreadFeed.tsx at 3388 lines and WelcomeWizard.tsx at 1654 lines are below both parents' entries, 3473 and 1827. N3 changes neither file, and update-code-budgets.ts lowers both entries to those lengths (merge section).

## Audits

### (a) Registration context



How Effect 4.1 orders them: McpServer's makeInvoke runs a handler with the call's context over the services captured at registration (effect 4.1.3 dist/ai/McpServer.js, makeInvoke: Context.merge(services, context)), and upstream's provideRegistrationServices (McpHttpServer.ts, toolkitRegistration) keeps that order. Effect 4.0.5 ran every toolkit handler with the context its layer was built in, applied innermost over the call (4.0.5 dist/ai/McpServer.js:1486-1500, registerToolkit keeps handler.context). N3 restores the 4.0 order in code (373b22790b): applyToolContracts (McpHttpServer.ts:480, :510-512) captures the registration context (registrationContext.ts, minus the services Effect treats as the call's own: McpRequestContext, McpServerClient, HttpServerRequest, ParsedSearchParams, RouteContext, CurrentLogLevel, Scope, ParentSpan, middleware entries) and applies it innermost around every handler. So whenever a value exists at both times, the registration (server-built) value wins, as under 4.0.

| Site | Value | When provided | Caller can supply it? | Wins under 4.1 with 373b22790b |
|---|---|---|---|---|
| mcp/McpAuthMiddleware.ts:156 | McpInvocationContext | per /mcp request, from the credential the registry resolves | no: derived by the server from a bearer token it issued | request value (no registration value exists in production) |
| mcp/McpHttpServer.ts:274 (preview snapshot), :414 (image tools) | McpInvocationContext | per call, re-provided from the fiber's own context | no | the same value either way |
| mcp/toolkits/screen/mcpTool.ts:67 | McpInvocationContext | per call, from the fiber's context | no | same |
| mcp/ThreadLifecycleMcpService.ts:84, :192 | McpInvocationContext | per check, scope argument built by the server | no | inner provide (closest) |
| mcp/ThreadLaunchMcpService.ts:809 | McpInvocationContext | per launch, server-built scope | no | inner provide |
| fleet/goals/GoalWorkerRuntime.ts:374, fleet/goals/GoalService.ts:148 | McpInvocationContext | per goal step, server-built access scope | no | inner provide |
| remoteReports/OriginRoutedDelete.ts:165, :270 | McpInvocationContext | per delete, server-built scope | no | inner provide |
| mcp/McpHttpServer.ts:1030 layerInProcessMcpServer | McpInvocationContext, McpServerClient (type only) | passes the caller's context through unchanged (f8eeb86c21) | no: in-process callers are server code (ToolDispatch, channels, tests) | caller's in-process value; a tool that reads a missing one dies |
| mcp/ToolDispatch.ts:99-100 | HttpServerRequest, LegacyToolCall | per goat_call / goat_eval step | no | inner provide; HttpServerRequest is a call key, never captured |
| mcp/ToolAdmission.ts:334-335, :652-653, :664 | KeyedAdmission, LifecycleAdmissionReceipt, CallFailureCapture | per call, by the admission gate | no | registration value if a layer provided one (none in production: no Layer provides these outside tests), else the gate's |
| mcp/McpToolAccess.ts:160, :468 | AdmittedLimits, DispatchModeLimit | per call, from the resolved declaration | no | same rule as above; none at registration in production |
| goatclaw/DecisionService.ts:97, DecisionRouting.ts:160, DecisionInbox.ts:749 | PermissionProfiles | per decision, the server's profiles service | no | inner provide; also the server's registration value |
| channels: ChannelReceptionService.ts:450 viewerNow, :1022-1025, :1128-1131 | requester scopes, recent-thread visibility | per pass, recomputed live from the link (scopesNow, identityNow) | no: function arguments, not Effect context | n/a (not context) |

Production never provides McpInvocationContext, KeyedAdmission, AdmittedLimits or PermissionProfiles in a registration layer (rg over apps/server/src and packages, tests and testkits excluded: no Layer.succeed/effect of them), so the registration-wins rule changes nothing in production and only makes a server-built value win if one ever is added. No site lets a caller-supplied value replace a server-built one: request-time values come from the auth middleware or server code. The failures were test layers that set these at registration and relied on 4.0's order (retryKeys.test.ts:117, handlers.goatclaw.test.ts:55-67); both pass unchanged after 373b22790b.

### (b) Spawn sites

The spawn audit checked whether Effect 4.1 changes the environment a child process gets. It does not, apart from one case. In both @effect/platform-node-shared 4.0.5 (NodeChildProcessSpawner.js:74-78) and 4.1.2 (:102-112), an env without extendEnv replaces the environment. 4.1 only deletes keys whose value is undefined, which 4.0 passed through. The audit was a heuristic scan with a 15-line window around each call. It found 250 spawn sites:

| env handling | sites |
|---|---|
| inherits the parent environment | 146 |
| sets env | 104 |
| of those, extendEnv: true | 16 |
| of those, extendEnv: false | 9 |

| area | sites |
|---|---|
| apps/server | 95 |
| packages/effect-acp | 2 |
| packages/effect-codex-app-server | 3 |
| packages/provider-acp | 2 |
| packages/provider-acp-registry | 2 |
| packages/provider-claude-cloud | 3 |
| packages/provider-core | 5 |
| packages/provider-devin-cloud | 3 |
| packages/provider-fx | 1 |
| packages/provider-grok | 2 |
| packages/provider-muse | 1 |
| packages/provider-opencode | 3 |
| packages/provider-pi | 3 |
| packages/provider-testing | 2 |
| packages/shared | 10 |
| packages/source-control-github | 2 |
| packages/source-control-testing | 2 |
| packages/ssh | 9 |
| packages/tailscale | 3 |
| scripts | 97 |

The audit started with Grok's 16 failures. Grok's fake CLI fails with "exec: node: not found", and the baseline at 44d7d60d20 on Effect 4.0.5 fails the same way, so the failures predate N3 (goat#3425). NonBlockingSpawner is Linux-only and is not in that path on macOS.

<details>
<summary>All 250 spawn sites (path:line | env handling)</summary>

```text

scripts/computer-use-eval/run.ts:396 | inherits
scripts/computer-use-eval/run.ts:475 | inherits
scripts/computer-use-windows-smoke.ts:97 | inherits
scripts/computer-use-windows-smoke.ts:381 | inherits
scripts/computer-use-windows-smoke.ts:551 | inherits
scripts/profile-startup.mjs:153 | sets env
scripts/export-brand-icons.ts:292 | inherits
scripts/build-npm-launcher.ts:103 | inherits
scripts/build-npm-launcher.ts:104 | inherits
scripts/computer-use-eval/macos.ts:17 | inherits
scripts/computer-use-eval/macos.ts:156 | inherits
scripts/nightly-staging.ts:151 | sets env
scripts/nightly-staging.ts:182 | sets env
scripts/mobile-native-static-check.ts:161 | inherits
scripts/mobile-showcase.ts:457 | sets env
scripts/mobile-showcase.ts:493 | inherits
scripts/mobile-showcase.ts:1063 | inherits
scripts/mobile-showcase.ts:1495 | inherits
scripts/resolve-previous-release-tag.ts:246 | inherits
scripts/check-changed.ts:300 | sets env
scripts/mobile-e2e.ts:212 | inherits
scripts/smoke-cli-archive.ts:56 | sets env | extendEnv: false
scripts/smoke-cli-archive.ts:57 | sets env | extendEnv: false
scripts/smoke-cli-archive.ts:109 | inherits
scripts/smoke-cli-archive.ts:228 | sets env
scripts/smoke-cli-archive.ts:229 | sets env
scripts/sync-reference-repos.ts:247 | inherits
scripts/sync-reference-repos.ts:379 | inherits
scripts/computer-use-linux-smoke.ts:108 | sets env
scripts/computer-use-linux-smoke.ts:314 | sets env
scripts/mobile-e2e/device.ts:29 | sets env
scripts/setup-worktree.ts:247 | sets env
scripts/setup-worktree.ts:342 | inherits
scripts/build-desktop-artifact.ts:933 | inherits
scripts/build-desktop-artifact.ts:949 | inherits
scripts/build-desktop-artifact.ts:983 | inherits
scripts/build-desktop-artifact.ts:1009 | inherits
scripts/build-desktop-artifact.ts:1978 | inherits
scripts/build-desktop-artifact.ts:2095 | sets env | extendEnv: true
scripts/build-desktop-artifact.ts:2148 | inherits
scripts/build-desktop-artifact.ts:2173 | inherits
scripts/build-desktop-artifact.ts:2176 | inherits
scripts/build-desktop-artifact.ts:2177 | inherits
scripts/build-desktop-artifact.ts:2179 | inherits
scripts/build-desktop-artifact.ts:2183 | inherits
scripts/build-desktop-artifact.ts:2184 | inherits
scripts/build-desktop-artifact.ts:2210 | inherits
scripts/build-desktop-artifact.ts:2215 | inherits
scripts/build-desktop-artifact.ts:2216 | inherits
scripts/build-desktop-artifact.ts:2217 | inherits
scripts/build-desktop-artifact.ts:2219 | inherits
scripts/build-desktop-artifact.ts:2225 | inherits
scripts/build-desktop-artifact.ts:2269 | inherits
scripts/build-desktop-artifact.ts:2276 | inherits
scripts/build-desktop-artifact.ts:2285 | inherits
scripts/build-desktop-artifact.ts:2483 | sets env
scripts/build-desktop-artifact.ts:2558 | inherits
scripts/build-desktop-artifact.ts:2618 | inherits
scripts/build-desktop-artifact.ts:2666 | inherits
scripts/build-desktop-artifact.ts:2694 | inherits
scripts/build-desktop-artifact.ts:2723 | inherits
scripts/build-desktop-artifact.ts:2731 | inherits
scripts/build-desktop-artifact.ts:2738 | inherits
scripts/build-desktop-artifact.ts:2765 | inherits
scripts/build-desktop-artifact.ts:2795 | inherits
scripts/build-desktop-artifact.ts:2843 | inherits
scripts/build-desktop-artifact.ts:3400 | inherits
scripts/build-desktop-artifact.ts:3606 | inherits
scripts/build-desktop-artifact.ts:3675 | sets env
scripts/build-desktop-artifact.ts:3956 | inherits
scripts/build-desktop-artifact.ts:4459 | inherits
scripts/build-desktop-artifact.ts:4592 | sets env
scripts/computer-use-windows-capture-guard-smoke.ts:123 | inherits
scripts/computer-use-windows-capture-guard-smoke.ts:140 | inherits
scripts/computer-use-windows-capture-guard-smoke.ts:158 | inherits
scripts/mobile-e2e/video.ts:36 | inherits
scripts/mobile-native-client.ts:185 | sets env
scripts/mobile-native-client.ts:186 | sets env
packages/provider-pi/src/server/rpc.ts:220 | sets env | extendEnv: false
packages/provider-devin-cloud/src/server/relay.ts:135 | sets env
packages/provider-devin-cloud/src/server/cli.ts:240 | sets env
packages/provider-devin-cloud/src/server/cli.ts:241 | sets env
scripts/lib/release-verify.ts:85 | inherits
scripts/lib/release-verify.ts:86 | inherits
packages/provider-core/src/server/maintenanceProbe.ts:25 | sets env | extendEnv: true
packages/provider-core/src/server/maintenanceProbe.ts:26 | sets env | extendEnv: true
scripts/lib/linux-arm64-sea.ts:22 | inherits
scripts/lib/linux-arm64-sea.ts:23 | inherits
packages/provider-pi/src/server/status.ts:273 | sets env
packages/provider-pi/src/server/status.ts:313 | sets env
scripts/lib/dev-first-start.ts:21 | sets env | extendEnv: false
scripts/dev-runner.ts:805 | sets env | extendEnv: false
scripts/build-cli-archive.ts:151 | inherits
scripts/build-cli-archive.ts:153 | inherits
scripts/build-cli-archive.ts:237 | inherits
scripts/build-cli-archive.ts:380 | inherits
scripts/build-cli-archive.ts:405 | inherits
scripts/build-cli-archive.ts:406 | inherits
scripts/build-cli-archive.ts:427 | inherits
scripts/build-cli-archive.ts:557 | inherits
scripts/build-cli-archive.ts:674 | inherits
scripts/build-cli-archive.ts:684 | inherits
scripts/build-cli-archive.ts:690 | inherits
packages/provider-core/src/server/windowsTaskkill.ts:24 | inherits
packages/provider-claude-cloud/src/server/cli.ts:132 | sets env
packages/provider-claude-cloud/src/server/sessionRead.ts:76 | sets env
packages/provider-claude-cloud/src/server/sessionRead.ts:77 | sets env
scripts/lib/windows-jsign.ts:36 | inherits
scripts/lib/windows-jsign.ts:37 | inherits
packages/shared/src/editor.ts:34 | inherits
packages/shared/src/editor.ts:35 | inherits
packages/provider-testing/src/replayWorkspace.ts:35 | sets env
packages/provider-testing/src/replayWorkspace.ts:36 | sets env
packages/shared/src/cuaDriverManifest.ts:620 | sets env
packages/shared/src/cuaDriverManifest.ts:764 | inherits
packages/provider-core/src/server/snapshotProbe.ts:157 | inherits
packages/provider-core/src/server/snapshotProbe.ts:174 | inherits
apps/server/src/runtimeRelaunch.ts:108 | sets env
packages/provider-opencode/src/server/OpenCodeRuntime.ts:490 | sets env | extendEnv: true
packages/provider-opencode/src/server/OpenCodeRuntime.ts:602 | sets env
packages/provider-opencode/src/server/OpenCodeServerLedger.ts:132 | sets env | extendEnv: true
packages/shared/src/envTrampoline.ts:10 | inherits
packages/shared/src/relayClient.ts:266 | inherits
packages/shared/src/relayClient.ts:405 | inherits
packages/shared/src/relayClient.ts:406 | inherits
packages/provider-muse/src/server/status.ts:91 | sets env
packages/shared/src/macosGit.ts:12 | sets env
packages/provider-acp/src/server/AcpSessionRuntime.ts:1083 | sets env
packages/shared/src/shell.ts:344 | inherits
packages/provider-acp/src/server/clientTerminals.ts:156 | sets env
packages/effect-codex-app-server/scripts/generate.ts:837 | inherits
packages/effect-codex-app-server/test/examples/codex-app-server-probe.ts:14 | inherits
packages/effect-codex-app-server/test/examples/codex-app-server-probe.ts:15 | inherits
packages/source-control-testing/src/TestSourceControlHost.ts:139 | sets env | extendEnv: true
packages/source-control-testing/src/TestSourceControlHost.ts:140 | sets env | extendEnv: true
packages/tailscale/src/windowsExcludedPorts.ts:91 | inherits
packages/tailscale/src/windowsExcludedPorts.ts:92 | inherits
packages/tailscale/src/tailscaleExecutable.ts:42 | sets env | extendEnv: true
apps/server/src/memory/imports/MemoryImportReaderSupport.ts:127 | sets env
apps/server/src/resourceTelemetry/HostResources.ts:177 | inherits
apps/server/src/worktreeSnapshots/openHandles.ts:18 | inherits
packages/source-control-github/scripts/measure-pr-preview.ts:79 | sets env | extendEnv: true
packages/source-control-github/scripts/measure-pr-preview.ts:80 | sets env | extendEnv: true
apps/server/src/process/externalLauncher.ts:274 | inherits
apps/server/src/process/externalLauncher.ts:637 | inherits
apps/server/src/process/externalLauncher.ts:638 | inherits
apps/server/src/process/externalLauncher.ts:708 | inherits
apps/server/src/process/externalLauncher.ts:709 | inherits
apps/server/src/process/externalLauncher.ts:745 | sets env | extendEnv: false
apps/server/src/process/externalLauncher.ts:751 | inherits
apps/server/src/process/NonBlockingSpawner.ts:144 | inherits
apps/server/src/process/NonBlockingSpawner.ts:154 | inherits
apps/server/src/process/NonBlockingSpawner.ts:155 | inherits
apps/server/src/resourceTelemetry/NativeTelemetryClient.ts:571 | inherits
apps/server/src/cli/browser.ts:35 | inherits
apps/server/src/cli/browser.ts:56 | inherits
apps/server/src/cli/browser.ts:66 | inherits
apps/server/src/cli/browser.ts:97 | inherits
apps/server/src/orchestration-v2/Adapters/ClaudeProcessSpawn.ts:28 | sets env
apps/server/src/orchestration-v2/Adapters/ClaudeProcessSpawn.ts:64 | sets env
apps/server/src/cli/triage.ts:146 | inherits
packages/ssh/src/preflightProcess.ts:24 | sets env | extendEnv: true
packages/ssh/src/preflightProcess.ts:25 | sets env | extendEnv: true
apps/server/src/cli/uninstall.ts:88 | sets env
packages/ssh/src/command.ts:506 | sets env | extendEnv: true
apps/server/src/provider/CodexInstallation.ts:335 | sets env
apps/server/src/provider/CodexInstallation.ts:336 | sets env
apps/server/src/provider/CodexInstallation.ts:364 | sets env
apps/server/src/provider/CodexInstallation.ts:365 | sets env
packages/ssh/src/runtimeArchiveGh.ts:72 | inherits
apps/server/src/pen/PenRegistrar.ts:67 | sets env
apps/server/src/cli/sshRuntimeSupervisor.ts:399 | sets env
apps/server/src/secrets/onePassword.ts:29 | inherits
apps/server/src/orchestration-v2/goat/restoreSnapshot.ts:28 | sets env
apps/server/src/urlOpener/urlOpenerCli.ts:204 | sets env
packages/ssh/src/tunnelOwner.ts:57 | inherits
packages/ssh/src/tunnelOwner.ts:58 | inherits
apps/server/src/provider/acp/AntigravityClientFiles.ts:231 | inherits
apps/server/src/provider/DocumentText.ts:72 | sets env
apps/server/src/textGeneration/ClaudeMemoryIsolation.ts:37 | sets env
apps/server/src/textGeneration/ClaudeMemoryIsolation.ts:38 | sets env
apps/server/src/htmlRender/headlessChrome.ts:193 | inherits
apps/server/src/textGeneration/CodexTextGeneration.ts:343 | sets env
apps/server/src/textGeneration/CodexTextGeneration.ts:584 | sets env
apps/server/src/textGeneration/ClaudeTextGeneration.ts:339 | sets env
apps/server/src/serviceLauncher.ts:711 | sets env
packages/ssh/src/master.ts:86 | inherits
apps/server/src/orchestration-v2/Adapters/CodexAppServerClientFactory.ts:90 | sets env
apps/server/src/provider/AntigravityInstallationArchive.ts:145 | inherits
apps/server/src/provider/AntigravityInstallationArchive.ts:146 | inherits
apps/server/src/provider/AntigravityInstallationArchive.ts:158 | inherits
apps/server/src/provider/AntigravityInstallationArchive.ts:159 | inherits
apps/server/src/serviceLauncherCopy.ts:7 | inherits
apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:485 | sets env
apps/server/src/provider/antigravityAuthSupport.ts:407 | sets env | extendEnv: false
apps/server/src/provider/antigravityAuthSupport.ts:408 | sets env | extendEnv: false
apps/server/src/speech/native.ts:208 | sets env
packages/ssh/src/hostKey.ts:42 | inherits
packages/ssh/src/hostKey.ts:43 | inherits
apps/server/src/provider/AntigravityInstallation.ts:327 | inherits
apps/server/src/provider/AntigravityInstallation.ts:439 | inherits
apps/server/src/provider/OpenCodexRoute.ts:302 | sets env
apps/server/src/provider/OpenCodexRoute.ts:303 | sets env
apps/server/src/cua/CuaDriverInstallation.ts:114 | inherits
apps/server/src/cua/CuaDriverInstallation.ts:115 | inherits
apps/server/src/cua/CuaDisplayCapability.ts:765 | inherits
apps/server/src/cua/CuaDisplayCapability.ts:835 | inherits
apps/server/src/provider/ProviderHostSync.ts:641 | sets env
apps/server/src/provider/ProviderHostSync.ts:642 | sets env
apps/server/src/cua/linuxHelper/CuaDriverMcp.ts:102 | sets env
apps/server/src/provider/CodexInstallationExtract.ts:73 | inherits
apps/server/src/provider/CodexInstallationExtract.ts:74 | inherits
apps/server/src/cua/linuxHelper/atspiFocus.ts:473 | sets env
apps/server/src/provider/AntigravityInstallationValidate.ts:71 | inherits
apps/server/src/provider/CodexDetachedAppServerLive.ts:196 | sets env
apps/server/src/provider/ProviderHostSyncInstall.ts:23 | sets env | extendEnv: true
apps/server/src/provider/ProviderHostSyncInstall.ts:24 | sets env | extendEnv: true
apps/server/src/cua/driverProcess.ts:22 | sets env
apps/server/src/provider/Drivers/ClaudeAuth.ts:31 | sets env
apps/server/src/provider/ClaudeProvider.ts:250 | sets env
apps/server/src/provider/ClaudeProvider.ts:611 | sets env
apps/server/src/provider/Drivers/ClaudeCloudDriver.ts:180 | inherits
apps/server/src/provider/Drivers/ClaudeCloudDriver.ts:181 | inherits
apps/server/src/provider/providerMaintenanceRunner.ts:123 | sets env
apps/server/src/provider/ProviderDiagnosis.ts:356 | inherits
apps/server/src/provider/ProviderDiagnosis.ts:357 | inherits
apps/server/src/cua/linuxHelper/gnomeVersion.ts:16 | sets env
apps/server/src/provider/CodexProvider.ts:448 | sets env
apps/server/src/provider/CodexProvider.ts:638 | sets env | extendEnv: true
apps/server/src/cua/ComputerUseLeaseProxyCli.ts:826 | sets env
apps/server/src/vcs/GitVcsDriverCore.ts:853 | sets env
apps/server/src/device/SshDeviceHost.ts:362 | inherits
apps/server/src/assets/NativeAppIconResolver.ts:61 | inherits
apps/server/src/opencodex/ChildOpenCodexStartup.ts:66 | sets env
apps/server/src/device/LocalDeviceHost.ts:416 | inherits
apps/server/src/processRunner.ts:297 | sets env
apps/server/src/preview/PreviewBrowserHost.ts:128 | inherits
apps/server/src/cloud/sshRuntimeWindowsJob.ts:191 | sets env
apps/server/src/fleet/goals/GoalWorkerRuntime.ts:575 | inherits
apps/server/src/cloud/sshRuntimeAutoUpdate.ts:183 | inherits
apps/server/src/cloud/sshRuntimeGitBash.ts:109 | inherits
packages/provider-fx/src/server/status.ts:124 | sets env
apps/server/src/cloud/ManagedEndpointRuntime.ts:759 | inherits
packages/provider-grok/src/server/skills.ts:103 | sets env | extendEnv: false
packages/provider-grok/src/server/status.ts:309 | sets env
packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:813 | sets env
packages/provider-acp-registry/src/server/AcpRegistrySupport.ts:814 | sets env
packages/effect-acp/scripts/generate.ts:514 | inherits
packages/effect-acp/scripts/generate.ts:515 | inherits
apps/server/src/screenCode/ScreenRunSupervisor.ts:162 | sets env
```

</details>

### (c) Forks

Effect 4.1.3 changed Effect.forkIn. On a closed scope it now returns a fiber that never started and is interrupted at once (effect@4.1.3 src/internal/effect.ts:5724-5735). 4.0.5 still ran a fork with startImmediately up to its first async step, then interrupted it, so the effect's own ensuring, onExit and onInterrupt ran. A fork that was also uninterruptible ran to completion. A scope reads Closed before its finalizers run (effect.ts:4040-4055), so a "closed" window covers the whole teardown. The audit (n3-forkin-audit.md) read every site where this matters and judged the rest from the version semantics.

First pass, the 27 forkIn sites with startImmediately: true, plus forkScoped with startImmediately: true:

| result | sites |
|---|---|
| fixed before the audit | packages/provider-core/src/server/finiteProviderRequest.ts:43 (0728a1e058) |
| NEEDS FIX, since fixed in ffbce8a8fa | packages/provider-acp/src/server/adapter.ts:8261 (ACP interruptTurn) and apps/server/src/orchestration-v2/Adapters/CodexSurvivorContinuation.ts:476 (survivor adoption) |
| OK, optional guard | packages/client-runtime/src/connection/registry.ts:890: matters only during runtime disposal (the SSH backend disconnect may not be sent) |
| OK, comment overstates | apps/server/src/provider/ProviderRegistry.ts:903: shutdown only, but the comments at :888 and :902 ("the token is always completed") are no longer true on 4.1 |
| OK | the other 22 sites: their first step is already asynchronous, so 4.0.5 also interrupted them before any work, or the scope's owner is gone when it closes |
| forkScoped({ startImmediately: true }) | 22 sites, all OK: the ambient scope is opened just before the fork by layer build, a per-call Effect.scoped, a stream or an RPC scope |

The first pass also listed 15 pre-existing sites: forkIn without startImmediately, joined or awaited, where a closed scope already loses work on both versions (AntigravityAuth.ts:562, ForceStopTeardown.ts:106, SshHostSetup.ts:1042, ProviderCliGate.ts:187, ProviderHostSync.ts:830, GitVcsDriverCore.ts:1257, OpenCodexChildBootstrap.ts:564 and :796, childReadyVerification.ts:113, ChannelDeliveryWorker.ts:446, nodeSqliteClient.ts:412, OriginPullRequestProvider.ts:458, AcpSessionRuntime.ts:1599, provider-opencode adapter.ts:2922, OpenCodeRuntime.ts:665 and :677, ssh tunnel.ts:1976). Except for AntigravityAuth, every one of these scopes is a service or layer scope, so the effect is limited to shutdown.

Widened audit, requested by the coordinator. Result: no new NEEDS FIX.

| group | sites | verdict |
|---|---|---|
| (A) Effect.forkIn without startImmediately: true | 235 | SAME: a plain fork into a closed scope never ran on either version |
| (B) FiberSet, FiberMap and FiberHandle run, runtime and makeRuntime | 18 | SAME, except where a FiberMap or FiberHandle is closed: close now also waits for replaced fibers that are still unwinding (FiberMap.ts:181, FiberHandle.ts:159). CHANGED-HARMLESS, and safer: no cleanup outlives its owner. |
| (C) Effect.forkScoped while its scope is closing | 272 (250 plain, 22 with startImmediately) | SAME; the 22 are SAME in practice (above) |
| (D) finalizers that fork | 10 hits | SAME. OpenCodexChildBootstrap.ts:849-850 loses a revoke at shutdown on both versions (pre-existing, goat#3590). |
| parallel scopes (version row 6) | 4 | SAME: none is closed by a fiber forked into it |

forkInScope (packages/shared/src/forkInScope.ts) brings back 4.0.5's behaviour on a closed scope. It runs Effect.forkDetach, which is the same forkUnsafe call 4.0.5's forkIn made (4.1.3 internal/effect.ts:5663), and then interrupts. The only difference is cosmetic: the interrupt cause carries no interruptor id or annotations, where 4.0.5 passed parent.id. Its only callers are the two fixed sites.

The audit's stated limits, verbatim. First pass ("Not checked"):


> - Tests: none run (read-only brief).
>
> - The pre-existing scan pairs variables by name, so it can miss a fiber that is stored in a map and joined in a different function, or one joined more than 300 lines later.
>
> - Reachability for the ACP site comes from reading the code; there is no reproduction. A test would interrupt a turn through a session runtime handle captured before releaseEntry and assert that the permit is released and the result is not an Interrupt.

Widened audit ("Not checked in the widened audit"):


> - Tests: none run.
>
> - The finalizer scan reads literal finalizer bodies only. A finalizer that calls a helper which forks internally is missed; releaseEntry in ProviderSessionManager is one example (its retries go through FiberSet.run at :1051, covered under B).
>
> - For the 235 forkIn and 250 forkScoped sites, the verdict follows from the semantics (rows 1, 4 and 7) rather than from reading each site. Their scope owners were not traced one by one.
>
> - 4.1.3 also changed catch semantics: findRecoverableError means a cause that mixes failures and defects is no longer caught as a failure (internal/effect.ts diff around :2768, :3713). That is outside this audit but could change behavior elsewhere.

Merge re-audit over the lanes merged from 44d7d60d20 to 5c798a3072: see "Merge with the integration head and dev".

## Regressions found and fixed under 4.1

Gate 5 caught the failures behind 0728a1e058, 373b22790b and f8eeb86c21: tests that passed at the baseline (44d7d60d20 on Effect 4.0.5) and failed on N3. The fork audit found the two ffbce8a8fa sites, which got new tests that failed before the fix. The catch-semantics audit found two more, f6d1b15898 and 9ac4aa0688, which are described in their own section below.

| fix | what broke | user impact | fail-first (file: the assertion line) |
|---|---|---|---|
| 0728a1e058, Codex request after the session closed | finiteProviderRequest.ts:41-44 forked every Codex request into the session scope. When the app-server exits, ProviderSessionManager closes that scope. RunExecutionService's ingest-failure handler then calls interruptTurn, the guarded turn/interrupt request comes back as a bare interrupt, and the handler dies before it writes the failed run. The fix forks only while the scope is open and otherwise runs the request in place under the same deadline. A standalone node script shows the change: 4.0.5 gives Fail("ended") and 4.1.3 gives Interrupt. | After an unexpected Codex app-server exit during a turn, the thread stayed "running". | CodexAppServerExit.test.ts "a request after its session closed fails with the client's error, not an interrupt", n3-finite-failfirst.log: `Error: All fibers interrupted without error`. Both CodexAppServerIsolation.integration.test.ts scenarios hung in gate 5 (n3-gate5.log: `Error: Test timed out in 120000ms.`) and pass 2/2 after the fix. |
| ffbce8a8fa, ACP Stop after the session closed | ACP interruptTurn (adapter.ts:8261) forks with uninterruptible and startImmediately into sessionScope. On 4.1 nothing runs when that scope is closed: runtimeTransitionPermit (taken at :7960) is never released, and the caller's Fiber.join yields a bare Interrupt that the mapError at :8273 does not convert. The fix uses forkInScope. | A Stop sent during session release or retirement got an interruption instead of ProviderAdapterInterruptError or ProviderAdapterInterruptTimeoutError. Every later interruptTurn and respondToRuntimeRequest on that runtime blocked until the caller's timeout. | AcpClosedSessionStop.test.ts "a Stop sent after its ACP session closed gets an outcome, not a bare interrupt", n3-acp-failfirst.log: `AssertionError: expected true to be false` (AcpClosedSessionStop.test.ts:74, `assert.isFalse(Exit.isFailure(stopped) && Cause.hasInterruptsOnly(…`) |
| ffbce8a8fa, Codex survivor adopted after the session closed | adoptSurvivor (CodexSurvivorContinuation.ts:476) settles done only from an ensuring inside the forked effect, and sessionLost (:268) waits on every waiting entry's done (:277). On 4.1 the fork never starts on a closed scope, so done never settles. The fix uses forkInScope. | sessionLost hung, so dead survivor fences and goal fences were never cleared, and a thread fenced by a dead survivor stayed blocked until the server restarted. | CodexSurvivorContinuation.test.ts "a survivor adopted after its session closed still settles the wait session loss awaits", n3-surv-failfirst.log: `AssertionError: expected false to be true` |
| 373b22790b, registration context | Effect 4.1's McpServer runs a handler with the call's context over the services captured at registration. 4.0.5 applied the registration context innermost (details under audit (a)). The fix restores the 4.0 order in apps/server/src/mcp/registrationContext.ts and McpHttpServer.ts:126, :480 and :510-512. | None in production today: production never provides McpInvocationContext, KeyedAdmission, AdmittedLimits or PermissionProfiles at registration. The fix keeps the rule that a value the server built wins over one supplied with the call. | No separate log. The existing tests failed in gate 5 (n3-gate5.log) and pass unchanged after the fix. retryKeys.test.ts (6): `AssertionError: expected [ { type: 'text', …(1) } ] to deeply equal [ ObjectContaining{…} ]`. handlers.goatclaw.test.ts (3): `TypeError: .toMatch() expects to receive a string, but got undefined` (handlers.goatclaw.test.ts:226:64). |
| f8eeb86c21, in-process MCP | layerInProcessMcpServer (McpHttpServer.ts:1030) died when a call carried no McpInvocationContext. It now passes the caller's context through unchanged. | An in-process call (ToolDispatch's goat_call and goat_eval steps, channels) that left out McpInvocationContext or McpServerClient ended in InternalError before the handler ran, even when the tool reads neither. Now a tool that reads a service its caller left out dies on use, as under Effect 4.0 (commit message of f8eeb86c21). | No separate log. agentSurface.test.ts "publishes closed top-level schemas and refuses unknown keys for the whole catalog" and advertisedJsonSchema.registration.test.ts failed in gate 5 (n3-gate5.log): `effect/ai/McpSchema/InternalError: Internal error` (effect McpServer.ts:802). Both pass after the fix. |

## Test-harness changes under rule 3

No expectation changed apart from the authorised items below.

| change | authority | evidence |
|---|---|---|
| Six assertions change from `expect(err._tag)` to `expect("_tag" in err ? err._tag : undefined)`, each with the same expected value: McpHttpServer.test.ts:957, toolkits/agentSurface/search.test.ts:248 and :275, toolkits/core.test.ts:1223 and :1686, toolkits/ssh/handlers.test.ts:732 | ruling 2 (1) | callTool's error union now includes McpErrorBase, which has no _tag |
| OpenCodexInventory.test.ts "a digest that cannot be computed is omitted, so the snapshot stays JSON" removed, together with the orElseSucceed fallback in the same commit | ruling 2 (2) | Digest section above |
| storageCleanup.test.ts "counts the pnpm virtual store only when its store forces copies": the FileSystem spy also records lstat calls (one added line) | ruling 5 | upstream e9eb473d52 swaps readLink plus stat for one fs.lstat |
| ChannelUnlinkedAccess.test.ts "never shows them the owner's other threads" (bf113e026a): picks the guest by a "who" field starting with "unlinked:" in place of .at(-1) (ChannelUnlinkedAccess.test.ts:302), adds `assert.isDefined(guest)` and checks `owner?.who === "owner"`. Failed before, 15/15 after. | "ChannelUnlinkedAccess rule 3 authorisation (verbatim)" | The test is not an auth failure, only a different order. The logged inputs (n3-cua-evidence.txt) show the guest, unlinked:slack-1:U9 with scopes [orchestration:operate], got titles []. The owner, with scopes [orchestration:read, orchestration:operate, settings:write], got ["Fix the release pipeline"]. 4.1 handled the guest first, and the old .at(-1) picked the owner. Fail-first n3-cua-failfirst.log: `AssertionError: expected [ 'Fix the release pipeline' ] to deeply equal []` |
| channelSessionReceiptDelivery.test.ts "starts another receipt while eight receipt transports are hung" (5c1ab6fa2f): after `TestClock.adjust("1 second")` the test waits on a Deferred that a ChannelWake stub completes when the "last" receipt's record commits. `assert.lengthOf(sent, 9)` and the "delivered" assertion are unchanged. | "channelSessionReceiptDelivery rule 3 authorisation and part 4 decisions (verbatim)" | Failed on the port with 8 where 9 were expected, and passes after. Under Effect 4.1 the ninth send needs one more scheduler turn after the clock moves, and no time passes. Production is unaffected, because nothing there asserts on a turn count. The wait is exact: only a settled receipt wakes, after its commit (ChannelDeliveryWorker.ts:458); the ledger wakes only on expiry (channelDeliveryLedger.ts:233), which cannot happen at 1 s; and hung sends time out at 4 s, so a record at 1 s proves the ninth did not wait for them. Fail-first n3-csrd-failfirst.log: `AssertionError: expected [ 'hung-0', 'hung-1', 'hung-2', …(5) ] to have a length of 9 but got 8` |

## Catch semantics in Effect 4.1.3 (coordinator item 6a)

Effect 4.1.3 lets defects win over typed failures. When a cause mixes a failure and a defect, every typed recovery (catch, catchIf, catchTag, catchTags, orElseSucceed, match, option, result, ignore, retry) now treats it as unrecoverable and rewrites each failure into a defect. Cause-level APIs (catchCause, catchCauseIf, Effect.exit, Cause.squash, Cause.findError, Cause.hasInterruptsOnly, tapError) are unchanged. Such causes arise when a finalizer dies after a typed failure, or from raceAll. The read-only audit (n3-catch-audit.md, run at 65a69a24cb) checked every site the coordinator named. It found one change with a confirmed producer in GOAT, one smaller adapter case, and no path by which the change can take down the server or stop the effect worker's or channel worker's run loops.

The version table and truth table, verbatim from the audit:

> #### 1. The change in Effect (file:line, both versions)
>
> Cause.ts is byte-identical between 4.0.5 and 4.1.3 (diff is empty), so Cause.squash (Cause.ts:889), hasInterruptsOnly (:648), findError (:971), findErrorOption (:997), hasDies and hasFails behave the same. Everything below is in src/internal/effect.ts unless named.
>
> New in 4.1.3:
> - causeElectDefects, effect.ts:177-191 (4.1.3): if a cause has a Die and a Fail, every Fail that is not a Done becomes Die(error, annotations). Order is preserved.
> - findRecoverableError, effect.ts:193-200 (4.1.3): hasDies ? fail(causeElectDefects(cause)) : findError(cause). Interrupts do not block typed recovery.
>
> Swapped from findError, cause.reasons.find(isFailReason) or findFail to findRecoverableError (4.0.5 line → 4.1.3 line):
> - Effect.catch (catch_): 2685 → 2768. orElseSucceed (3411 → 3494), orDie (3406 → 3489), firstSuccessOf and eventually all go through catch_.
> - catchIf: 2917 → 3000. catchTag (2961 → 3044) and catchReason (3120 → 3203) go through catchIf.
> - catchFilter: 2950 → 3033. catchTags (3042 → 3125) goes through catchFilter.
> - catchEager: 1956 → 2043.
> - match (MatchImpl): 3620 → 3713. option (3529 → 3622) uses match.
> - matchEffect: 3684 → 3777. flip (1547 → 1621) uses matchEffect.
> - matchEager: 3741 → 3834. result (3534 → 3627) uses matchEager.
> - ignore with log: findFail at 3480 → findRecoverableError at 3573. ignore without log uses matchEffect, so it changes too.
> - retry/retryOrElse/repeatOrElse: internal/schedule.ts. 4.0.5 used findErrorOnly at :13-14, which retried only if *every* reason was Fail; 4.1.3 uses findRecoverableError at :43 and :69.
> - Stream/Channel: Channel.catch uses Cause.findError at Channel.ts:6365 (4.0.5) and findRecoverableError at Channel.ts:6406 (4.1.3); Channel retry is at :8290 (4.1.3).
>
> mapError and mapBoth now map all Fails and keep everything else:
> - mapError: catch_(self, e => failSync(f(e))) at 3384 → catchCause(self, c => failCause(causeMap(c, f))) at 3467.
> - mapBoth: 3401 → 3484.
> - Exit.mapError and Exit.mapBoth: 2053 → 2140 and 2075 → 2160.
> - 4.0.5 **dropped** the Die and Interrupt reasons of a mixed cause; 4.1.3 keeps them. Exit.ts docs (:956) say the same thing.
>
> Cause producers that now elect defects:
> - combineFinalizerCause: 3976-3980 → 4069-4075. Used by onExit and ensuring (OnExitImpl, 4204 → 4301), onError/onInterrupt (1204 → 1270), acquireRelease and addFinalizer (scope finalizers run through this path), and Effect.scoped.
> - raceAll when every racer fails: 1643 → 1717. raceFirst is unaffected.
> - forEach/all concurrent when an interrupted sibling leaves non-interrupt reasons: 5145 → 5242.
>
> Unchanged: catchCause (2591/2674), catchCauseIf (2618/2701), catchCauseFilter, tapError (findError at 2802/2885, so it still taps a raw mixed cause), Effect.exit (3780/3873), causeSquash (262/290: first Fail, else first Die), hasInterruptsOnly (219/247).
>
> Type-only: Exit.hasDies, hasFails and hasInterrupts are no longer type guards (Exit.ts:466/497/528). GOAT has one non-test use, Exit.hasInterrupts at packages/shared/src/nodeSqliteClient.ts:1179, which is boolean use only.
>
> Effect 4 has no Sequential/Parallel cause nodes: a Cause is a flat list of reasons. "Sequential" mixed causes come from finalizers; "parallel" ones come from raceAll or forEach. Both are covered by the producer rows below.
>
> #### 2. Truth table (measured, /tmp/n3-catch/tt.mjs run on each version; e = {_tag:"E"}, d = {_tag:"D"})
>
> | cause → | Fail+Die (either order) | Fail+Int | Die only | Fail only | Int only |
> |---|---|---|---|---|---|
> | catch / catchIf / catchTag / catchTags / orElseSucceed | 4.0.5: recovered. **4.1.3: FC[Die(e),Die(d)]** | recovered (both) | Die passes (both) | recovered (both) | Int passes (both) |
> | match / matchEffect / option / result / ignore / ignore{log} | 4.0.5: recovered. **4.1.3: FC[Die,Die]** | recovered (both) | passes (both) | recovered (both) | passes (both) |
> | orDie | 4.0.5: FC[Die(e)] (d lost). 4.1.3: FC[Die(e),Die(d)] | FC[Die(e)] (both) | same | Die(e) | Int |
> | mapError / Exit.mapError | 4.0.5: FC[Fail(M)] (**d dropped**). 4.1.3: FC[Fail(M),Die(d)] | 4.0.5: FC[Fail(M)] (Int dropped). 4.1.3: FC[Fail(M),Int] | unchanged | Fail(M) | Int |
> | retry(times 1) | both: not retried; 4.1.3 also elects | **4.0.5: not retried (1 attempt). 4.1.3: retried (2 attempts)** | not retried | retried | not retried |
> | tapError | taps (both) | taps | no tap | taps | no tap |
> | catchCause / catchCauseIf(!hasInterruptsOnly) | caught (both) | caught | caught | caught | catchCause catches; catchCauseIf passes |
> | Cause.findError / squash / hasInterruptsOnly | Success(e) / e / false (both) | same | Failure / d / false | e | Failure / Error / true |
>
> Producer rows (what a later Effect.catch sees):
>
> | producer | 4.0.5 cause → catch | 4.1.3 cause → catch |
> |---|---|---|
> | acquireRelease, addFinalizer, ensuring, onExit with dying finalizer after Fail | [Fail(e),Die(d)] → recovered | [Die(e),Die(d)] → **escapes** |
> | raceAll(fail, die) | [Fail,Die] → recovered | [Die,Die] → **escapes** |
> | Effect.all / forEach concurrent (fail, die) | [Fail] (sibling interrupted first) → recovered | same |
> | **GOAT nodeSqliteClient withTransaction + SQLITE_FULL** (/tmp/n3-catch/goatsqlite*.mts, real GOAT client) | [Fail(SqlError),Die(SqlError "no transaction")] → recovered | **[Die,Die] → escapes** |
>
> Squash after election is unchanged when the Fail came first, because Die(e) carries the same e. It changes from e to d only when the Die reason came first in the original cause.

The full site list from the audit (n3-catch-audit.md section 3). SAME = no observable change. CHANGED-HARMLESS = changes, but a backstop handles it or the cost is negligible; the reason is in the last column.

| area | site (path:line) | verdict | reason |
|---|---|---|---|
| Last-resort handlers and guardErrors | packages/shared/src/errorGuards.ts:9-27 | SAME | Raw Node 'error' listeners; no Effect is involved. |
|  | packages/shared/src/processErrorNet.ts:138, :146 (unhandledRejection, uncaughtException) | SAME | No Effect catch combinators. |
|  | apps/server/src/bin.ts:29-45, apps/server/src/binMain.ts:5-79 | SAME | Plain async dispatch. An elected defect ends its fiber and the runtime reports it; it never becomes an uncaughtException, on either version. |
| Effect worker and outbox settlement | apps/server/src/orchestration-v2/EffectWorker.ts:761, :817 (Effect.exit on claim and execution), :674-745 (requeue/terminalize on Cause.hasInterruptsOnly), :809, :841, :861, :886, :890, :901 (Effect.onError requeueClaim/terminalizeClaim); apps/server/src/orchestration-v2/EffectWorkerDaemon.ts:57, :94 (catchCause) | SAME | Settlement is cause-level. An elected defect from executor.execute is settled exactly like a failure: retry or fail, with Cause.pretty text. |
|  | apps/server/src/orchestration-v2/EffectWorker.ts:104, :125, :143, :160, :240, :361, :408, :454, :499, :522, :538, :555, :573 (mapError to OrchestrationEffectExecutionError); apps/server/src/orchestration-v2/EffectOutbox.ts:316-848 (mapErrors); apps/server/src/orchestration-v2/ProviderSessionManager.ts:2351 (ingest mapError); apps/server/src/mcp/McpHttpServer.ts:787 (ToolDispatch mapError) | CHANGED-HARMLESS | 4.0.5 dropped the Die of a mixed cause and 4.1.3 keeps it, so the stored error text gets longer (and a nested goat_call keeps the defect). isNonRetryableProviderTurnControlFailure (apps/server/src/orchestration-v2/EffectWorker.ts:206, :875) still finds the typed text inside Cause.pretty. |
|  | apps/server/src/orchestration-v2/EffectWorker.ts:198, :202 (unresponsive stop recovered to success), :279 (steer turnCompleted), :346 (catchTags disabled instance) | CHANGED-HARMLESS | A mixed cause is no longer recovered, so the effect is retried or failed instead of settled as success. It needs a dying finalizer in the same failing path; no effect is lost and the worker does not die. |
|  | apps/server/src/orchestration-v2/goat/EffectExecution.ts:21-45 (hasCloudTrackingFailure, workspaceLeaseBusy) | CHANGED-HARMLESS | These look only at Fail reasons. After an election, a lease-busy start counts as a real failure (attempt consumed, backoff) instead of a refunded retry. Same precondition as above. |
|  | apps/server/src/orchestration-v2/EffectWorker.ts:485 (rollback message via Cause.findErrorOption) | CHANGED-HARMLESS | After an election the message falls back to the generic ROLLBACK_FAILED_MESSAGE. |
|  | apps/server/src/orchestration-v2/EffectOutbox.ts:861 (prune worker: Effect.catch, then Effect.repeat) | CHANGED-HARMLESS | A mixed cause would now end the hourly prune fiber, but pruneSettled (:830-848) is autocommit DELETE batches with no finalizer, so nothing produces one. A Die-only cause already ended it on 4.0.5. |
| ProviderSessionManager | apps/server/src/orchestration-v2/ProviderSessionManager.ts:2370-2405 (event pump failure) | SAME | Effect.exit plus hasInterruptsOnly, then makeProviderFailure (packages/provider-core/src/server/failure.ts:100 squashes). Squash picks the same value whenever the typed failure came first. |
|  | apps/server/src/orchestration-v2/ProviderSessionManager.ts:1022-1053 (release-record retry) | SAME | Every non-interrupt cause is turned into a Fail before the retry. |
|  | apps/server/src/orchestration-v2/ProviderSessionManager.ts:1055-1065 (logReleaseFailure) | SAME | catchCause. |
|  | apps/server/src/orchestration-v2/ProviderSessionManager.ts:2585-2745 (session open: onError cleanup, then mapError(openError)) | CHANGED-HARMLESS | If a scope finalizer dies after a typed open failure, the failure becomes Die-only and openError no longer wraps it. The effect worker's Effect.exit path settles it the same way, with different text. |
|  | apps/server/src/orchestration-v2/ProviderSessionManager.ts:293, :546, :1817, :2852 (orElseSucceed); :333, :1888, :2523 (catch); :440, :2863 (option): read fallbacks | CHANGED-HARMLESS | The only producer is a transactional read under storage failure, which f6d1b15898 removes. Before that fix the read died instead of defaulting, for example withholding environment tools at :333. Low cost. |
| Adapters' ingest and start failure | apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:673-693 (onError cleanup: SDK disposal) | FIXED in 9ac4aa0688 | A typed open failure (for example ClaudeMcpRegistrationTimeoutError at :644) plus a dying disposal was elected into a defect, so ProviderTurnStartService.ts:1328 tapError(refusedBeforePrompt) did not run. The disposal failure is now logged (apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:688-694). |
|  | apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts:696 (process-exit-timeout cleanup, Effect.orDie) | kept on purpose (known limit) | It blocks the retry and is pinned by "only retries after confirmed process exit" (ClaudeAgentSdkQueryRunner.test.ts:297). What the user sees in that double fault is described below the table. |
|  | apps/server/src/orchestration-v2/goat/SessionReceiptHold.ts:325 (finalizer found by the heuristic scan) | SAME | close is Effect<void>, so there is no Fail to elect. |
| RunExecutionService | apps/server/src/orchestration-v2/RunExecutionService.ts:828, :847-862, :1442-1443, :1586-1735, :1619, :1647, :2016-2059 (catchCause / catchCauseIf(!hasInterruptsOnly) handlers) | SAME | catchCause, catchCauseIf, hasInterruptsOnly and Cause.squash are unchanged. |
|  | apps/server/src/orchestration-v2/RunExecutionService.ts:1705-1728 (final-write retry) | SAME | Every non-interrupt cause becomes Fail(cause) before Effect.retry, so the new Fail+Interrupt retry rule cannot apply. |
|  | apps/server/src/orchestration-v2/RunExecutionService.ts:1593, :1687, :862, :2041, :2059 (Cause.squash) | SAME in practice | Same value whenever the typed failure came first, which is the order combineFinalizerCause produces. The terminationCause or message could differ only for a parallel cause where the defect arrived first. |
|  | apps/server/src/orchestration-v2/RunExecutionService.ts:1600 (workspaceHandedOff.pipe(Effect.orElseSucceed(() => false)) inside the forkDetach'd provider event fiber's handler) | CHANGED-HARMLESS | On a mixed cause the handler would now die, and the run would not be finalized until restart recovery. There is no known producer except a transaction under storage failure, which f6d1b15898 removes. A Die-only cause already did this on 4.0.5. |
|  | apps/server/src/orchestration-v2/RunExecutionService.ts:1759, :1777, :1966 (Effect.catch around MCP app context, report inbox reads and consume) | CHANGED-HARMLESS | Only storage-failure producers reach them (removed by f6d1b15898); the run then fails start instead of proceeding with empty lists. Low cost. |
| Channel delivery worker | apps/server/src/channels/ChannelDeliveryWorker.ts:325-328 (settle: ledger.recordDelivery(...).pipe(Effect.result); recordDelivery is withTransaction plus mapError, apps/server/src/channels/channelDeliveryLedger.ts:421-458) | FIXED in f6d1b15898 | Under SQLITE_FULL or IOERR the SqlError became a defect. Effect.result no longer caught it, so settle skipped its keep-and-retry branch (:311-314). The row stayed 'delivering', and a later take-back could send a GOAT or MCP destination the same message twice. |
|  | apps/server/src/channels/ChannelDeliveryWorker.ts:235 (tryRelease), :190 (reconcile, catchCause at :206), :376 (retrySettles), :406 (take-back scan) | FIXED in f6d1b15898 (same producer) | The release loop fiber died (the next holdForRelease restarted it), and reconcile stopped early instead of continuing. |
|  | apps/server/src/channels/ChannelDeliveryWorker.ts:295 (handOver) | SAME | catchCause. |
|  | apps/server/src/channels/ChannelDeliveryWorker.ts:439, :495-496 (Effect.ignore after tapCause) | CHANGED-HARMLESS | The forked fiber ends with a defect instead of void. The cause is already logged, and the ensuring cleanup still runs. |
|  | apps/server/src/channels/ChannelDeliveryWorker.ts:448, :532 (gateway.send(...).pipe(Effect.result)) | CHANGED-HARMLESS | The Slack and iMessage send paths have no finalizers, so nothing produces a mixed cause. |
|  | apps/server/src/channels/ChannelRuntime.ts:452-454 (runPass catchCause) | SAME | The backstop that logs an escaped defect and keeps the channel loop running. |
| MCP transport error mapping | apps/server/src/mcp/registrationContext.ts:26-45 | SAME | Only updates context. |
|  | apps/server/src/mcp/McpHttpServer.ts:693 (analytics onExit) | SAME | The finalizer forks detached and cannot die. |
|  | apps/server/src/mcp/McpHttpServer.ts:539, :591, :622 (matchEffect, orElseSucceed) | SAME in practice | Reads with no finalizer, so nothing produces a mixed cause. |
|  | Effect's toolkit "return" mode (effect/ai/Toolkit.ts:563-578 in 4.1.3 vs :450-457 in 4.0.5; McpServer.handleCause, effect/ai/McpServer.ts:3288-3352), which reaches the 39 typed recoveries in 14 files under apps/server/src/mcp/toolkits | CHANGED-HARMLESS | A tool handler whose cause is mixed no longer returns its declared failure as an isError payload. It goes to internalToolError, which logs, reports and returns the generic internal tool error. The agent sees "internal error" instead of the typed refusal, and the defect is now visible. No crash. |
| Confirmed producer | packages/shared/src/nodeSqliteClient.ts:1255-1268 (ROLLBACK after SQLite already rolled back; no isTransaction) | FIXED in f6d1b15898 | The source of the mixed causes behind the channel worker rows and the storage-failure rows above, and of the same change at all 159 withTransaction call sites in apps/server. |

The two fixes, each test-first:

| fix | what changed | user impact before the fix | test and fail-first |
|---|---|---|---|
| f6d1b15898 fix(shared): a write SQLite already rolled back fails with its SqlError again | On SQLITE_FULL and similar errors SQLite rolls the transaction back by itself, so GOAT's ROLLBACK (packages/shared/src/nodeSqliteClient.ts, which passes no isTransaction) finds no transaction and fails. Effect orDie's that failure, and 4.1 elects the write's SqlError into a defect. toleratingFinishedRollback (packages/shared/src/nodeSqliteErrors.ts) wraps the transaction acquirer (nodeSqliteClient.ts:1260, `transactionAcquirer: Effect.map(transactionAcquirer, toleratingFinishedRollback)`), so a ROLLBACK that finds no transaction succeeds, as in Effect's own pool (SqlClient.ts:476-485). | Under storage failure, every withTransaction caller (159 call sites in apps/server) lost its typed failure path. The worst case was the channel delivery worker sending a GOAT or MCP destination the same message twice. | packages/shared/src/nodeSqliteRollback.test.ts "a transaction SQLite already rolled back fails with its SqlError, which catch recovers". Fail-first n3-rollback-failfirst.log: the write's SqlError was not recoverable (`effect/sql/SqlError: Failed to execute statement`, cause `database or disk is full`), and the cause also carried `cannot rollback - no transaction is active`. |
| 9ac4aa0688 fix(server): a failed Claude query open keeps its typed error when disposal also fails | ClaudeAgentSdkQueryRunner.ts:688-694: a failed SDK disposal (queryRuntime[Symbol.asyncDispose]) is logged with `Effect.ignore({ log: true })` in place of Effect.orDie. | A refused Claude turn whose disposal also failed lost its typed error, so the unsent context handoffs for that turn were not restored, and the effect worker could no longer classify the refusal. | New test in ClaudeAgentSdkQueryRunner.test.ts:410 "a failed open keeps its typed error when the query's disposal also fails". Fail-first n3-claude-failfirst.log: ClaudeMcpRegistrationTimeoutError escaped as a defect (`ClaudeAgentSdkQueryRunnerError: Claude Agent SDK query failed.`, caused by ClaudeMcpRegistrationTimeoutError). |

Known limit: the process-exit-timeout cleanup in the same runner (ClaudeAgentSdkQueryRunner.ts:696) still ends in Effect.orDie on purpose. It is what blocks the retry, pinned by the existing test "only retries after confirmed process exit" (ClaudeAgentSdkQueryRunner.test.ts:297). Under 4.1 the typed open failure is elected into a defect in that case, so ProviderTurnStartService.ts:1328 refusedBeforePrompt does not run. What the user sees in that double fault: a Claude turn whose open fails with a typed error (for example an MCP registration timeout) while the Claude CLI also does not exit within 10 s is recorded as a failure from a defect instead of the typed refusal. The context handoffs that turn was carrying are therefore not restored, and the next turn starts without them. The turn itself still fails and the CLI is killed; nothing else is lost. Also from the audit: an MCP toolkit in "return" mode with a mixed cause now answers "internal error" instead of the typed refusal, with no crash.

The audit's stated limits, verbatim:

> #### 5. What was checked and what this search cannot bound
>
> - Effect: full diff of internal/effect.ts (523 diff lines), Cause.ts (identical), Exit.ts, internal/schedule.ts, Channel.ts, ai/Toolkit.ts and ai/McpServer.ts (error-path hunks), and sql/SqlClient.ts (transaction cleanup). The truth table comes from a run, not from reading.
> - GOAT named files: every line matching typed recovery, cause-level, and finalizer patterns in EffectWorker.ts, EffectWorkerDaemon.ts, EffectOutbox.ts, ProviderSessionManager.ts, RunExecutionService.ts, ChannelDeliveryWorker.ts, McpHttpServer.ts, registrationContext.ts, errorGuards.ts, processErrorNet.ts, bin.ts and binMain.ts was read, with the producer path traced where a mixed cause was possible.
> - **Not bounded:** the repo has 7,238 typed-recovery calls in 1,184 non-test files (rg over apps/server/src and packages) and 792 finalizer sites (ensuring, onExit, onError, acquireRelease, addFinalizer, Stream.ensuring/onExit). A site changes only if its inner effect can produce Fail plus Die.
>   - Heuristic scan for finalizers containing orDie, die or throw within 6 lines: 9 hits. The orchestration ones are ClaudeAgentSdkQueryRunner.ts:687 (reported above) and SessionReceiptHold.ts:325, which is SAME because close is Effect<void> and has no Fail to elect.
>   - Implicit producers (a finalizer calling a service that dies, sync code that throws, raceAll; there are 5 Effect.race/raceAll calls in non-test server and packages code, not traced) cannot be found by search.
>   - The SQLite rollback producer affects all 159 withTransaction call sites in apps/server (rg count), but only under storage errors that make SQLite roll back on its own.
>   - Long-lived loops that end on an escaped defect: 128 forever/repeat sites; 29 have only typed recovery within 10 lines (/tmp/n3-catch/loops.cjs lists them, for example HubProxySessions.ts:700, ProcessGroupMetrics.ts:141, MemoryCompactor.ts:215, PlacementAdmission.ts:113/119/200). Each one now also stops on a mixed cause, and in practice that means the SQLite producer. Option 1 above removes that trigger for all of them.
>
> NOT RUN: vp test, typecheck, or anything inside the worktree, per the brief. The experiments ran from /tmp/n3-catch and loaded the store copies of effect plus GOAT's nodeSqliteClient.ts read-only.

## Channel order finding

Conversations run concurrently by design (ChannelRuntime.ts:134-156), and their relative order was never a contract. Order inside one conversation is enforced by the ledger (ChannelLedger.ts:1001-1014), and ChannelScenarios.test.ts:708 passes on 4.1 (n3-inorder.log: 1 passed). Two people writing at the same moment in different conversations may be answered in the other relative order.

How it was found: ChannelRuntime forks one fiber per input under a 4-slot semaphore (ChannelRuntime.ts:60, :107, :139). Only the owner's GOAT-origin input runs timeline.record (ChannelReceptionService.ts:891-902, then ChannelBotTimeline.ts:48-55, an orchestrator.dispatch of channel.timeline.record). While that is in flight, the Slack guest runs beginReception through listConversationTasks (:854-915) and takes the lead. The semaphore was ruled out on both versions: without it, 4.0.5 is still owner-first and 4.1 still guest-first. One yieldNow before a reception brings back the 4.0 order on 4.1. The exact Effect primitive inside the dispatch path was not pinned; 4.1 rewrote Semaphore acquisition, TestClock and the Queue offer paths. Inside one conversation, listReceivableInputs offers only each conversation's oldest input (ROW_NUMBER PARTITION BY conversation_id; ChannelRuntime.ts:275-283).

## Fail-first logs

| log | test | the assertion line |
|---|---|---|
| n3-l136-failfirst.log | bootService.test.ts "rejects an unloadable home before changing an installed service" (with upstream's assertion, before the getter) | `AssertionError: expected undefined to be 'systemd cannot run GOAT from "/privat…' // Object.is equality` |
| n3-l239-failfirst-macos.log | NonBlockingSpawner.test.ts without the spawner: "hands the native spawner only env…" and "checks at most two paths at once, however many directories hang" | `AssertionError: expected [ [ 'true', …(1) ], …(6) ] to deeply equal [ [ '/usr/bin/env', undefined ], …(5) ]`; and `Error: Test timed out in 120000ms.` (the freeze) |
| n3-finite-failfirst.log | CodexAppServerExit.test.ts "a request after its session closed fails with the client's error, not an interrupt" | `Error: All fibers interrupted without error` |
| n3-acp-failfirst.log | AcpClosedSessionStop.test.ts "a Stop sent after its ACP session closed gets an outcome, not a bare interrupt" | `AssertionError: expected true to be false` |
| n3-surv-failfirst.log | CodexSurvivorContinuation.test.ts "a survivor adopted after its session closed still settles the wait session loss awaits" | `AssertionError: expected false to be true` |
| n3-cua-failfirst.log | ChannelUnlinkedAccess.test.ts "never shows them the owner's other threads" | `AssertionError: expected [ 'Fix the release pipeline' ] to deeply equal []` |
| n3-rollback-failfirst.log | packages/shared nodeSqliteRollback.test.ts "a transaction SQLite already rolled back fails with its SqlError, which catch recovers" | `effect/sql/SqlError: Failed to execute statement` escaped typed catch; the cause also carried `Error: cannot rollback - no transaction is active` |
| n3-claude-failfirst.log | ClaudeAgentSdkQueryRunner.test.ts "a failed open keeps its typed error when the query's disposal also fails" | `ClaudeAgentSdkQueryRunnerError: Claude Agent SDK query failed.` caused by `ClaudeMcpRegistrationTimeoutError`, which escaped as a defect |
| n3-csrd-failfirst.log | channelSessionReceiptDelivery.test.ts "starts another receipt while eight receipt transports are hung" | `AssertionError: expected [ 'hung-0', 'hung-1', 'hung-2', …(5) ] to have a length of 9 but got 8` |

L239: NonBlockingSpawner.test.ts runs only on Linux (describe.skipIf), and no Linux host was available. The fail-first therefore ran on macOS with both Linux gates lifted in the working tree only, never committed; macOS /usr/bin/env takes -C. With the spawner, the hung-directory test passes, and on macOS the env-only test sees 5 of the 6 commands handed to env (n3-l239-pass-macos.log: `expected [ [ '/usr/bin/env', undefined ], …(4) ] to deeply equal [ [ '/usr/bin/env', undefined ], …(5) ]`), because one command differs on darwin. The hosted CI run is where the test really runs. L236 and aa58dc6d22 change no behaviour that a new test could pin, and upstream added no test.

## Pre-existing failures

These fail at the baseline 44d7d60d20 on Effect 4.0.5 on the same Mac, or are known issues. None blocks N3.

| issue | what fails | notes |
|---|---|---|
| goat#3238 | apps/server cli/app.test.ts, 4 tests ("resolves relative cwd/flag/env/bootstrap against the inaccessible original cwd") | The serverCwd fixture hangs. In each gate run, only the hung fixture processes descended from that gate's own root were stopped, confirmed through their ppid chain (n3-gate-stops.txt). In gate 5 those were PID 61872 (relative-flag), 66996 (relative-env) and 72288 (relative-bootstrap), all under root 92942. |
| goat#3363 | packages/ssh runtimeFactsScripts.test.ts "reads a built runner in one call and parses only the lines before its end line" | fails at the baseline |
| goat#3425 | GrokTextGeneration.test.ts, 16 tests, "Grok ACP request failed" | the fake CLI says "exec: node: not found"; the same 16 fail at the baseline |
| goat#3403 | packages/ssh launchListenerScripts.test.ts (Windows PowerShell wait) | passes at the baseline and in an isolated run on N3; fails under gate load |
| [goat#3590](https://github.com/goat-si/goat/issues/3590) (new, filed by N3) | apps/server/src/opencodex/OpenCodexChildBootstrap.ts:850 | Found by the fork audit, not by a test. An ensuring forks releaseAdmission (sshDispatch.revokeChildSetupSessions, :323-327) into serviceScope. When shutdown interrupts an in-flight readiness check, the revoke never runs, so a Child setup session minted for that check is not revoked. Same on 4.0.5 and 4.1.3; forkDetach is the likely fix. |

## Native fingerprint

The fingerprint does not move. At the N3 head before the final merge: ios 8564b56fd13c1993bd87c435a085a68bcc431c18, android 778f85bc12629118ebc336308a97584294a440c2. None of the 28 fingerprint file and directory inputs, and no native package version, changed from dev c66dc0f1fd: the lockfile moves only the effect and alchemy families, expo-sqlite stays at 58.0.13, and apps/mobile/package.json is unchanged. Confirmed on the merged head 9ac4aa0688 with the same expo fingerprint call scripts/mobile-native-client.ts uses: ios 8564b56fd13c1993bd87c435a085a68bcc431c18, android ed49dd54bfdbaa8565dd1af1a69d0f1ec8ab09fc, identical to the integration head 5c798a3072 computed the same way (the android hash differs from the earlier N3-only value because the integration head and dev moved native inputs; N3 itself moves nothing). No native rebuild is needed for N3.

## Surfaces

| surface | outcome |
|---|---|
| Entry points | no UI change; nothing is reachable from a new place |
| Web client | apps/web cloud/dpop.ts and managedRelayLayer.ts adapted for the 4.1 crypto layer; no visible change |
| Desktop | 13 files adapted (main process and tests), 15 mechanical; no visible change |
| Mobile | apps/mobile cloud/dpop.ts, dpop.test.ts, managedRelayLayer.ts and scripts/measure-renders.mts adapted (JavaScript only); native fingerprint unchanged |
| Providers | Codex: closed-scope request (0728a1e058) and survivor adoption (ffbce8a8fa). ACP adapter, which Grok, fx, ACP-registry and other ACP agents share: Stop after close (ffbce8a8fa). Claude and Muse: the L239 parts were already in GOAT (#2533, #3260). Claude: a failed open keeps its typed error when disposal also fails (9ac4aa0688). OpenCode, Cursor, Pi, Antigravity and the cloud providers: mechanical 4.1 adaptations only. |
| Agents (MCP) | registration context (373b22790b) and in-process MCP (f8eeb86c21); tool schemas unchanged (agent surface audit and context budget checks pass). A toolkit handler in "return" mode whose cause mixes a failure and a defect now answers "internal error" instead of its typed refusal (catch section). |
| Storage | node:sqlite transactions SQLite already rolled back fail with their SqlError again (f6d1b15898) |
| Settings | none |
| Contracts | N3 changes no packages/contracts file; the merged lanes' contract changes come from next |
| Reverse states | none added |
| Connection modes | L239 changes how the server spawns processes on Linux, including SSH and remote work. The relay and task-cache infra move to alchemy beta.85 but are not deployed. |
| Docs | docs/operations/release.md drops the #1832 forced-deploy warning, with evidence; no user guide changes |

## Known limits

- The fork audit judged the 235 plain forkIn and 250 plain forkScoped sites (485 in all) from the version semantics, without reading each one. Its finalizer scan can miss a helper that forks inside a called function (stated limits quoted under audit (c)).
- The channel order change is explained, but not pinned to one Effect function inside the dispatch path.
- NonBlockingSpawner's tests run only on Linux. Their fail-first ran on macOS with the gates lifted, so the hosted CI run is the real proof.
- The relay PostgreSQL fixture cannot start on pen-mac-studio (pg_ctl: could not start server). Those tests must pass in the manual full CI run.
- Three transitive lockfile versions are newer than upstream's (lockfile section).
- Two fork-audit sites marked OK are left as they are: client-runtime registry.ts:890 (optional guard at runtime disposal) and ProviderRegistry.ts:903, whose comments overstate the guarantee on 4.1. Neither changes in this lane.
- forkInScope's interrupt cause carries no interruptor id, where 4.0.5 passed parent.id.
- Claude query runner: the process-exit-timeout cleanup (ClaudeAgentSdkQueryRunner.ts:696) still ends in Effect.orDie on purpose, because it blocks the retry (pinned by "only retries after confirmed process exit", ClaudeAgentSdkQueryRunner.test.ts:297). Under 4.1, ProviderTurnStartService.ts:1328 refusedBeforePrompt then does not run. What the user sees in that double fault: a Claude turn whose open fails with a typed error (for example an MCP registration timeout) while the Claude CLI also does not exit within 10 s is recorded as a failure from a defect instead of the typed refusal. The context handoffs that turn was carrying are therefore not restored, and the next turn starts without them. The turn itself still fails and the CLI is killed; nothing else is lost.
- MCP toolkit "return" mode: a handler whose cause mixes a failure and a defect now answers "internal error" instead of the typed refusal. It does not crash. This is Effect's own Toolkit path (effect/ai/Toolkit.ts:563-578 in 4.1.3).
- The catch-semantics audit cannot be bounded by search: 7,238 typed-recovery calls and 792 finalizer sites (its stated limits are quoted in the catch section).

## Infra tests on pen-mac-studio (before the final gate)

relay typecheck 0 errors and task-cache typecheck 0 errors. `ALCHEMY_TEST_DEV=true vp run --filter goat-relay test`: 62 files and 390 tests passed. task-cache: 11 files and 42 tests passed. The relay PostgreSQL fixture did not run (NOT RUN below).

## Merge with the integration head and dev

65a69a24cb merges origin/chase/t3-261114-next at 5c798a3072, the head the coordinator named and froze. 89d6b2d024 then merges origin/dev at 1d41f2c97f. A trial merge showed conflicts only in pnpm-lock.yaml and oxlint-plugin-goat/code-budgets.json.

Lockfile: no hunks were hand-picked. The lockfile was regenerated with vp i from the merged manifests (package.json files, pnpm-workspace.yaml, patches). A scripted comparison of resolved versions shows that the result keeps both sides and that nothing else moved: merged == N3 − (base − next) + (next − base), exactly. The effect, @effect, alchemy, @alchemy.run and @distilled.cloud versions stay equal to upstream's lockfile at the commits N3 ports, and the @effect/sql-d1 override stays at 4.1.1. From lane N9b, jsonc-parser 3.3.1 stays under packages/provider-cursor and the @cursor/sdk patch hash 57f502128bf6… comes through. `vp i --frozen-lockfile` exits 0 afterwards. The comparison (n3-lockcmp-merge.txt), verbatim:

<details>
<summary>Scripted lockfile comparison (merged, ours = N3 head, theirs = 5c798a3072)</summary>

```text
merged vs ours(N3 HEAD): added ["@betteroffice/docx@0.5.1","@betteroffice/fonts-cjk@0.4.0","@betteroffice/pptx@0.5.1","@betteroffice/xlsx@0.5.1"]
merged vs ours(N3 HEAD): removed ["@betteroffice/docx@0.4.3","@betteroffice/pptx@0.2.0","@betteroffice/xlsx@0.3.0"]
merged vs theirs(5c798a3072): added ["@alchemy.run/acme@2.0.0-beta.85","@alchemy.run/axiom@2.0.0-beta.85","@alchemy.run/cloudflare-runtime@2.0.0-beta.85","@alchemy.run/cloudflare@2.0.0-beta.85","@alchemy.run/docker@2.0.0-beta.85","@alchemy.run/drizzle@2.0.0-beta.85","@alchemy.run/node-utils@2.0.0-beta.85","@alchemy.run/planetscale@2.0.0-beta.85","@alchemy.run/sql@2.0.0-beta.85","@alchemy.run/test@2.0.0-beta.85","@cloudflare/workerd-darwin-64@1.20261026.1","@cloudflare/workerd-darwin-arm64@1.20261026.1","@cloudflare/workerd-linux-64@1.20261026.1","@cloudflare/workerd-linux-arm64@1.20261026.1","@cloudflare/workerd-windows-64@1.20261026.1","@cloudflare/workers-types@5.20261115.1","@distilled.cloud/acme@1.0.0-rc.18","@distilled.cloud/aws4signer@1.0.0-rc.18","@distilled.cloud/aws@1.0.0-rc.18","@distilled.cloud/axiom@1.0.0-rc.18","@distilled.cloud/cloudflare@1.0.0-rc.18","@distilled.cloud/core@1.0.0-rc.18","@distilled.cloud/iceberg@1.0.0-rc.18","@distilled.cloud/planetscale@1.0.0-rc.18","@effect/atom-react@4.1.2","@effect/graphql-generator@4.1.2","@effect/openapi-generator@4.1.2","@effect/platform-bun@4.1.2","@effect/platform-node-shared@4.1.2","@effect/platform-node@4.1.2","@effect/sql-d1@4.1.1","@effect/sql-pg@4.1.2","@effect/sql-sqlite-do@4.1.2","@effect/vitest@4.1.2","@oxc-project/types@0.153.0","@puppeteer/browsers@3.2.7","@rolldown/binding-android-arm-eabi@1.2.13","@rolldown/binding-android-arm64@1.2.13","@rolldown/binding-darwin-arm64@1.2.13","@rolldown/binding-darwin-x64@1.2.13","@rolldown/binding-freebsd-x64@1.2.13","@rolldown/binding-linux-arm-gnueabihf@1.2.13","@rolldown/binding-linux-arm64-gnu@1.2.13","@rolldown/binding-linux-arm64-musl@1.2.13","@rolldown/binding-linux-ppc64-gnu@1.2.13","@rolldown/binding-linux-s390x-gnu@1.2.13","@rolldown/binding-linux-x64-gnu@1.2.13","@rolldown/binding-linux-x64-musl@1.2.13","@rolldown/binding-openharmony-arm64@1.2.13","@rolldown/binding-win32-arm64-msvc@1.2.13","@rolldown/binding-win32-x64-msvc@1.2.13","alchemy@2.0.0-beta.85","effect@4.1.3","mime@4.1.2","modern-tar@0.8.6","rolldown@1.2.13","workerd@1.20261026.1"]
merged vs theirs(5c798a3072): removed ["@alchemy.run/cloudflare-runtime@2.0.0-beta.80","@alchemy.run/floci@2.0.0-beta.80","@alchemy.run/node-utils@2.0.0-beta.80","@aws-crypto/sha256-browser@5.2.0","@aws-crypto/sha256-js@5.2.0","@aws-crypto/supports-web-crypto@5.2.0","@aws-crypto/util@5.2.0","@aws-sdk/client-cognito-identity@3.1062.0","@aws-sdk/core@3.974.17","@aws-sdk/credential-provider-cognito-identity@3.972.41","@aws-sdk/credential-provider-env@3.972.43","@aws-sdk/credential-provider-http@3.972.45","@aws-sdk/credential-provider-ini@3.972.49","@aws-sdk/credential-provider-login@3.972.48","@aws-sdk/credential-provider-node@3.972.51","@aws-sdk/credential-provider-process@3.972.43","@aws-sdk/credential-provider-sso@3.972.48","@aws-sdk/credential-provider-web-identity@3.972.48","@aws-sdk/credential-providers@3.1062.0","@aws-sdk/nested-clients@3.997.16","@aws-sdk/signature-v4-multi-region@3.996.31","@aws-sdk/token-providers@3.1062.0","@aws-sdk/types@3.974.5","@aws-sdk/util-locate-window@3.965.5","@aws-sdk/xml-builder@3.972.27","@aws/lambda-invoke-store@0.2.4","@cloudflare/unenv-preset@2.16.1","@cloudflare/workerd-darwin-64@1.20260918.1","@cloudflare/workerd-darwin-arm64@1.20260918.1","@cloudflare/workerd-linux-64@1.20260918.1","@cloudflare/workerd-linux-arm64@1.20260918.1","@cloudflare/workerd-windows-64@1.20260918.1","@cloudflare/workers-types@5.20261004.1","@distilled.cloud/acme@1.0.0-rc.13","@distilled.cloud/aws@1.0.0-rc.13","@distilled.cloud/axiom@1.0.0-rc.13","@distilled.cloud/cloudflare@1.0.0-rc.13","@distilled.cloud/core@1.0.0-rc.13","@distilled.cloud/doppler@1.0.0-rc.13","@distilled.cloud/fly-io@1.0.0-rc.13","@distilled.cloud/gcp@1.0.0-rc.13","@distilled.cloud/hetzner@1.0.0-rc.13","@distilled.cloud/infisical@1.0.0-rc.13","@distilled.cloud/neon@1.0.0-rc.13","@distilled.cloud/planetscale@1.0.0-rc.13","@distilled.cloud/prisma@1.0.0-rc.13","@distilled.cloud/railway@1.0.0-rc.13","@distilled.cloud/stripe@1.0.0-rc.13","@distilled.cloud/zerossl@1.0.0-rc.13","@drizzle-team/brocli@0.12.0","@effect/atom-react@4.0.5","@effect/graphql-generator@4.0.5","@effect/openapi-generator@4.0.5","@effect/platform-node-shared@4.0.5","@effect/platform-node@4.0.5","@effect/sql-d1@4.0.0","@effect/sql-pg@4.0.5","@effect/sql-sqlite-bun@4.0.0-rc.112","@effect/sql-sqlite-do@4.0.5","@effect/vitest@4.0.5","@esbuild/aix-ppc64@0.25.12","@esbuild/android-arm64@0.25.12","@esbuild/android-arm@0.25.12","@esbuild/android-x64@0.25.12","@esbuild/darwin-arm64@0.25.12","@esbuild/darwin-x64@0.25.12","@esbuild/freebsd-arm64@0.25.12","@esbuild/freebsd-x64@0.25.12","@esbuild/linux-arm64@0.25.12","@esbuild/linux-arm@0.25.12","@esbuild/linux-ia32@0.25.12","@esbuild/linux-loong64@0.25.12","@esbuild/linux-mips64el@0.25.12","@esbuild/linux-ppc64@0.25.12","@esbuild/linux-riscv64@0.25.12","@esbuild/linux-s390x@0.25.12","@esbuild/linux-x64@0.25.12","@esbuild/netbsd-arm64@0.25.12","@esbuild/netbsd-x64@0.25.12","@esbuild/openbsd-arm64@0.25.12","@esbuild/openbsd-x64@0.25.12","@esbuild/openharmony-arm64@0.25.12","@esbuild/sunos-x64@0.25.12","@esbuild/win32-arm64@0.25.12","@esbuild/win32-ia32@0.25.12","@esbuild/win32-x64@0.25.12","@img/sharp-darwin-arm64@0.35.4","@img/sharp-darwin-x64@0.35.4","@img/sharp-freebsd-wasm32@0.35.4","@img/sharp-libvips-darwin-arm64@1.3.3","@img/sharp-libvips-darwin-x64@1.3.3","@img/sharp-libvips-linux-arm64@1.3.3","@img/sharp-libvips-linux-arm@1.3.3","@img/sharp-libvips-linux-ppc64@1.3.3","@img/sharp-libvips-linux-riscv64@1.3.3","@img/sharp-libvips-linux-s390x@1.3.3","@img/sharp-libvips-linux-x64@1.3.3","@img/sharp-libvips-linuxmusl-arm64@1.3.3","@img/sharp-libvips-linuxmusl-x64@1.3.3","@img/sharp-linux-arm64@0.35.4","@img/sharp-linux-arm@0.35.4","@img/sharp-linux-ppc64@0.35.4","@img/sharp-linux-riscv64@0.35.4","@img/sharp-linux-s390x@0.35.4","@img/sharp-linux-x64@0.35.4","@img/sharp-linuxmusl-arm64@0.35.4","@img/sharp-linuxmusl-x64@0.35.4","@img/sharp-wasm32@0.35.4","@img/sharp-webcontainers-wasm32@0.35.4","@img/sharp-win32-arm64@0.35.4","@img/sharp-win32-ia32@0.35.4","@img/sharp-win32-x64@0.35.4","@js-temporal/polyfill@0.5.1","@mongodb-js/saslprep@1.4.13","@neon/functions@0.11.0","@octokit/auth-token@6.0.0","@octokit/core@7.0.6","@octokit/endpoint@11.0.3","@octokit/graphql@9.0.3","@octokit/openapi-types@27.0.0","@octokit/openapi-webhooks-types@12.1.0","@octokit/plugin-paginate-rest@14.0.0","@octokit/plugin-request-log@6.0.0","@octokit/plugin-rest-endpoint-methods@17.0.0","@octokit/request-error@7.1.0","@octokit/request@10.0.10","@octokit/rest@22.0.1","@octokit/types@16.0.0","@octokit/webhooks-methods@6.0.0","@octokit/webhooks@14.2.0","@oxc-project/types@0.146.0","@puppeteer/browsers@3.2.2","@rolldown/binding-android-arm-eabi@1.2.5","@rolldown/binding-android-arm64@1.2.5","@rolldown/binding-darwin-arm64@1.2.5","@rolldown/binding-darwin-x64@1.2.5","@rolldown/binding-freebsd-x64@1.2.5","@rolldown/binding-linux-arm-gnueabihf@1.2.5","@rolldown/binding-linux-arm64-gnu@1.2.5","@rolldown/binding-linux-arm64-musl@1.2.5","@rolldown/binding-linux-ppc64-gnu@1.2.5","@rolldown/binding-linux-s390x-gnu@1.2.5","@rolldown/binding-linux-x64-gnu@1.2.5","@rolldown/binding-linux-x64-musl@1.2.5","@rolldown/binding-openharmony-arm64@1.2.5","@rolldown/binding-win32-arm64-msvc@1.2.5","@rolldown/binding-win32-x64-msvc@1.2.5","@smithy/core@3.34.1","@smithy/credential-provider-imds@4.3.8","@smithy/fetch-http-handler@5.4.6","@smithy/is-array-buffer@2.2.0","@smithy/node-http-handler@4.7.7","@smithy/signature-v4@5.4.6","@smithy/types@4.18.0","@smithy/util-buffer-from@2.2.0","@smithy/util-utf8@2.3.0","@types/aws-lambda@8.10.161","@types/webidl-conversions@7.0.3","@types/whatwg-url@11.0.5","alchemy@2.0.0-beta.80","before-after-hook@4.0.0","bowser@2.14.1","bson@6.10.4","drizzle-kit@1.0.0-rc.5-ab785fc","drizzle-orm@1.0.0-rc.5-ab785fc","effect@4.0.5","esbuild@0.25.12","graphql@16.11.0","jsbi@4.3.2","json-with-bigint@3.5.8","libsodium-wrappers@0.8.4","libsodium@0.8.4","memory-pager@1.5.0","mime@4.1.0","modern-tar@0.8.5","mongodb-connection-string-url@3.0.2","mongodb@6.21.0","rolldown@1.2.5","sharp@0.35.4","smart-buffer@4.2.0","socks@2.8.9","sparse-bitfield@3.0.3","tr46@5.1.1","universal-user-agent@7.0.3","webidl-conversions@7.0.0","whatwg-url@14.2.0","workerd@1.20260918.1"]
patch @alchemy.run/test@2.0.0-beta.85 merged=29c0539ea71d9cc372f0b16558640599beb9bc609605feb2a493da268d72713e ours=29c0539ea71d9cc372f0b16558640599beb9bc609605feb2a493da268d72713e theirs=undefined
patch @cursor/sdk@1.2.0 merged=57f502128bf6accd976963b126e227c86a45d815a53a8dc450461beae3bed4a4 ours=b9966f50182358ded9d1a72f39d9cd850f2e7471e7b8224d3d618bdbbe00e055 theirs=57f502128bf6accd976963b126e227c86a45d815a53a8dc450461beae3bed4a4
patch @effect/vitest@4.1.2 merged=299510b71c36537a832a67e9d160a5f112a5f326a29e95c41cb45fc8234e47c7 ours=299510b71c36537a832a67e9d160a5f112a5f326a29e95c41cb45fc8234e47c7 theirs=undefined
patch alchemy@2.0.0-beta.85 merged=79807d61fb0c62e47b6f4ed77d6f48a629830922126a4e059ed3b482e2f44069 ours=79807d61fb0c62e47b6f4ed77d6f48a629830922126a4e059ed3b482e2f44069 theirs=undefined
patch missing in merged: @effect/vitest@4.0.5
patch missing in merged: alchemy@2.0.0-beta.80
EXACT merged == ours - (base-theirs) + (theirs-base): extra [] missing []
```

</details>

Code budgets: node oxlint-plugin-goat/update-code-budgets.ts (exit 0) lowered the entries to real lengths, and none is raised against either parent. ThreadFeed.tsx (3388 lines) and WelcomeWizard.tsx (1654) are below both parents' entries (3473 and 1827). The provider-acp adapter.ts entry went from 8559 to 8550 after move-out 4a4e988fdb. After the dev merge, 9d98d71774 sets the entries at the merged tree's real lengths.

Typecheck: 0 errors in apps/server, apps/web, apps/mobile, packages/provider-cursor, provider-pi, provider-acp, contracts, source-control-github, source-control-core, client-runtime and shared. The merged lanes' files needed no adaptation edits.

Fork re-audit over the merged lanes (n3-forkin-reaudit-merge.txt), verbatim:

> Fork re-audit over the merged lanes (44d7d60d20..5c798a3072): 41 production files changed (list /tmp/n3-newfiles.txt). No Effect.forkIn/forkScoped with startImmediately or uninterruptible other than the fixed ACP interruptTurn site (adapter.ts:8251, forkInScope). Plain interruptible forkIn/forkScoped sites (LaunchWatchService.ts:736,:1517; ThreadManagementService.ts:1353,:1737; RemoteDispatchCoordinator.ts:1181,:1197,:1219; provider-pi adapter.ts:321,:956,:1440,:1689,:2235,:2348,:3308; Orchestrator.ts:13120; provider-cursor adapter.ts:2018; provider-acp adapter.ts:1907,:2874,:2888,:5525,:6872,:7520,:7663): SAME on 4.0.5 and 4.1.3 (a plain fork into a closed scope never ran on either). FiberMap.run RemoteDispatchCoordinator.ts:949: covered by the widened audit (CHANGED-HARMLESS at close).

## Gate

Gate 7, the one gate, on 9ac4aa0688af8fb5c801ef5a8481f282422f35ee (integration head 5c798a3072 merged once, origin/dev 1d41f2c97f, the two catch fixes), pen-mac-studio, `set -o pipefail; vp run check:changed`, started 2026-11-16T18:13:46Z, exit 1 at 2026-11-16T20:13:35Z (log n3-gate7.log).

- Static phase: 42/42 tasks passed (format, lint, knip, typecheck, the agent surface audit and context budget).
- vp test (1812 files, 7175 s): Test Files 4 failed | 1803 passed | 5 skipped; Tests 22 failed | 26014 passed | 21 skipped.
- Every failure is a known issue that fails the same way at 5c798a3072 with Effect 4.0.5 on this Mac (baseline worktree checked out at 5c798a3072eab155e0ae222dda3dcd33641c0bcc, effect 4.0.5, same four files: logs n3-base-5c79-server.log and n3-base-5c79-ssh.log):

| File | Gate 7 (N3) | 5c798a3072, Effect 4.0.5 | Issue |
|---|---|---|---|
| apps/server src/textGeneration/GrokTextGeneration.test.ts | 16 failed | 16 failed, same test names | goat#3425 |
| apps/server src/cli/app.test.ts | 4 failed (serverCwd fixture) | 4 failed, same test names | goat#3238 |
| packages/ssh src/runtimeFactsScripts.test.ts | 1 failed | 1 failed, same test | goat#3363 |
| packages/ssh src/launchListenerScripts.test.ts | 1 failed under full-run load | passes when run alone (as it does on N3 alone) | goat#3403 (fails under full-run load) |

The Grok and cli/app failure sets are identical by a diff of the test names. goat#3238 stops: the hung serverCwd fixtures were stopped only by PIDs traced to the gate shell 88663 (38123 relative-flag, 48860 relative-env, 56665 relative-bootstrap) and, in the baseline run, to its shell 25888 (37064, 46613, 54237); chains in n3-gate-stops.txt.

Gate 6 ran on 9d98d71774, the merged and adapted tree before the two catch fixes. N3 stopped it after the static phase had passed (42/42 tasks), because the catch audit had found a regression. The first stop attempt failed silently: zsh did not split the PID list. The tree was then stopped by PIDs traced to the gate shell, 48576 (n3-gate-stops.txt). Gate 7 runs on 9ac4aa0688.

For reference, gate 5 on 19fe33fdee (integration 44d7d60d20, dev 26847e90dc), log n3-gate5.log: format, lint, knip, graphql, the agent surface audit, the agent context budget and typecheck (42 packages) passed. Tests: 10 failed files, 1727 passed and 5 skipped; 37 failed, 25402 passed and 21 skipped. The new failures are fixed above, and the rest are the pre-existing failures listed. Gates 1 to 4 were stopped as stale when the integration head moved.

## Full CI run

Full CI run: https://github.com/goat-si/goat/actions/runs/43953991793, workflow_dispatch on chase/t3-261114-n3-effect-41 at 9ac4aa0688af8fb5c801ef5a8481f282422f35ee, dispatched 2026-11-16T20:50:55Z. Result: queued when this record was pushed (2026-11-16, while the coordinator's C4 reviews run); the result is added in a follow-up records commit and cited in READY.

The integration head this branch contains, 5c798a3072, had its own full run SUCCESS before N3 merged it: https://github.com/goat-si/goat/actions/runs/43922119605 (28 jobs: 26 passed, 2 skipped, none failed; goat-ci-result SUCCESS).

## NOT RUN

- NOT RUN: relay PostgreSQL fixture on pen-mac-studio (`node infra/relay/scripts/test-postgres.ts check`: "pg_ctl: could not start server"). It must pass in the manual full CI run: "Connect auth PostgreSQL boundaries" and the relay tests.
- NOT RUN: NonBlockingSpawner.test.ts on Linux locally (no Linux host); it runs in hosted CI.
- NOT RUN: any alchemy deploy, plan or destroy (ruling 1 (e)).
- NOT RUN: a real-client pass (no user-visible frontend change).
- NOT RUN: launchListenerScripts.test.ts under full-run load at 5c798a3072 on Effect 4.0.5 (run alone it passes on both; its gate failure is the load-only goat#3403).

## Appendix: files the port touched

| package | mechanical | adapted |
|---|---|---|
| apps/desktop | 15 | 13 |
| apps/mobile | 0 | 4 |
| apps/server | 329 | 285 |
| apps/web | 0 | 2 |
| devlog | 0 | 1 |
| docs | 0 | 1 |
| infra/relay | 0 | 52 |
| infra/task-cache | 2 | 6 |
| oxlint-plugin-goat | 0 | 1 |
| packages/client-runtime | 2 | 7 |
| packages/effect-acp | 1 | 0 |
| packages/effect-codex-app-server | 1 | 0 |
| packages/provider-acp | 3 | 3 |
| packages/provider-acp-registry | 9 | 7 |
| packages/provider-claude-cloud | 0 | 1 |
| packages/provider-core | 2 | 6 |
| packages/provider-cursor | 7 | 4 |
| packages/provider-devin-cloud | 0 | 1 |
| packages/provider-fx | 4 | 1 |
| packages/provider-grok | 6 | 3 |
| packages/provider-muse | 1 | 1 |
| packages/provider-opencode | 13 | 5 |
| packages/provider-pi | 0 | 1 |
| packages/shared | 0 | 6 |
| packages/source-control-core | 0 | 1 |
| packages/source-control-github | 3 | 1 |
| packages/ssh | 44 | 34 |
| packages/tailscale | 0 | 1 |
| patches | 0 | 5 |
| pnpm-lock.yaml | 0 | 1 |
| pnpm-workspace.yaml | 0 | 1 |
| scripts | 0 | 3 |

<details>
<summary>Mechanical (442 files)</summary>

```text

apps/desktop/src/backend/DesktopBackendConfiguration.test.ts
apps/desktop/src/backend/DesktopBackendConfiguration.testkit.ts
apps/desktop/src/backend/DesktopServerExposure.test.ts
apps/desktop/src/electron/ElectronSafeStorage.test.ts
apps/desktop/src/ipc/methods/sshEnvironment.test.ts
apps/desktop/src/main.ts
apps/desktop/src/preview/BrowserSession.test.ts
apps/desktop/src/settings/DesktopAppSettings.test.ts
apps/desktop/src/settings/DesktopClientSettings.test.ts
apps/desktop/src/ssh/DesktopSshEnvironment.keyOnly.test.ts
apps/desktop/src/ssh/DesktopSshEnvironment.test.ts
apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts
apps/desktop/src/ssh/DesktopSshRuntimePending.test.ts
apps/desktop/src/updates/updatesTestHarness.ts
apps/desktop/src/window/DesktopWindow.testkit.ts
apps/server/scripts/record-claude-agent-sdk-replay-fixture.ts
apps/server/scripts/record-codex-app-server-replay-fixture.ts
apps/server/scripts/record-cursor-agent-sdk-replay-fixture.ts
apps/server/scripts/record-fx-acp-replay-fixture.ts
apps/server/scripts/record-grok-acp-replay-fixture.ts
apps/server/scripts/record-muse-msp-replay-fixture.ts
apps/server/scripts/record-pi-rpc-replay-fixture.ts
apps/server/src/assets/AssetAccess.test.ts
apps/server/src/assets/AttachmentLifecycle.testkit.ts
apps/server/src/assets/AttachmentUpload.test.ts
apps/server/src/assets/PendingAttachmentSweep.test.ts
apps/server/src/assets/noteFileAsset.test.ts
apps/server/src/auth/ConnectHubProxyAccess.test.ts
apps/server/src/auth/ConnectHubRuntime.testkit.ts
apps/server/src/auth/EnvironmentAuth.cloudConnect.test.ts
apps/server/src/auth/EnvironmentAuth.test.ts
apps/server/src/auth/EnvironmentAuthAdmin.test.ts
apps/server/src/auth/EnvironmentAuthPolicy.test.ts
apps/server/src/auth/ServerSecretStore.test.ts
apps/server/src/auth/SessionStore.test.ts
apps/server/src/auth/SettingsRpc.connectHubProxy.test.ts
apps/server/src/auth/hubProxyDelegation.test.ts
apps/server/src/auth/penPrincipals.test.ts
apps/server/src/auth/proxiedCallPolicy.test.ts
apps/server/src/auth/replayMarkers.test.ts
apps/server/src/auth/sessionBinding.test.ts
apps/server/src/bin.fast-path.test.ts
apps/server/src/binCli.connect.enabled.test.ts
apps/server/src/binCli.connect.test.ts
apps/server/src/binCli.ts
apps/server/src/channels/ChannelAssembly.test.ts
apps/server/src/channels/ChannelRemoteWorkers.live.test.ts
apps/server/src/channels/slack/SlackChannelSettings.access.test.ts
apps/server/src/channels/slack/SlackChannelSettings.test.ts
apps/server/src/checkpointing/CheckpointStore.test.ts
apps/server/src/cli/app.test.ts
apps/server/src/cli/cliCredential.test.ts
apps/server/src/cli/connect.test.ts
apps/server/src/cli/connect.ts
apps/server/src/cli/deferredImports.test.ts
apps/server/src/cli/login.ts
apps/server/src/cli/mcpClientSkill.test.ts
apps/server/src/cli/opencodex.test.ts
apps/server/src/cli/project.test.ts
apps/server/src/cli/serverCwd.fixture.ts
apps/server/src/cli/theme.test.ts
apps/server/src/cli/triage.test.ts
apps/server/src/cloud/CliState.test.ts
apps/server/src/cloud/CliTokenManager.test.ts
apps/server/src/cloud/CloudLink.lifecycle.test.ts
apps/server/src/cloud/CloudLink.test.ts
apps/server/src/cloud/ManagedEndpointRuntime.test.ts
apps/server/src/cloud/autoUpdate.test.ts
apps/server/src/cloud/connectDisabled.test.ts
apps/server/src/cloud/environmentKeys.test.ts
apps/server/src/cloud/http.test.ts
apps/server/src/cloud/selfUpdate.test.ts
apps/server/src/cloudAgents/CloudAgentService.testkit.ts
apps/server/src/cloudMachines/CloudMachineService.testkit.ts
apps/server/src/cloudMachines/sshConfig.test.ts
apps/server/src/cua/ComputerUseAttachment.thread.testkit.ts
apps/server/src/cua/ComputerUseCallReservations.testkit.ts
apps/server/src/cua/ComputerUseForeground.testkit.ts
apps/server/src/cua/ComputerUseLeaseRoute.browserClaims.testkit.ts
apps/server/src/cua/ComputerUseLeaseRoute.test.ts
apps/server/src/cua/ComputerUseLeaseRoute.thread.testkit.ts
apps/server/src/cua/ComputerUseLeases.everyApp.test.ts
apps/server/src/cua/ComputerUseSettings.test.ts
apps/server/src/desktopUpdate/DesktopAppUpdate.test.ts
apps/server/src/device/AgentDeviceTarget.test.ts
apps/server/src/device/DeviceService.test.ts
apps/server/src/environment/ServerEnvironmentMachine.test.ts
apps/server/src/fleet/goals/GoalClientOwner.test.ts
apps/server/src/fleet/goals/GoalController.moves.testkit.ts
apps/server/src/fleet/goals/GoalController.testkit.ts
apps/server/src/fleet/health/Rescheduler.testkit.ts
apps/server/src/git/GitManagerTestHarness.ts
apps/server/src/git/GitWorkflowService.test.ts
apps/server/src/guest/GuestShareService.test.ts
apps/server/src/handoffs/ApprovalHandoffs.testkit.ts
apps/server/src/handoffs/HandoffWakeReactor.testkit.ts
apps/server/src/handoffs/Handoffs.testkit.ts
apps/server/src/hub/OpenCodexManagedUpdate.followup.test.ts
apps/server/src/hub/OpenCodexManagedUpdate.test.ts
apps/server/src/hub/OpenCodexOcxLease.test.ts
apps/server/src/hub/disposable/disposableSwitch.test.ts
apps/server/src/hub/hubConsentGenerations.test.ts
apps/server/src/mcp/LaunchWatchService.testkit.ts
apps/server/src/mcp/McpSessionRegistry.sessionRun.test.ts
apps/server/src/mcp/McpSessionRegistry.test.ts
apps/server/src/mcp/OrchestratorMcpService.childWork.test.ts
apps/server/src/mcp/OrchestratorMcpService.executedModel.test.ts
apps/server/src/mcp/OrchestratorMcpService.forceCancel.test.ts
apps/server/src/mcp/OrchestratorMcpService.lazyThreads.test.ts
apps/server/src/mcp/OrchestratorMcpService.remote.testkit.ts
apps/server/src/mcp/OrchestratorMcpService.remoteModel.test.ts
apps/server/src/mcp/OrchestratorMcpService.remoteSender.test.ts
apps/server/src/mcp/OrchestratorMcpService.reviewContinuation.testkit.ts
apps/server/src/mcp/OrchestratorMcpService.reviewLedger.test.ts
apps/server/src/mcp/OrchestratorMcpService.reviewRole.test.ts
apps/server/src/mcp/OrchestratorMcpService.terminationCause.test.ts
apps/server/src/mcp/OrchestratorMcpService.test.ts
apps/server/src/mcp/OrchestratorMcpService.turnCapabilities.test.ts
apps/server/src/mcp/PreviewAutomationBroker.exact.test.ts
apps/server/src/mcp/PreviewAutomationBroker.runIdentity.test.ts
apps/server/src/mcp/PreviewAutomationBroker.serverHost.test.ts
apps/server/src/mcp/PreviewAutomationBroker.test.ts
apps/server/src/mcp/PreviewAutomationBroker.timeout.test.ts
apps/server/src/mcp/PreviewAutomationBroker.unanswered.test.ts
apps/server/src/mcp/RepositoryLaunchMcpService.transport.test.ts
apps/server/src/mcp/TaskCancelNativeSubagent.integration.test.ts
apps/server/src/mcp/ThreadLaunchMcpService.test.ts
apps/server/src/mcp/ThreadReplicaService.test.ts
apps/server/src/mcp/WorktreeInventoryService.test.ts
apps/server/src/mcp/WorktreeMcpService.test.ts
apps/server/src/mcp/toolkits/attachment/tools.ts
apps/server/src/mcp/toolkits/environment/handlers.connectHubProxy.test.ts
apps/server/src/mcp/toolkits/environment/handlers.disposableSwitch.test.ts
apps/server/src/mcp/toolkits/previewControls/handlers.test.ts
apps/server/src/mcp/toolkits/project/cloneTimeout.test.ts
apps/server/src/mcp/toolkits/project/handlers.test.ts
apps/server/src/mcp/toolkits/project/handlers.testkit.ts
apps/server/src/mcp/toolkits/project/tools.ts
apps/server/src/mcp/toolkits/ssh/tools.ts
apps/server/src/mcp/toolkits/thread/tools.ts
apps/server/src/mcpServerSecrets.test.ts
apps/server/src/memory/MemoryDefaultHub.test.ts
apps/server/src/memory/MemoryHubClient.test.ts
apps/server/src/memory/MemoryHubService.test.ts
apps/server/src/memory/MemoryHubSyncScenarios.test.ts
apps/server/src/memory/MemoryWorker.testkit.ts
apps/server/src/notes/NotesTestkit.ts
apps/server/src/opencodex/OpenCodexChildReady.operations.test.ts
apps/server/src/opencodex/OpenCodexChildReady.test.ts
apps/server/src/opencodex/OpenCodexChildReady.testkit.ts
apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/AcpAdapterV2Compaction.test.ts
apps/server/src/orchestration-v2/Adapters/AcpAdapterV2Form.test.ts
apps/server/src/orchestration-v2/Adapters/AcpAdapterV2Updates.test.ts
apps/server/src/orchestration-v2/Adapters/AcpPermissionGrants.test.ts
apps/server/src/orchestration-v2/Adapters/AcpPromptInactivity.test.ts
apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2SubagentTools.test.ts
apps/server/src/orchestration-v2/Adapters/AcpRegistryElicitation.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterTestLayer.testkit.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.launch.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeBackgroundDetails.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.forkCwd.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.goals.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.questionId.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.reportedModel.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.sessionKey.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.subagentWake.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.survivor.testkit.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/CodexCommandWake.test.ts
apps/server/src/orchestration-v2/Adapters/CodexNetworkRetry.test.ts
apps/server/src/orchestration-v2/Adapters/CodexStalledRetry.test.ts
apps/server/src/orchestration-v2/Adapters/CodexThreadClosing.test.ts
apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/FxAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/FxAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/MuseAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/PiAdapterV2.testkit.ts
apps/server/src/orchestration-v2/DelegatedCompletionDelivery.testkit.ts
apps/server/src/orchestration-v2/EffectWorker.testkit.ts
apps/server/src/orchestration-v2/EventStore.redaction.test.ts
apps/server/src/orchestration-v2/NativeChildWorkQuery.test.ts
apps/server/src/orchestration-v2/ProjectSettingsUpgrade.integration.test.ts
apps/server/src/orchestration-v2/ProviderAdapterRegistry.test.ts
apps/server/src/orchestration-v2/ProviderEventIngestor.readerOverload.test.ts
apps/server/src/orchestration-v2/ProviderEventIngestor.screenRows.test.ts
apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts
apps/server/src/orchestration-v2/ProviderSessionManager.lifecycle.test.ts
apps/server/src/orchestration-v2/ProviderSessionManager.sessionRun.test.ts
apps/server/src/orchestration-v2/ProviderSessionManager.settings.test.ts
apps/server/src/orchestration-v2/ProviderSessionManager.test.ts
apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts
apps/server/src/orchestration-v2/ProviderTurnStartService.testkit.ts
apps/server/src/orchestration-v2/PullRequestWatchTerminal.test.ts
apps/server/src/orchestration-v2/PullRequestWatchWakes.test.ts
apps/server/src/orchestration-v2/ThreadLaunchService.test.ts
apps/server/src/orchestration-v2/goat/RunStartHoldReactor.test.ts
apps/server/src/orchestration-v2/goat/SessionReceiptHold.test.ts
apps/server/src/orchestration-v2/goat/ThreadWorkspaceService.test.ts
apps/server/src/orchestration-v2/runtimeLayer.receiptStore.test.ts
apps/server/src/orchestration-v2/runtimeLayer.rewind.test.ts
apps/server/src/orchestration-v2/runtimeLayer.test.ts
apps/server/src/orchestration-v2/runtimeLayer.testkit.ts
apps/server/src/orchestration-v2/runtimeLayer.ts
apps/server/src/orchestration-v2/test/ProviderSessionManagerHarness.testkit.ts
apps/server/src/orchestration-v2/testkit/AcpRegistryReplayFixtures.integration.test.ts
apps/server/src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts
apps/server/src/orchestration-v2/testkit/CodexAppServerIsolation.integration.test.ts
apps/server/src/orchestration-v2/testkit/CodexSurvivorRestart.integration.test.ts
apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts
apps/server/src/orchestration-v2/testkit/OrchestratorReplayRestartBackgroundNote.integration.test.ts
apps/server/src/orchestration-v2/testkit/ProviderReplayFixtures.ts
apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts
apps/server/src/orchestration-v2/testkit/SessionReceiptReplay.integration.test.ts
apps/server/src/orchestration-v2/testkit/ThreadFork.integration.test.ts
apps/server/src/orchestration-v2/testkit/ThreadLaunchHarness.ts
apps/server/src/orchestration-v2/testkit/ThreadMergeBack.integration.test.ts
apps/server/src/pen/PenHttp.test.ts
apps/server/src/pen/PenRuntime.test.ts
apps/server/src/pen/PenServerLayers.test.ts
apps/server/src/pen/PenSessions.test.ts
apps/server/src/persistence/Sqlite.test.ts
apps/server/src/persistence/testkit/SqliteRouting.ts
apps/server/src/preview/ServerBrowser.blockedNavigation.test.ts
apps/server/src/preview/ServerBrowser.capacity.test.ts
apps/server/src/preview/ServerBrowser.captureLock.test.ts
apps/server/src/preview/ServerBrowser.dialog.test.ts
apps/server/src/preview/ServerBrowser.downloadWait.test.ts
apps/server/src/preview/ServerBrowser.inactiveRun.test.ts
apps/server/src/preview/ServerBrowser.popupSetup.test.ts
apps/server/src/preview/ServerBrowser.primitives.test.ts
apps/server/src/preview/ServerBrowser.screen.test.ts
apps/server/src/preview/ServerBrowser.stills.test.ts
apps/server/src/preview/ServerBrowser.test.ts
apps/server/src/preview/blockedHostSnapshot.test.ts
apps/server/src/preview/serverBrowserReadiness.test.ts
apps/server/src/process/externalLauncher.testkit.ts
apps/server/src/project/AgentSessionScanner.testkit.ts
apps/server/src/project/GoatProjectFileLoader.test.ts
apps/server/src/project/ManagedProjectFolders.test.ts
apps/server/src/project/ProjectService.test.ts
apps/server/src/project/ProjectSetupScriptRunner.test.ts
apps/server/src/project/RepositoryReferences.testkit.ts
apps/server/src/project/testkit/ProjectScriptRunnerHarness.ts
apps/server/src/provider/AntigravityAuth.test.ts
apps/server/src/provider/AntigravityInstallation.native.test.ts
apps/server/src/provider/AntigravityInstallation.test.ts
apps/server/src/provider/AntigravityInstallation.update.test.ts
apps/server/src/provider/AntigravityInstallationErrors.test.ts
apps/server/src/provider/AntigravityProvider.test.ts
apps/server/src/provider/CodexChatGptBroker.test.ts
apps/server/src/provider/CodexInstallationExtract.test.ts
apps/server/src/provider/CodexManagedRuntime.test.ts
apps/server/src/provider/CodexRouteService.testkit.ts
apps/server/src/provider/Drivers/AntigravityDriver.test.ts
apps/server/src/provider/Drivers/ClaudeDriver.ts
apps/server/src/provider/Drivers/CodexDriver.opencodex.test.ts
apps/server/src/provider/Drivers/CodexDriver.testkit.ts
apps/server/src/provider/Drivers/CodexNativeRelease.test.ts
apps/server/src/provider/GrokProvider.test.ts
apps/server/src/provider/ProviderHostSync.install.test.ts
apps/server/src/provider/ProviderHostSync.test.ts
apps/server/src/provider/ProviderHostSync.testkit.ts
apps/server/src/provider/ProviderInstanceRegistry.secrets.test.ts
apps/server/src/provider/ProviderInstanceRegistry.test.ts
apps/server/src/provider/ProviderInstanceRegistryHydration.test.ts
apps/server/src/provider/ProviderRegistry.test.ts
apps/server/src/provider/acp/AcpJsonRpcConnection.test.ts
apps/server/src/provider/acp/AcpSessionRuntime.release.test.ts
apps/server/src/provider/acp/AntigravityAcpSupport.ts
apps/server/src/provider/antigravityUsageLimits.test.ts
apps/server/src/provider/resetCreditCoordinator.test.ts
apps/server/src/pullRequest/PullRequestActionReply.test.ts
apps/server/src/pullRequest/PullRequestForkListing.test.ts
apps/server/src/pullRequest/PullRequestPinnedMerge.test.ts
apps/server/src/pullRequest/PullRequestReviewGuideService.test.ts
apps/server/src/pullRequest/pullRequestTestFixtures.ts
apps/server/src/resourceTelemetry/NativeTelemetryClient.test.ts
apps/server/src/runtimeSessionRoute.test.ts
apps/server/src/scheduledTasks/ScheduledTaskService.memoryGrantCeiling.test.ts
apps/server/src/screenCode/ScreenTargetPrelude.testkit.ts
apps/server/src/secrets/SecretRequests.testkit.ts
apps/server/src/server.screenPrimitives.test.ts
apps/server/src/serverRuntimeState.test.ts
apps/server/src/serverSettings.connectHubProxy.test.ts
apps/server/src/serverSettings.memoryOwner.test.ts
apps/server/src/serverSettings.prototype.test.ts
apps/server/src/serverSettings.secrets.test.ts
apps/server/src/serverSettings.test.ts
apps/server/src/serverSettings.watch.test.ts
apps/server/src/serverSettingsSecrets.test.ts
apps/server/src/settingsSecrets.textGenerators.test.ts
apps/server/src/sourceControl/SourceControlRepositoryService.test.ts
apps/server/src/sourceControl/staleTokenSettings.test.ts
apps/server/src/sshRemote/SshHostSetup.disposable.test.ts
apps/server/src/sshRemote/SshHostSetup.sharedManager.test.ts
apps/server/src/sshRemote/SshRemoteDispatch.cloud.test.ts
apps/server/src/sshRemote/SshRemoteDispatch.hostCall.testkit.ts
apps/server/src/sshRemote/SshRemoteDispatch.lineage.testkit.ts
apps/server/src/sshRemote/SshRemoteDispatch.pending.test.ts
apps/server/src/sshRemote/SshRemoteDispatch.runtime.test.ts
apps/server/src/sshRemote/SshRemoteDispatchLive.test.ts
apps/server/src/sshRemote/SshWorkspaceSync.test.ts
apps/server/src/sshRemote/testkit/LinkedHostFixture.ts
apps/server/src/sshRemote/testkit/SshHostSetupTestkit.ts
apps/server/src/sshRemote/testkit/SshRuntimeUpdateFixture.ts
apps/server/src/storage/StorageReclaim.test.ts
apps/server/src/storage/StorageReclaim.testkit.ts
apps/server/src/storageCleanup.testkit.ts
apps/server/src/telemetry/AnalyticsService.test.ts
apps/server/src/terminal/Manager.test.ts
apps/server/src/textGeneration/CodexTextGeneration.opencodex.test.ts
apps/server/src/textGeneration/GrokTextGeneration.test.ts
apps/server/src/textGeneration/TextGeneratorApi.test.ts
apps/server/src/textGeneration/codexTextGenerationFake.testkit.ts
apps/server/src/usage/UsageService.test.ts
apps/server/src/vcs/GitCheckpointIgnore.test.ts
apps/server/src/vcs/GitRemoteUrlSpaces.test.ts
apps/server/src/vcs/GitRepositoryProbe.test.ts
apps/server/src/vcs/GitStatusUpstream.test.ts
apps/server/src/vcs/GitUnbornCheckpoint.test.ts
apps/server/src/vcs/GitVcsDriver.test.ts
apps/server/src/vcs/GitVcsDriverCore.submoduleWorktree.test.ts
apps/server/src/vcs/GitWorkspaceSnapshotMaterialize.test.ts
apps/server/src/vcs/VcsDriverRegistry.test.ts
apps/server/src/vcs/testing/gitFixture.ts
apps/server/src/vcs/vcsStatusBroadcaster.testkit.ts
apps/server/src/voiceTranscription.test.ts
apps/server/src/workspace/WorkspaceFileSystem.test.ts
apps/server/src/workspace/WorkspaceFileSystem.whitespace.test.ts
apps/server/src/workspace/WorkspaceMetadataSafety.test.ts
apps/server/src/worktreeSnapshots/WorktreeCleanupPreviewStateLive.test.ts
apps/server/src/worktreeSnapshots/WorktreeSnapshotStoreLive.test.ts
apps/server/src/worktreeSnapshots/captureSnapshot.test.ts
apps/server/src/ws.lifecycle.test.ts
apps/server/src/wsRpcServices.testkit.ts
infra/task-cache/scripts/manage.ts
infra/task-cache/src/WriterRegistry.test.ts
packages/client-runtime/src/state/projectCommands.ts
packages/client-runtime/src/state/threadCommands.ts
packages/effect-acp/test/fixtures/acp-mock-peer.ts
packages/effect-codex-app-server/test/examples/codex-app-server-probe.ts
packages/provider-acp-registry/src/server/AcpRegistrySupport.test.ts
packages/provider-acp-registry/src/server/AcpRegistrySupport.testkit.ts
packages/provider-acp-registry/src/server/adapter.ts
packages/provider-acp-registry/src/server/auth.test.ts
packages/provider-acp-registry/src/server/authenticationState.test.ts
packages/provider-acp-registry/src/server/driver.cache.test.ts
packages/provider-acp-registry/src/server/driver.profile.test.ts
packages/provider-acp-registry/src/server/driver.test.ts
packages/provider-acp-registry/src/server/omp.live.test.ts
packages/provider-acp/src/server/adapter.environment.test.ts
packages/provider-acp/src/server/adapterFlavor.ts
packages/provider-acp/src/server/nativeLogging.test.ts
packages/provider-core/src/server/providerAuthFlow.test.ts
packages/provider-core/src/server/providerLoginTerminal.test.ts
packages/provider-cursor/src/server/CursorUsageAccounts.decisions.test.ts
packages/provider-cursor/src/server/CursorUsageAccounts.test.ts
packages/provider-cursor/src/server/accountUsage.test.ts
packages/provider-cursor/src/server/auth.test.ts
packages/provider-cursor/src/server/driver.credentials.test.ts
packages/provider-cursor/src/server/driver.test.ts
packages/provider-cursor/src/server/driver.ts
packages/provider-fx/src/server/acpSupport.ts
packages/provider-fx/src/server/adapter.environment.test.ts
packages/provider-fx/src/server/adapter.ts
packages/provider-fx/src/server/driver.ts
packages/provider-grok/src/server/acpSupport.ts
packages/provider-grok/src/server/adapter.environment.test.ts
packages/provider-grok/src/server/adapter.ts
packages/provider-grok/src/server/auth.test.ts
packages/provider-grok/src/server/status.test.ts
packages/provider-grok/src/server/status.ts
packages/provider-muse/src/server/test/adapterHelpers.ts
packages/provider-opencode/src/server/driver.launchEnvironment.test.ts
packages/provider-opencode/src/server/driver.lentRead.test.ts
packages/provider-opencode/src/server/driver.localServer.test.ts
packages/provider-opencode/src/server/driver.memory.test.ts
packages/provider-opencode/src/server/driver.nativeGoals.test.ts
packages/provider-opencode/src/server/driver.profile.test.ts
packages/provider-opencode/src/server/driver.test.ts
packages/provider-opencode/src/server/driver.updates.test.ts
packages/provider-opencode/src/server/driver.workspace.test.ts
packages/provider-opencode/src/server/driver.workspaceEnvironment.test.ts
packages/provider-opencode/src/server/status.test.ts
packages/provider-opencode/src/server/usageLimits.test.ts
packages/provider-opencode/src/server/v2/OpenCode2Server.test.ts
packages/source-control-github/scripts/measure-pr-preview.ts
packages/source-control-github/src/server/GitHubPullRequestApi.testkit.ts
packages/source-control-github/src/server/GitHubSourceControlProvider.testkit.ts
packages/ssh/src/appServer.test.ts
packages/ssh/src/existingServer.gitbash.test.ts
packages/ssh/src/existingServer.test.ts
packages/ssh/src/hostAccess.test.ts
packages/ssh/src/runtimeArchive.test.ts
packages/ssh/src/runtimeArchiveHttp.test.ts
packages/ssh/src/runtimeAvailability.test.ts
packages/ssh/src/runtimeWindows.test.ts
packages/ssh/src/tunnel.client-session.test.ts
packages/ssh/src/tunnel.database-ahead.test.ts
packages/ssh/src/tunnel.diagnostics.test.ts
packages/ssh/src/tunnel.ensure-flight.test.ts
packages/ssh/src/tunnel.facts.test.ts
packages/ssh/src/tunnel.failure-parity.test.ts
packages/ssh/src/tunnel.host-download.test.ts
packages/ssh/src/tunnel.launch-identity.test.ts
packages/ssh/src/tunnel.master.test.ts
packages/ssh/src/tunnel.preparation-errors.test.ts
packages/ssh/src/tunnel.protocol-acquisition.test.ts
packages/ssh/src/tunnel.protocol-adoption.test.ts
packages/ssh/src/tunnel.protocol-build-order.test.ts
packages/ssh/src/tunnel.protocol-capability.test.ts
packages/ssh/src/tunnel.protocol-compat.test.ts
packages/ssh/src/tunnel.protocol-drain.test.ts
packages/ssh/src/tunnel.protocol-fixture.test.ts
packages/ssh/src/tunnel.protocol-forced-followup.test.ts
packages/ssh/src/tunnel.protocol-forced.test.ts
packages/ssh/src/tunnel.protocol-legacy.test.ts
packages/ssh/src/tunnel.protocol-manager.test.ts
packages/ssh/src/tunnel.protocol-pending.test.ts
packages/ssh/src/tunnel.protocol-refresh.test.ts
packages/ssh/src/tunnel.protocol-replacement.test.ts
packages/ssh/src/tunnel.protocol-shared.test.ts
packages/ssh/src/tunnel.protocol-stop.test.ts
packages/ssh/src/tunnel.protocol-upgrade.test.ts
packages/ssh/src/tunnel.readiness.test.ts
packages/ssh/src/tunnel.reconnect-probe-changes.test.ts
packages/ssh/src/tunnel.reconnect-probe-stale-entry.test.ts
packages/ssh/src/tunnel.reconnect-probe-wake-retention.test.ts
packages/ssh/src/tunnel.reconnect-probe-wake.test.ts
packages/ssh/src/tunnel.reconnect-probe.test.ts
packages/ssh/src/tunnel.replacement-lock.test.ts
packages/ssh/src/tunnel.stall.test.ts
packages/ssh/src/tunnel.timeouts.test.ts
```

</details>

<details>
<summary>Adapted (458 files)</summary>

```text

apps/desktop/src/app/DesktopApp.ts
apps/desktop/src/app/DesktopConnectionCatalogStore.test.ts
apps/desktop/src/app/DesktopConnectionCatalogStore.ts
apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts
apps/desktop/src/backend/DesktopBackendConfiguration.ts
apps/desktop/src/preview/BrowserSession.ts
apps/desktop/src/preview/Manager.ts
apps/desktop/src/settings/DesktopAppSettings.ts
apps/desktop/src/settings/DesktopClientSettings.ts
apps/desktop/src/snapShot/DesktopSnapShot.test.ts
apps/desktop/src/snapShot/DesktopSnapShot.ts
apps/desktop/src/ssh/DesktopSshEnvironment.ts
apps/desktop/src/ssh/DesktopSshPasswordPrompts.ts
apps/mobile/scripts/measure-renders.mts
apps/mobile/src/features/cloud/dpop.test.ts
apps/mobile/src/features/cloud/dpop.ts
apps/mobile/src/features/cloud/managedRelayLayer.ts
apps/server/integration/NetworkTransferMeasurement.integration.ts
apps/server/scripts/cli.ts
apps/server/scripts/evaluate-thread-titles.ts
apps/server/src/AgentWorkspaceTerminalPolicy.ts
apps/server/src/assets/AssetAccess.ts
apps/server/src/assets/AttachmentUpload.ts
apps/server/src/assets/NativeAppIconResolver.ts
apps/server/src/auth/EnvironmentAuth.ts
apps/server/src/auth/HubRpcSocket.ts
apps/server/src/auth/McpOAuth.test.ts
apps/server/src/auth/McpOAuth.ts
apps/server/src/auth/PairingGrantStore.test.ts
apps/server/src/auth/PairingGrantStore.ts
apps/server/src/auth/ServerSecretStore.ts
apps/server/src/auth/SessionSocketLifetime.test.ts
apps/server/src/auth/SessionStore.ts
apps/server/src/auth/dpop.ts
apps/server/src/auth/http.test.ts
apps/server/src/auth/http.ts
apps/server/src/channels/slack/SlackChannelSettings.live.ts
apps/server/src/checkpointing/CheckpointDiffQuery.ts
apps/server/src/cli/app.ts
apps/server/src/cli/pair.test.ts
apps/server/src/cli/project.ts
apps/server/src/cli/service.test.ts
apps/server/src/cloud/CliTokenManager.approval.test.ts
apps/server/src/cloud/CliTokenManager.ts
apps/server/src/cloud/CloudLink.authentication.test.ts
apps/server/src/cloud/CloudLink.hubProxy.enabled.test.ts
apps/server/src/cloud/CloudLink.keyCompromise.test.ts
apps/server/src/cloud/CloudLink.ts
apps/server/src/cloud/CloudLinkRevocation.ts
apps/server/src/cloud/CloudLinkRevocationClient.ts
apps/server/src/cloud/autoUpdate.ts
apps/server/src/cloud/autoUpdatePolicy.ts
apps/server/src/cloud/selfUpdate.ts
apps/server/src/cloudAgents/CloudAgentService.test.ts
apps/server/src/cloudAgents/CloudAgentService.ts
apps/server/src/cloudMachines/CloudMachineService.ts
apps/server/src/cloudMachines/sshConfig.ts
apps/server/src/cua/CuaDriverInstallation.test.ts
apps/server/src/cua/DesktopAppsListing.ts
apps/server/src/cua/DesktopBrowserManifest.ts
apps/server/src/cua/DesktopCuaDriverHost.ts
apps/server/src/desktopUpdate/DesktopAppUpdate.ts
apps/server/src/device/AgentDeviceTarget.ts
apps/server/src/device/AgentSessionRelease.ts
apps/server/src/device/DeviceHubProxy.stream.test.ts
apps/server/src/device/DeviceHubProxy.ts
apps/server/src/device/DeviceService.ts
apps/server/src/device/SshDeviceHost.test.ts
apps/server/src/device/SshDeviceHost.ts
apps/server/src/device/localSshDeviceHost.test.ts
apps/server/src/environment/ServerEnvironment.test.ts
apps/server/src/environment/ServerEnvironment.ts
apps/server/src/environment/ServerEnvironmentMachine.ts
apps/server/src/fleet/goals/GoalService.ts
apps/server/src/git/GitManager.ts
apps/server/src/git/testkit/gitSpawnObserver.ts
apps/server/src/goatclaw/DecisionInbox.ts
apps/server/src/goatclaw/FleetSync.test.ts
apps/server/src/guest/GuestShareService.ts
apps/server/src/htmlRender/HtmlRender.test.ts
apps/server/src/http.ts
apps/server/src/hub/OpenCodexManagedUpdate.ts
apps/server/src/hubProxy/ConnectHubSocketAdmission.test.ts
apps/server/src/hubProxy/connectHubSockets.test.ts
apps/server/src/hubProxy/http.test.ts
apps/server/src/hubProxy/http.ts
apps/server/src/hubProxy/testFixtures.ts
apps/server/src/linkedHosts/LinkedHosts.test.ts
apps/server/src/linkedHosts/LinkedHosts.ts
apps/server/src/mcp/ChannelSessionReceiptGate.test.ts
apps/server/src/mcp/LaunchWatchService.ts
apps/server/src/mcp/McpAuthMiddleware.ts
apps/server/src/mcp/McpDeviceToolkit.test.ts
apps/server/src/mcp/McpHttpServer.authTracing.test.ts
apps/server/src/mcp/McpHttpServer.discovery.test.ts
apps/server/src/mcp/McpHttpServer.test.ts
apps/server/src/mcp/McpHttpServer.ts
apps/server/src/mcp/McpSessionRegistry.ts
apps/server/src/mcp/McpToolAccess.race.test.ts
apps/server/src/mcp/McpToolAccess.test.ts
apps/server/src/mcp/McpToolResults.test.ts
apps/server/src/mcp/OrchestratorMcpService.ts
apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts
apps/server/src/mcp/PendingQuestionsMcpService.ts
apps/server/src/mcp/PreviewAutomationBroker.features.test.ts
apps/server/src/mcp/PreviewAutomationBroker.ts
apps/server/src/mcp/RepositoryReferenceMcpService.test.ts
apps/server/src/mcp/SecretRequestCard.integration.test.ts
apps/server/src/mcp/SecretRequestCode.integration.test.ts
apps/server/src/mcp/SecretRequestLogin.integration.test.ts
apps/server/src/mcp/ThreadLaunchMcpService.ts
apps/server/src/mcp/ThreadLifecycleMcpService.test.ts
apps/server/src/mcp/ThreadLifecycleMcpService.ts
apps/server/src/mcp/ThreadMetadataMcpService.ts
apps/server/src/mcp/ToolAdmission.childSetup.test.ts
apps/server/src/mcp/ToolAdmission.test.ts
apps/server/src/mcp/ToolAdmissionSettlement.test.ts
apps/server/src/mcp/ToolDispatch.ts
apps/server/src/mcp/WorktreeMcpService.ts
apps/server/src/mcp/advertisedJsonSchema.registration.test.ts
apps/server/src/mcp/agentSurface.test.ts
apps/server/src/mcp/agentSurface.testkit.ts
apps/server/src/mcp/agentSurface.toolNames.test.ts
apps/server/src/mcp/agentSurfaceKeys.test.ts
apps/server/src/mcp/agentWorkspaceTerminal.test.ts
apps/server/src/mcp/previewScreenshotFile.ts
apps/server/src/mcp/scheduleReconcile.test.ts
apps/server/src/mcp/threadAccess.ts
apps/server/src/mcp/toolkits/agentSurface/eval.test.ts
apps/server/src/mcp/toolkits/agentSurface/forwardedContent.test.ts
apps/server/src/mcp/toolkits/agentSurface/hostDescribe.test.ts
apps/server/src/mcp/toolkits/agentSurface/search.test.ts
apps/server/src/mcp/toolkits/attachment/handlers.test.ts
apps/server/src/mcp/toolkits/core.test.ts
apps/server/src/mcp/toolkits/device/deviceAccess.test.ts
apps/server/src/mcp/toolkits/fleet/goalHandlers.test.ts
apps/server/src/mcp/toolkits/htmlPath.test.ts
apps/server/src/mcp/toolkits/memory/handlers.test.ts
apps/server/src/mcp/toolkits/memory/handlers.testkit.ts
apps/server/src/mcp/toolkits/preview/handlers.test.ts
apps/server/src/mcp/toolkits/project/handlers.goatclaw.test.ts
apps/server/src/mcp/toolkits/provider/acpSessions.test.ts
apps/server/src/mcp/toolkits/provider/handlers.test.ts
apps/server/src/mcp/toolkits/provider/retry.test.ts
apps/server/src/mcp/toolkits/pullRequests/handlers.testkit.ts
apps/server/src/mcp/toolkits/pullRequests/handlers.ts
apps/server/src/mcp/toolkits/pullRequests/writes.test.ts
apps/server/src/mcp/toolkits/remoteReport/handlers.test.ts
apps/server/src/mcp/toolkits/retryKeys.test.ts
apps/server/src/mcp/toolkits/screen/handlers.test.ts
apps/server/src/mcp/toolkits/ssh/cloudMachines.test.ts
apps/server/src/mcp/toolkits/ssh/handlers.test.ts
apps/server/src/mcp/toolkits/ssh/handlers.ts
apps/server/src/mcp/toolkits/thread/configurationHost.test.ts
apps/server/src/mcp/toolkits/thread/handlers.test.ts
apps/server/src/memory/MemoryCompactor.test.ts
apps/server/src/memory/MemoryHubAuth.test.ts
apps/server/src/memory/MemoryHubAuth.ts
apps/server/src/memory/MemoryHubHttp.test.ts
apps/server/src/memory/MemoryHubScenarios.test.ts
apps/server/src/memory/MemorySyncService.test.ts
apps/server/src/opencodex/OpenCodexInventory.test.ts
apps/server/src/opencodex/OpenCodexInventory.testkit.ts
apps/server/src/opencodex/OpenCodexInventory.ts
apps/server/src/opencodex/OpenCodexLocalAccounts.ts
apps/server/src/opencodex/childReadyLinked.ts
apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.goals.test.ts
apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.attachments.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.fork.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.launchArgs.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.nativeSubagentLimit.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.sessionCredential.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
apps/server/src/orchestration-v2/Adapters/ClaudeAgentSdkQueryRunner.ts
apps/server/src/orchestration-v2/Adapters/ClaudeEarlyExit.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeInstallationGate.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeProcessExit.test.ts
apps/server/src/orchestration-v2/Adapters/ClaudeWakeHarness.testkit.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.attachment.testkit.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.eventLog.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.homeRoute.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.replay.testkit.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.sessionInitialize.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.survivor.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.survivorModel.test.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts
apps/server/src/orchestration-v2/Adapters/CodexAdapterV2Options.ts
apps/server/src/orchestration-v2/Adapters/CodexAppServerClientFactory.test.ts
apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.test.ts
apps/server/src/orchestration-v2/Adapters/memoryDelivery.testkit.ts
apps/server/src/orchestration-v2/CheckpointService.ts
apps/server/src/orchestration-v2/ClaudeAutomaticDelivery.integration.test.ts
apps/server/src/orchestration-v2/CloudIngress.integration.test.ts
apps/server/src/orchestration-v2/FoundationPersistence.test.ts
apps/server/src/orchestration-v2/NativeChildWorkQuery.ts
apps/server/src/orchestration-v2/ProjectionStore.test.ts
apps/server/src/orchestration-v2/PullRequestSyncReactor.ts
apps/server/src/orchestration-v2/PullRequestWatchReactor.ts
apps/server/src/orchestration-v2/ThreadPullRequestService.linkedThreads.test.ts
apps/server/src/orchestration-v2/ThreadPullRequestService.test.ts
apps/server/src/orchestration-v2/ThreadPullRequestService.ts
apps/server/src/orchestration-v2/ThreadSettlementService.test.ts
apps/server/src/orchestration-v2/ThreadSettlementService.ts
apps/server/src/orchestration-v2/goat/DelegatedLaneSettlement.test.ts
apps/server/src/orchestration-v2/goat/RunStartHoldReactor.ts
apps/server/src/orchestration-v2/goat/ThreadForkWorkspace.ts
apps/server/src/orchestration-v2/testkit/pullRequestSync.fixture.ts
apps/server/src/persistence/OrchestrationEventStore.sequence.test.ts
apps/server/src/preview/Manager.ts
apps/server/src/preview/PreviewBrowser.test.ts
apps/server/src/preview/PreviewBrowser.testkit.ts
apps/server/src/preview/PreviewHandoffs.ts
apps/server/src/preview/ServerBrowser.secretFill.test.ts
apps/server/src/preview/ServerBrowserStream.test.ts
apps/server/src/preview/ServerBrowserStream.ts
apps/server/src/process/agentScope.test.ts
apps/server/src/process/externalLauncher.test.ts
apps/server/src/project/ManagedProjectFolders.ts
apps/server/src/project/ProjectSetupScriptRunner.ts
apps/server/src/project/ScratchThreadPromotion.ts
apps/server/src/provider/AcpRegistryProbe.test.ts
apps/server/src/provider/AcpSessionContinuations.ts
apps/server/src/provider/AcpSessionService.ts
apps/server/src/provider/AntigravityAuth.ts
apps/server/src/provider/AntigravityInstallation.testkit.ts
apps/server/src/provider/AntigravityInstallation.ts
apps/server/src/provider/AntigravityInstallationValidate.ts
apps/server/src/provider/ClaudeHomeSettings.test.ts
apps/server/src/provider/CodexChatGptAuth.test.ts
apps/server/src/provider/CodexChatGptAuth.ts
apps/server/src/provider/CodexInstallation.test.ts
apps/server/src/provider/CodexInstallation.testkit.ts
apps/server/src/provider/CodexInstallation.ts
apps/server/src/provider/CodexInstallation.update.test.ts
apps/server/src/provider/CodexToolPresentation.ts
apps/server/src/provider/Drivers/AntigravityDriver.testkit.ts
apps/server/src/provider/Drivers/AntigravityDriver.ts
apps/server/src/provider/Drivers/AntigravityUsage.ts
apps/server/src/provider/Drivers/ClaudeAuth.test.ts
apps/server/src/provider/Drivers/CodexDriver.hostEnvironment.test.ts
apps/server/src/provider/Drivers/CodexDriver.resetCredit.test.ts
apps/server/src/provider/Drivers/CodexDriver.test.ts
apps/server/src/provider/Drivers/CodexDriver.ts
apps/server/src/provider/ProviderCredentialStore.ts
apps/server/src/provider/ProviderHomePiContinuation.test.ts
apps/server/src/provider/ProviderHostLive.ts
apps/server/src/provider/ProviderHostSync.ts
apps/server/src/provider/ProviderOnboarding.test.ts
apps/server/src/provider/antigravityAuthSupport.ts
apps/server/src/provider/antigravityUsageLimits.ts
apps/server/src/provider/resetCreditCoordinator.ts
apps/server/src/pullRequest/PullRequestReadCache.test.ts
apps/server/src/pullRequest/PullRequestReadCache.ts
apps/server/src/pullRequest/PullRequestWatchService.test.ts
apps/server/src/pullRequest/PullRequestWatchService.ts
apps/server/src/relay/AgentAwarenessRelay.ts
apps/server/src/remoteReports/OriginBoundDeleteService.test.ts
apps/server/src/remoteReports/OriginRoutedDelete.test.ts
apps/server/src/requestUrl.ts
apps/server/src/resourceTelemetry/NativeTelemetryClient.ts
apps/server/src/rpc/socketFrameParts.ts
apps/server/src/runtimeIdentity.ts
apps/server/src/scheduledTasks/ScheduledRunFixture.testkit.ts
apps/server/src/scheduledTasks/ScheduledTaskService.ts
apps/server/src/server.heartbeat.test.ts
apps/server/src/server.memoryComposition.test.ts
apps/server/src/server.memoryImportGraph.test.ts
apps/server/src/server.memorySnapshotGraph.test.ts
apps/server/src/server.memorySourceReadGraph.test.ts
apps/server/src/server.ts
apps/server/src/serverOwnership.ts
apps/server/src/serverRuntimeStartup.ts
apps/server/src/sshRemote/SshHostKeys.test.ts
apps/server/src/sshRemote/SshHostSetup.test.ts
apps/server/src/sshRemote/SshHostSetup.ts
apps/server/src/sshRemote/SshRemoteDispatch.test.ts
apps/server/src/sshRemote/SshWorkspaceSync.ts
apps/server/src/sshRemote/dispatchFailure.ts
apps/server/src/sshRemote/placedLaunch.test.ts
apps/server/src/telemetry/AnalyticsService.ts
apps/server/src/telemetry/Identify.test.ts
apps/server/src/telemetry/Identify.ts
apps/server/src/textGeneration/ClaudeMemoryIsolation.test.ts
apps/server/src/usage/cliproxyApi.ts
apps/server/src/vcs/GitVcsDriver.ts
apps/server/src/vcs/GitVcsDriverCore.test.ts
apps/server/src/vcs/GitVcsDriverCore.ts
apps/server/src/vcs/gitMetadataFingerprint.ts
apps/server/src/vcs/pushLocale.test.ts
apps/server/src/vcs/reviewDiffHash.ts
apps/server/src/vcs/testing/configLockRegression.ts
apps/server/src/vcs/worktreeCheckout.ts
apps/server/src/worktreeSnapshots/WorktreeCleanupPreviewStateLive.ts
apps/server/src/worktreeSnapshots/WorktreeSnapshotStoreLive.ts
apps/server/src/ws.ts
apps/server/src/wsHeartbeat.test.ts
apps/server/src/wsHeartbeat.ts
apps/server/src/wsIdleTimeout.test.ts
apps/web/src/cloud/dpop.ts
apps/web/src/cloud/managedRelayLayer.ts
devlog/_chase/010_fork_delta.md
docs/operations/release.md
infra/relay/alchemy.run.ts
infra/relay/package.json
infra/relay/scripts/android-push-watch.ts
infra/relay/src/accounts/AccountDeviceAdmission.ts
infra/relay/src/accounts/AccountLifecycle.ts
infra/relay/src/accounts/AccountRateLimitObject.test.ts
infra/relay/src/accounts/AccountRateLimitObject.ts
infra/relay/src/accounts/RelayRateLimits.ts
infra/relay/src/accounts/test/PolicyWorkerFixture.ts
infra/relay/src/agentActivity/ApnsDeliveries.test.ts
infra/relay/src/agentActivity/ApnsDeliveryQueue.test.ts
infra/relay/src/agentActivity/ApnsDeliveryQueue.ts
infra/relay/src/agentActivity/ApnsDeliveryQueueConsumer.ts
infra/relay/src/agentActivity/DeliveryAttempts.ts
infra/relay/src/agentActivity/DeliveryAuthorization.test.ts
infra/relay/src/agentActivity/FcmDeliveries.test.ts
infra/relay/src/agentActivity/FcmDeliveries.ts
infra/relay/src/agentActivity/FcmDeliveryQueueConsumer.ts
infra/relay/src/agentActivity/FcmDeliveryQueueSender.ts
infra/relay/src/auth/CliLinkApprovals.test.ts
infra/relay/src/auth/CliLinkApprovals.ts
infra/relay/src/auth/ClientKeys.ts
infra/relay/src/auth/ConnectLinkChallenges.postgres.ts
infra/relay/src/auth/ConnectLinkChallenges.ts
infra/relay/src/auth/ConnectTokenExchange.ts
infra/relay/src/auth/connectPostgres.testkit.ts
infra/relay/src/clientConfig.test.ts
infra/relay/src/db.ts
infra/relay/src/environments/ConnectLinkRecovery.postgres.ts
infra/relay/src/environments/ConnectLinkReservations.ts
infra/relay/src/environments/EndpointIdentity.ts
infra/relay/src/environments/EnvironmentConnector.ts
infra/relay/src/environments/EnvironmentCredentials.ts
infra/relay/src/environments/EnvironmentLinker.ts
infra/relay/src/environments/EnvironmentPublishSignatures.test.ts
infra/relay/src/environments/EnvironmentPublishSignatures.ts
infra/relay/src/environments/ManagedEndpointProvider.test.ts
infra/relay/src/environments/ManagedEndpointProvider.ts
infra/relay/src/environments/RetiredEndpointCollector.ts
infra/relay/src/environments/retiredInventoryBinding.ts
infra/relay/src/hooks/HookForwarder.ts
infra/relay/src/hooks/HookInboxObject.test.ts
infra/relay/src/hooks/HookInboxObject.ts
infra/relay/src/http/Api.authentication.postgres.ts
infra/relay/src/http/Api.test.ts
infra/relay/src/http/Api.ts
infra/relay/src/http/RateLimitHttp.test.ts
infra/relay/src/monitoring.ts
infra/relay/src/observability.ts
infra/relay/src/queues.ts
infra/relay/src/worker.ts
infra/relay/src/zone.ts
infra/task-cache/alchemy.run.ts
infra/task-cache/package.json
infra/task-cache/src/WriterRegistry.ts
infra/task-cache/src/observability.ts
infra/task-cache/src/resources.ts
infra/task-cache/src/worker.ts
oxlint-plugin-goat/code-budgets.json
packages/client-runtime/src/operations/commands.performance.test.ts
packages/client-runtime/src/operations/commands.test.ts
packages/client-runtime/src/operations/commands.ts
packages/client-runtime/src/operations/forkThread.test.ts
packages/client-runtime/src/relay/dpopProof.ts
packages/client-runtime/src/state/projectCommands.test.ts
packages/client-runtime/src/state/threadCommands.test.ts
packages/provider-acp-registry/src/server/AcpRegistrySupport.ts
packages/provider-acp-registry/src/server/adapter.environment.test.ts
packages/provider-acp-registry/src/server/auth.ts
packages/provider-acp-registry/src/server/authenticationState.ts
packages/provider-acp-registry/src/server/driver.ts
packages/provider-acp-registry/src/server/probe.ts
packages/provider-acp-registry/src/server/probeFingerprint.ts
packages/provider-acp/src/server/AcpSessionRuntime.ts
packages/provider-acp/src/server/adapter.ts
packages/provider-acp/src/server/nativeLogging.ts
packages/provider-claude-cloud/src/server/testing.ts
packages/provider-core/src/server/maintenanceResolver.bun.test.ts
packages/provider-core/src/server/maintenanceResolver.macports.test.ts
packages/provider-core/src/server/maintenanceResolver.registry.test.ts
packages/provider-core/src/server/maintenanceResolver.test.ts
packages/provider-core/src/server/maintenanceResolver.vitePlus.test.ts
packages/provider-core/src/server/providerAuthFlow.ts
packages/provider-cursor/src/server/CursorAccountReader.ts
packages/provider-cursor/src/server/CursorUsageAccounts.ts
packages/provider-cursor/src/server/accountUsage.ts
packages/provider-cursor/src/server/auth.ts
packages/provider-devin-cloud/src/server/sibling.test.ts
packages/provider-fx/src/server/driver.test.ts
packages/provider-grok/src/server/driver.test.ts
packages/provider-grok/src/server/driver.ts
packages/provider-grok/src/server/textGeneration.ts
packages/provider-muse/src/server/driver.test.ts
packages/provider-opencode/src/server/driver.ts
packages/provider-opencode/src/server/usageLimits.ts
packages/provider-opencode/src/server/v2/OpenCode2Server.ts
packages/provider-opencode/src/server/v2/adapter.ts
packages/provider-opencode/src/server/v2/mcpNames.ts
packages/provider-pi/src/server/test/fakePi.ts
packages/shared/package.json
packages/shared/src/nodeServicesWithCrypto.ts
packages/shared/src/nodeSqliteClient.ts
packages/shared/src/processErrorNet.test.ts
packages/shared/src/relayClient.test.ts
packages/shared/src/relayClient.ts
packages/source-control-core/src/server/driver.ts
packages/source-control-github/src/server/GitHubCredentials.ts
packages/ssh/src/command.test.ts
packages/ssh/src/hostKey.test.ts
packages/ssh/src/managedTrust.ts
packages/ssh/src/master.ts
packages/ssh/src/preflight.test.ts
packages/ssh/src/remoteSessions.ts
packages/ssh/src/runtimeArchive.ts
packages/ssh/src/runtimeArchiveGh.test.ts
packages/ssh/src/runtimeAvailability.ts
packages/ssh/src/runtimePublished.test.ts
packages/ssh/src/runtimePublished.ts
packages/ssh/src/runtimeWindows.ts
packages/ssh/src/stallRelay.fixture.ts
packages/ssh/src/teardown.test.ts
packages/ssh/src/testParentLifetime.test.ts
packages/ssh/src/tunnel.core.test.ts
packages/ssh/src/tunnel.ensure-flight.fixture.ts
packages/ssh/src/tunnel.fixture.ts
packages/ssh/src/tunnel.keyOnly.test.ts
packages/ssh/src/tunnel.pending-manager.test.ts
packages/ssh/src/tunnel.protocol-identity.test.ts
packages/ssh/src/tunnel.protocol.fixture.ts
packages/ssh/src/tunnel.published-fallback.test.ts
packages/ssh/src/tunnel.runner-switch.test.ts
packages/ssh/src/tunnel.runnerSwitch.fixture.ts
packages/ssh/src/tunnel.runtime-cleanup.test.ts
packages/ssh/src/tunnel.runtime-executable.test.ts
packages/ssh/src/tunnel.runtime-fallback.test.ts
packages/ssh/src/tunnel.runtime-status.fixture.ts
packages/ssh/src/tunnel.runtime-status.test.ts
packages/ssh/src/tunnel.shutdown.test.ts
packages/ssh/src/tunnel.ts
packages/ssh/src/tunnel.windowsHost.test.ts
packages/ssh/src/tunnelOwner.test.ts
packages/tailscale/src/tailscaleExecutable.test.ts
patches/@alchemy.run__test@2.0.0-beta.85.patch
patches/@effect__vitest@4.0.5.patch
patches/@effect__vitest@4.1.2.patch
patches/alchemy@2.0.0-beta.80.patch
patches/alchemy@2.0.0-beta.85.patch
pnpm-lock.yaml
pnpm-workspace.yaml
scripts/build-desktop-artifact.test.ts
scripts/mac-notarization.test.ts
scripts/mobile-native-client.ts
```

</details>

