# next3 K7b: plan (C4), rows from K7's D1 and D2

Lane K7b, the same thread and host as K7 (pen-macbookpro2). Plan only: no code branch until K7 is merged, then cut from the integration head. Written on the K7 head 9fb762a2b5 (the integration head 259883c788 merged); every path:line below is at 9fb762a2b5 and is rechecked at the cut.

## Rulings this lane comes from (verbatim)

Coordinator 21:38:37 UTC, K7 section:
- D1 (2482b03a01 with dc3fdc6a3e): both leave K7 and become lane K7b, same thread and host, after K7's READY: dc3fdc6a3e as the prerequisite row, then 2482b03a01 as upstream wrote it (option A, in a second lane). K7b sends its own C4 plan first (dc3fdc6a3e's ancestry, each way, the authorization negatives) and gets its own fresh C4 review. Reason: the descriptor carry and the resumable HTTP shell are an authentication and snapshot change that deserves a review of its own, and K2, K10 and M3 wait on K7's exports.
- D2 (8b2763f638): A now, only the omitProviders refresh reply, inside K7. The delta half is skipped as a duplicate of providerStatusChanges, said in the record. The catalog half goes to K7b as option B (providerCatalogsOnDemand, then digests), with one number in its record: the bytes of the launch config before and after on a seeded dev database.

Lane coordinator, after K7's READY: write K7b's C4 plan as ruled: plan only, in next3-K7b.md on the records branch (dc3fdc6a3e's ancestry, each way for older client and server, the authorization negatives; 2482b03a01 as upstream wrote it; 8b2763f638's catalog half with the launch config's bytes before and after on a seeded dev database copy in your worktree's .goat, no server against real data), ONE needs_input report with the records sha, then end your turn. K7b's code branch is cut later, from the integration head after K7 is merged.

## 1. Ancestry (on the K7 head 9fb762a2b5)

None of the four upstream commits is on dev or in K7. I searched every identifier each one introduces (rg over packages and apps, tests excluded): socketOnlyOpen, failedSocketOnlyOpen, rememberCheckedDescriptor, routeKeepsItsHost, isNearbyAddress, keepIdleConnections, canResumeShellFrom, loadShellUnlessResumable, projectIdentitiesDigest, knownProjectIdentities, OrchestrationV2ShellResumable, EARLY_LOAD_GRACE, providerCatalogsOnDemand, catalogsPerCwd, workspaceSnapshotOrCatalog, providerCatalogDigests, machineCatalog, omitProviders, omitRefreshedProviders and serverProviderDeltas. Each has 0 files. Three names do match, and none is this work: `isAuthorizationFailure` is only a local const in client-runtime rpc/client.ts:604 (dc3fdc6a3e exports it); `catalogDigest` belongs to hub parity and the opencodex child-ready contracts, a different schema; `resumeFrom` belongs to ChannelRemoteWorkers. Server keep-alive: no keepAliveTimeout on the main HTTP server (the only hit is PenListener.ts:87). No chase record names dc3fdc6a3e or #33306 (K7 plan section 1).

Prerequisites found while reading the diffs:
- `9557ab46c5` perf(mobile): thread list resumes from the saved cache, and large gaps reload over gzip HTTP (#32287). It was deferred in 10.023 #71 ("persisted resume must keep GOAT same-instance guard, cache metadata, Hub snapshots"), and L09-retry keeps 476fc9be66's stale-resume check open on it. 2482b03a01's shell half is written on 9557ab46c5: it refactors `canResumeFrom`, `ShellOriginIdentity`, `CACHE_RESUME_MAX_AGE_MILLIS` and `httpSnapshotFallback`, and none of them exists in GOAT's state/shell.ts. GOAT resumes only on the same server instance: shell.ts:440-466 keys the resume on omissions, version and `environment.instanceId`, with in-memory rows only. DECISION B1.
- `2917f28465` (#28487) was taken in 10.021 #311 with its on-demand provider catalog part deferred: providerCatalogsOnDemand and catalogsPerCwd in ws.ts, rpc.ts, rpc/session.ts, state/server.ts and mobile. 8b2763f638's digests are written on it. This is the row the D2 ruling names first.
- GOAT counterparts that change the port:
  - client-runtime authorization/service.ts already has a bearer descriptor cache: BEARER_DESCRIPTOR_CACHE_TTL_MS = 10_000 (:106), verifyDirectEndpoint (:165-201), keyed by environment id and URL. It can be reused within its TTL, applies to any scheme, and is filled only by a connect, never by a route check. dc3fdc6a3e adds a second, single-use cache filled by route and host checks. DECISION B2.
  - contracts server.ts:651-690 and rpc.ts:2224 providerStatusChanges stand in for 8b2763f638's providerStatusDeltas (skipped, as ruled).
  - The server already advertises threadSnapshotPagination: true and shellThreadFamilies/shellOlderSettled in its config (ws.ts:1655-1658), so dc3fdc6a3e's cold socket open has the server half it needs. The descriptor carries instanceId (contracts environment.ts:327), so a prepare-time shell identity can include GOAT's instance guard.

D2's half A (the omitProviders refresh reply) was ruled "inside K7", but section III and the GO limited K7 to rows 1-9, and row 11 left K7. So it has not shipped anywhere. DECISION B3.

## 2. Rows, in order

Each row is one commit; move-outs are their own commits before it (section 5). All rows are C4: wire or authorization.

### R1. dc3fdc6a3e: threads open over the socket, and a checked descriptor carries to the connect (prerequisite)

What: (a) client-runtime state/threads.ts: a cold open (no data, history-capable, the server's config says threadSnapshotPagination) skips the HTTP snapshot once and takes the bounded socket snapshot. Any failure, defect or dropped session sends the next cold attempt to HTTP, which tells a missing thread from a failed load. An authorization failure is never retried that way. (b) rpc/client.ts exports isAuthorizationFailure (the local at :604 becomes the export). (c) authorization/service.ts gains rememberCheckedDescriptor: a route or host check hands its descriptor to the next direct authorization of that address, once, within 5 s, only on an environment id match, only over HTTPS (R3 adds loopback). connection/driver.ts's checkDescriptor (:205-220) records every answer, a failure included, so a failure clears what an older check left.
GOAT adaptation: threads.ts's open path is now K7's row 2 version (state/threadSubscriptionRecovery.ts). The socket-only retry joins that module's resubscribe queue; it is not upstream's second queue. driver.ts keeps GOAT's `credentials: "omit"` and `isConnectionRouteEnabled` on the check.
Each way:
- Newer client, older server: no threadSnapshotPagination in the config, so the client opens over HTTP as today. A server that sets the flag but drops the socket snapshot falls back to HTTP after the first failure.
- Older client, newer server: no wire change; the server is not touched.
- Reconnect during a cold open: the session drops, `socketOpenTried` is already set, and the next attempt asks HTTP.
Authorization negatives, each pinned by a test:
- (1) A descriptor remembered for http://192.168.x (plain LAN) is never used; the connect reads its own.
- (2) A remembered descriptor whose environmentId differs is ignored, and the connect reads again (no mismatch error from the cache).
- (3) After more than 5 s (TestClock) it is ignored.
- (4) It is used once; a second connect reads again.
- (5) A failed check replaces an older remembered answer.
- (6) The route check still sends no credential (`credentials: "omit"` kept).
- (7) A thread's authorization failure on the socket shows its error and does not retry over HTTP.
Tests: upstream's authorization/layer.test.ts cases and threads-sync cases. layer.test.ts (965, no entry) takes them in place. threads-sync.test.ts is at its entry (2099), so its cases go to a sibling file (`threads-sync.socketOpen.test.ts`) on the makeHarness in threadsSync.testkit.ts. threads-atoms.test.ts: upstream rewrites 163 lines of it; see section 6.

### R2. 9557ab46c5 (only if B1 = A): the shell resumes from the saved cache, with GOAT's instance guard

What: the thread list resumes from a saved snapshot origin (ShellCacheOrigin: serverVersion, databaseMigration, omissions, snapshotAt, at most 12 h old). A large gap reloads over gzip HTTP (`httpSnapshotFallback`), and the server answers a stale resume with a snapshot. GOAT adaptation: the origin adds instanceId, so a cached shell resumes only on the same server instance, as GOAT does today in memory. Hub-proxied environments keep their existing snapshot path. The cache metadata uses GOAT's platform/orchestrationCache.ts (the 10.023 coordinator note says it exists; only environment-cache-store.ts is absent).
Each way:
- Older client, newer server: no httpSnapshotFallback, so the server behaves as today.
- Newer client, older server: the server ignores the key (a non-strict Struct; checked at the cut with a decode case). The client resumes only rows whose origin matches the live instanceId, so an older server that restarted gives a fresh load.
- Reconnect during a resume: the origin is checked again on each subscribe.
Negatives: a cache from another instance or build is not resumed; a cache older than 12 h is not; a migrated database (databaseMigration changed) reloads; a refusal of held rows falls back to the socket snapshot once and cannot loop.
Size: L by itself (shell.ts +230/-126 upstream, shell-sync.test.ts +179).

### R3. 2482b03a01, as upstream wrote it: threads load while the socket connects

What: server. HTTP GET /api/orchestration/shell answers `{resumable:true}` to a `resumeFrom` cursor the socket can replay (canResumeShellFrom, moved from ws.ts's canReplayPersistedRange at :454 and :578, the same gap and payload rules). The HTTP snapshot carries `projectIdentities` (a sha256 of project ids and repository identities). The subscribe input takes `knownProjectIdentities`, so a resume that has the same identities skips resending them. The descriptor capabilities gain shellThreadFamilies and shellOlderSettled (ServerEnvironment.ts). The HTTP server keeps idle connections 95 s (httpResponseErrorGuard.ts keepIdleConnections; server.ts one wrapper call).
Client: shell.ts starts the HTTP shell load when the connection is prepared, from the descriptor's flags, and the subscription claims it. It waits at most 3 s for an answer when held rows could resume. authorization/service.ts carries the descriptor its DPoP mint read, reads a cached token's descriptor beside the ticket, and gives nearby addresses a 3 s descriptor timeout. routes.ts adds routeKeepsItsHost (HTTPS or loopback) and isNearbyAddress. The connection model and resolver carry the descriptor on PreparedConnection.
GOAT adaptation:
- the prepare-time identity includes instanceId (B1);
- the hub-proxied connection (driver.ts, hubProxySocket.ts) starts no early load unless its HTTP route is the one the socket uses;
- the server side lands on GOAT's ShellStream.ts and http.ts, and ws.ts keeps only the call sites (ws.ts is at its entry, section 5).
Each way:
- Older client, newer server: it never sends resumeFrom, so it always gets a snapshot, now with an optional projectIdentities key, which an older decoder ignores (a decode case with the previous schema). It sends no knownProjectIdentities, so the resume is as today. Descriptor capabilities are optional keys.
- Newer client, older server: the descriptor names no shellThreadFamilies, so there is no early load (today's order, a test). If an older server that does send the flags gets resumeFrom, it ignores the query key and sends a snapshot, which the client decodes through the union (a test). No knownProjectIdentities is honoured, so the server resends identities as today.
- Reconnect during the early load: a new prepared connection interrupts the old load. A claimed load that is still running is handed to the next subscription, never duplicated (upstream's case). A late answer after the 3 s cut applies nothing.
- Stale replay: an HTTP answer never lands on rows the socket moved past, because the subscription waits for the load and items from a closed session are dropped. A server that says `resumable` but whose socket then refuses falls back once to the socket snapshot.
Authorization negatives, each pinned by a test:
- (1) loopback counts as keeping its host, but GOAT's SSH forwards also listen on loopback. A forward re-pointed to another environment within 5 s is caught by the environmentId match: the connect reads again and does not connect.
- (2) A cached DPoP token's parallel descriptor read is interrupted when the ticket fails, and the ticket's error surfaces (blocked stays blocked).
- (3) A cached token whose descriptor read fails fails the connect; there is no silent connect without a descriptor (upstream's behaviour; GOAT Connect is not available, so this path is unit-tested only).
- (4) The early shell load sends the same authorization as today's HTTP shell request. A connection without httpAuthorization starts no early load.
Tests: upstream's ws.test.ts, http.test.ts, httpResponseErrorGuard.test.ts, routes.test.ts, layer.test.ts and shell-sync.test.ts cases. ws.test.ts (1331) and shell-sync.test.ts (1111) are at their entries, so their cases go to sibling files. The transfer budget integration files take upstream's hunks (IV mirrored).

### R4. 2917f28465's deferred part: providerCatalogsOnDemand (D2 option B, first)

What: a client that already asks for workspaceSnapshotsOnDemand can also ask for providerCatalogsOnDemand. For providers that can scan a cwd (snapshotForCwd: codex, claude, cursor, grok, opencode, antigravity and pi in GOAT; ACP registry agents and cloud providers cannot), the config then carries slash command names and skills without descriptions. The full entries come with the cwd snapshot the composer already fetches. A failed cwd scan replies with the machine catalog as a pending snapshot. Mobile opts in (apps/mobile connection/runtime.ts and state/server.ts), as upstream does; web keeps the full lists.
Each way:
- Older client, newer server: no opt-in, so it gets full lists as today.
- Newer client, older server: the option is ignored (non-strict Struct, a decode case), and full lists arrive. The client then holds full entries, which it reads as today.
- Reconnect: the option is sent on every subscribe.
Negatives: a provider without snapshotForCwd keeps its full lists (ACP registry agents); a replaced instance is re-read per update; skill links keep working from names and labels without a cwd snapshot (upstream's case).

### R5. 8b2763f638's catalog half: catalog digests and the machineCatalog reply (D2 option B, then)

What: with providerCatalogDigests, a cwd-capable provider's config entry carries `catalogDigest` (16 hex characters of sha256 over its full slash commands and skills) and empty lists. The client keeps the lists it holds (`loadedCatalogDigest`, set by the client, never sent) and loads new ones with its next cwd snapshot. A cwd reply asked with machineCatalog also carries the names and the digest. Mobile opts in. Skipped from 8b2763f638: providerStatusDeltas, serverProviderDeltas and ServerConfigStreamProviderStatusDeltasEvent, duplicates of providerStatusChanges as ruled.
Each way:
- Older client, newer server: it never asks for digests, so it gets lists.
- Newer client, older server: no catalogDigest arrives, so the client uses the lists it received (a test).
- Reconnect: a digest equal to the held one keeps the held lists; a changed digest triggers a cwd snapshot fetch.
Negatives: a stale cached list under a changed digest is never shown as current (the refetch case); a client that held no lists treats a digest as "load" and never as empty; loadedCatalogDigest never goes to the server (a test on the sent payload).

### R6. (only if B3 = here) 8b2763f638's omitProviders refresh reply

What: server.refreshProviders with omitProviders replies with no providers when it has no instanceId and cwd; the config stream carries the result. Callers that only wait for a refresh opt in: mobile useSubscriptionUsage (omitRefreshedProviders) and the client-runtime refresh command. Each way: an older server ignores the key and sends providers, which the waiter ignores. An older client never sends it. Negative: with instanceId and cwd the reply is still the snapshot (the key is ignored).

## 3. The launch config, measured (D2's one number)

Seeded dev database: `vp run migrate-dev-db` rebuilt this worktree's .goat/userdata/statev2.sqlite from a read-only snapshot of ~/.goat/userdata/statev2.sqlite (5.6 GB source, 302.9 MB result, 5 projects). Then `GOAT_DEV_SEED=0 vp run dev:server` started the server against the worktree's .goat (127.0.0.1:15889, PID 70699, cwd this worktree). It was stopped through its session (Ctrl-C; "Server shutdown finished { exit: 'interrupted' }"). Provider catalogs come from this machine's provider CLIs and their on-disk skills, read only.

Client: a script (outside the repo) paired with the server's startup token, got an rpc WebSocket ticket, and sent mobile's request: subscribeServerConfig { usageLimitSources, usageLimitsCommand, workspaceSnapshotsOnDemand }. It recorded the first snapshot event, as JSON without compression:
- BEFORE (GOAT today): 182,228 bytes (frame 182,272). The providers take 145,008. Machine slash commands and skills: codex 430 + 37,307 (4 commands, 58 skills); claudeAgent 30,788 + 21,120 (95 commands, 40 skills); acpRegistry_devin 11,958 (47 commands, no snapshotForCwd).
- AFTER R4 (names only for cwd-capable providers): 108,424 bytes, 40.5% less.
- AFTER R5 (digests for cwd-capable providers): 89,702 bytes, 50.8% less.
The two after numbers apply upstream's transforms (machineCatalogNames and machineCatalogDigest, verbatim) to the captured snapshot. They are computed, not served. K7b's record measures them again on the server once R4 and R5 are in. Upstream's "about 85% less" also counts deltas, which GOAT already gets from providerStatusChanges. The catalog bytes move to the cwd snapshot a composer fetches when it opens; they are not removed.

## 4. Exports and shared surfaces K7b changes (for K2, K10, M3)

- contracts: environment.ts ExecutionEnvironmentCapabilities shellThreadFamilies/shellOlderSettled (optional); environmentHttp.ts shell query resumeFrom and success union; orchestrationV2.ts OrchestrationV2ShellHttpSnapshot, OrchestrationV2ShellResumable, subscribe input knownProjectIdentities (and httpSnapshotFallback with R2); rpc.ts subscribeServerConfig providerCatalogsOnDemand and providerCatalogDigests, refreshProviders providerCatalogsOnDemand, machineCatalog and omitProviders; server.ts ServerProvider catalogDigest and loadedCatalogDigest.
- client-runtime: rpc/client.ts isAuthorizationFailure; authorization/service.ts rememberCheckedDescriptor; connection/routes.ts routeKeepsItsHost and isNearbyAddress; connection/model.ts PreparedConnection.descriptor; state/shellSnapshotHttp.ts ShellSnapshotOptions, ShellHttpSnapshot and ShellHttpAnswer (ShellSnapshotLoader.load's return type changes); rpc/session.ts and state/server.ts options providerCatalogsOnDemand and providerCatalogDigests (and omitRefreshedProviders with R6); state/runtime.ts createEnvironmentRpcCommand's execute gains (registry, environmentId) (8b2763f638).
- server: ShellStream.ts canResumeShellFrom, loadShellUnlessResumable, projectIdentitiesDigest and resumeIdentityRoots; httpResponseErrorGuard.ts keepIdleConnections.

## 5. Budgets and move-outs (entries at 9fb762a2b5; rechecked at the cut)

Files a row writes into that are at their entry: client-runtime state/threads.ts 1079 (R1 +~35), state/server.ts 1564 (R4 +4, R5 +~150 upstream), server ws.ts 3521 (R3 net about -25 after canReplayPersistedRange moves out; R4 +~55; R5 +~90), server.ts 1294 (R3 +1), contracts orchestrationV2.ts 4421 (R3 +21, R2 +12), rpc.ts 2788 (R4 +4, R5 +10, R6 +5). Test files at entry: ws.test.ts 1331, shell-sync.test.ts 1111, threads-sync.test.ts 2099, client-runtime server.test.ts 1252, rpc/session.test.ts 1013. Their new cases go to sibling files (D4); an existing case upstream edits is section 6.
Claims carried from K7 (accepted on card 10.028, not cut; both ranges unchanged since c995c5427a, git diff empty): ws.ts :556-576 (doc comment and readClientOwners) to wsClientOwners.ts, 21 lines; rpc.ts :837-858 (the three preview session RPCs) to rpcPreviewSessions.ts, 22 lines. New claims sent at the cut, with ranges at the integration head: threads.ts (a block of at least 35 lines), state/server.ts (at least 160), ws.ts (one more block if R4 and R5 exceed what claim 10 and the canReplayPersistedRange move free), orchestrationV2.ts (at least 33), server.ts (at least 1). Each block goes on card 10.028 before it is cut.

## 6. Rule 3 items expected

Upstream edits existing cases in these GOAT files: authorization/layer.test.ts, connection/resolver.test.ts, state/environmentHttpAuth.test.ts, state/threads-atoms.test.ts (163 lines, a rewrite of its cold-open cases), threads-sync.test.ts, shell-sync.test.ts, ws.test.ts, orchestration-v2/http.test.ts, connection/routes.test.ts, rpc/session.test.ts, state/server.test.ts, serverConfigProjection.test.ts, mobile useSubscriptionUsage.test.ts and the transfer budget integration files. Each hunk is checked against IV (i)-(vi) and quoted in the record before its commit. I expect threads-atoms.test.ts's rewrite and any case whose GOAT result differs from upstream's text by more than names to come to the coordinator with exact before and after. Older upstream behaviour that GOAT's tests pin (GOAT's own instance guard) is one more reason a hunk may not mirror.

## 7. Order and size

R1 (M) -> R2 (L, if B1 = A) -> R3 (L) -> R4 (S) -> R5 (M) -> R6 (S, if B3 = here), each after its move-outs. Size: L+ with R2, about 2,600 changed lines with tests. Without R2 (B1 = B), about 1,900.

## 8. Decisions for the coordinator

B1 (9557ab46c5, the shell resume from cache). 2482b03a01's shell half refactors 9557ab46c5's cache-origin resume, which GOAT deferred in 10.023 #71. (A, my recommendation) Add 9557ab46c5 as row R2 with GOAT's instance guard (origin includes instanceId), so 2482b03a01 then ports as upstream wrote it, which is what D1 asked for. (B) Port 2482b03a01 onto GOAT's in-memory same-instance resume. The prepare-time load and resumeFrom work only for rows held in memory from the same instance, the shell.ts hunks are rewritten rather than ported, and the 476fc9be66 open row stays open. (C) Port only 2482b03a01's server half and its connection half (keep-alive, descriptor capabilities, the resumable route, descriptor carry), and defer the client prepare-time load with 9557ab46c5.

B2 (two descriptor caches). dc3fdc6a3e adds a route-check cache (single use, 5 s, HTTPS or loopback) beside GOAT's bearer cache (verifyDirectEndpoint, 10 s, reusable, any scheme, connect-filled). (A, my recommendation) Port as upstream wrote it: two maps, each with its own rule, and no change to GOAT's cache. (B) Fold route-check entries into GOAT's cache under the stricter rule. A keeps the port mirrored and GOAT's behaviour unchanged. B is one cache, but it changes GOAT's existing cache semantics in an authorization path.

B3 (omitProviders). D2's half A was ruled inside K7, but K7 ran rows 1-9 only, so it has not shipped. (A, my recommendation) It becomes K7b's last row R6, small and independent. (B) It goes to its own small branch now, since it touches only rpc.ts (at entry, under claim 11), ws.ts and the mobile and client-runtime refresh callers.

B4 (split). K7b with R2 is L+. (A, my recommendation) Keep one lane with two fresh C4 reviews at a natural cut: K7b-1 = R1 to R3 (connection and shell, authorization) and K7b-2 = R4 to R6 (config wire). They share no file except ws.ts and rpc.ts, which the move-outs free first. (B) One lane, one review.

## 9. Risks

- R3 changes the order of every connect: the shell loads before the socket opens. A proxy that blocks /api must not hold a connect (the 3 s grace, a test).
- R1 and R3 touch authorization: a descriptor from one address used for another. The environmentId match, single use, 5 s and keepsItsHost bound it; the negatives above pin each rule.
- R2 persists a resumable cache: a stale cache that resumes on another instance. The origin includes instanceId (a test).
- K2, K10 and M3 build on K7's exports. K7b's changes to ShellSnapshotLoader.load and createEnvironmentRpcCommand's execute signature reach their callers; the record names them.
- Hub parity fixtures (apps/server/src/hub/fixtures/parity.json) may list ServerProvider or shell fields; checked at the cut.

## 10. NOT RUN expected

- A live GOAT Connect relay (the DPoP cached-token path): GOAT Connect is not available, so unit tests only.
- A native mobile run (mobile opts in to R4 and R5): client-runtime tests cover the path, and the alert and composer go to P1.
- An older GOAT release: older peers are covered by decode cases with the previous schemas.
- A slow-link timing (upstream's round-trip claim): no number is claimed.
- The after bytes served by a K7b server: measured again once R4 and R5 exist; section 3's after numbers are computed.

The seeded .goat copy (303 MB) stays in this worktree for that measurement and is removed when K7b ends.
