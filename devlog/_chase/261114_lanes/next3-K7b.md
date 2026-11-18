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

## Coordinator, 2026-11-17 23:58 UTC, II and V, verbatim

II. K7: the conn review STARTED at 23:5x UTC on 9fb762a2b5 (task goat-next3-K7-conn-review-9fb762a2, the slot K10's review freed). The wire review starts when K5's review reports. Head stays put.
On K7's prepared answers (records b167790ba4), which the reviewers will check:
- (g) RULED now, for the fix round: B. The stored outcome, the shell, the toast and the MCP thread detail carry only sentences the server wrote: the fixed ones that exist (no project, no messages, over two minutes) and a generic "Title generation failed." for anything that is raw provider or CLI output. The raw text goes to the server log only. Where the server can classify the cause without quoting the text (not signed in, quota), a fixed sentence per class is allowed, each with a case. Record it in the fork delta as a difference from upstream, with the reason: the plan said no provider text beyond today's, and a CLI's last stderr line can be anything.
- (a) accepted as a test gap: one case that drives the REAL supervisor through a dying socket, in the fix round.
- (b), (d), (k): options, not ordered. They wait for the reviewers' reading; no code before the two reports.
- (i): the command palette and the mobile thread screen report nothing: the wire reviewer weighs it; K7 writes which of the two can take the outcome in a few lines.

V. K7b PLAN: ACCEPTED with these rulings (records 404031ba9a; I read the rulings quoted, R2, sections 3 to 10).
B1: A. 9557ab46c5 comes in as R2 with GOAT's instance guard, so 2482b03a01 ports as upstream wrote it. B would be a GOAT-only rewrite in an authorization and snapshot path, and C would ship a server route no client calls. Conditions: (1) quote 10.023 #71's reason for deferring 9557ab46c5 and say why it no longer holds or how R2 meets it; (2) say what instanceId is and how long it lives (per process start, or stored per install). If it changes on every server start, say what R2 then saves; if it survives a restart, add the negative for a database that went BACKWARDS under the same instance (a restored backup after an update rollback, N10's C17): a cached shell ahead of the server's sequence must reload, not resume; (3) the saved cache: where it is stored on web and on mobile, its size bound and eviction, that unpairing or signing out removes it, and that a cache written by another client build or schema fails closed to a fresh load (a case); (4) two tabs or two devices on one cache.
B2: A, two caches as upstream wrote them, GOAT's bearer cache untouched. Condition: a case that an entry of GOAT's looser cache (10 s, reusable, any scheme) can never satisfy the route-check use, and the record names every reader and writer of each map.
B3: A, omitProviders is R6.
B4: A, two READYs with a fresh C4 review each. ORDER CHANGED: K7b-2 (R4 to R6, the config wire) goes FIRST: it is small, independent of R1 to R3 by your own account, and it carries the measured gain (182,228 to about 89,702 bytes for mobile's launch config). Its READY comes with the served bytes. K7b-1 (R1 to R3) follows, cut from the integration head after K7b-2 merges. If R5 needs anything from R1 to R3, say so before the cut and keep your order.
Rule 3: threads-atoms.test.ts's rewrite and every hunk that is not mirrored come to me with before and after, as you say. Both code branches are cut only after K7 has merged. The seeded .goat copy may stay until K7b-2's measurement and is removed then.

Queue now: reviews running K5 and K7 conn. Next slots: K7 wire; fix-delta reviews of K5 and K10 go ahead of any first review not yet started.

## Coordinator, 2026-11-17 23:50:37 UTC, II, verbatim

II. Queue and one rule changed.
- K7's wire review STARTED now (task goat-next3-K7-wire-review-9fb762a2), beside the conn review. Both read 9fb762a2b5; K7's head stays put until both report.
- A fix-delta review (small: the delta and its test files only) does not count against the cap of two. So K5's fix-delta review starts as soon as its head and runs are there, and K10's likewise.
- SF3 and N10 may start code now (K5's review has reported), heavy jobs by the machine token, K5's and K10's fix rounds first.

## Answers to V's conditions (no code; read at 9fb762a2b5)

Order: K7b-2 (R4, R5, R6) first, then K7b-1 (R1, R2, R3), each branch cut from the integration head after K7 has merged. K7b-1 is cut after K7b-2 merges. R5 needs nothing from R1 to R3. Its upstream parent chain is 2917f28465 (R4) -> 8b2763f638, both older than 2482b03a01 (git log dc3fdc6a3e..2482b03a01^ lists 8b2763f638 inside the range), and it touches none of R1-R3's files except ws.ts and rpc.ts: different blocks (subscribeServerConfig and refreshProviders against the shell subscribe and HTTP shell). The one shared surface is client-runtime state/runtime.ts (8b2763f638 widens createEnvironmentRpcCommand's execute); R1 to R3 do not touch it. So the order stands as ruled.

B1 (1). 10.023 #71's reason, verbatim from the card (devlog/_chase/_fin/10/10.023_t3_chase_cycle_261109.md:123): "미룸(persisted resume must keep GOAT same-instance guard, cache metadata, Hub snapshots and d…)", note column: "Large shell-resume rework: GOAT has the pre-change packages/client-runtime/src/state/shell.ts:462 resume logic and no environment-cache-store.ts/orchestrationCache.ts, plus GOAT apps/server/src/ws.ts diverges. Re-implement: thread list resumes from saved cache origin, large gaps reload via gzip HTTP in packages/client-runtime/src/state/shell.ts + shell-sync.test.ts, apps/server/src/ws.ts/ws.test.ts, contracts orchestrationV2.ts; keep GOAT HubProxy/SSH guards. Coordinator (261109): GOAT already has packages/client-runtime/src/platform/orchestrationCache.ts; only environment-cache-store.ts is absent (R3)." How R2 meets each part:
- Same-instance guard: the saved origin carries the server's instanceId, and a resume needs the live instanceId to match, in addition to upstream's serverVersion, omissions and age. GOAT's in-memory rule (shell.ts:440-466, omissionKey with version and instanceId) becomes the persisted rule, with the same key.
- Cache metadata: both stores now exist. orchestrationCache.ts holds StoredOrchestrationShellSnapshot, and mobile has apps/mobile/src/connection/environment-cache-store.ts (253 lines), so the "absent" note is out of date. The origin goes into the same record as the snapshot; see (4) for why it is not a separate key.
- Hub snapshots and the HubProxy and SSH guards: a connection resumes only from its own prepared descriptor's instanceId. A hub-proxied environment whose descriptor carries no instanceId never resumes from cache and loads fresh. An SSH runtime gets a new instanceId per runtime start, so it resumes only within one runtime's life. Neither path gains a way to resume across a server it did not see.
- ws.ts divergence: the server half is small (9557ab46c5's ws.ts +22: answer httpSnapshotFallback with a snapshot when the gap is too large). It lands in ShellStream.ts with call lines in ws.ts, inside the move-outs.

B1 (2). instanceId is a random UUID drawn once per server process start: apps/server/src/runtimeIdentity.ts:12-17 (`instanceId: yield* random.uuidV4()` in the layer), carried in the descriptor (contracts environment.ts:326-327, "New for every server start") and read by ServerEnvironment.ts:217. It is not stored per install. So the backwards database case cannot resume: a restored backup needs a restart, which mints a new instanceId, and the cached origin then fails the match and reloads. I will still add that case, cheaply: a cached shell whose cursor is ahead of the server's sequence under the same instanceId reloads and does not resume (the server's canReplay check refuses a negative gap; ShellStream canResumeShellFrom: replayGap < 0 -> false). It guards a future change that makes instanceId durable.
What R2 then saves: a client that starts again while the same server process keeps running. Examples: the mobile app relaunched or woken after the OS killed it, a web tab reloaded, a desktop window reopened, a PWA brought back. Today each loads the full shell snapshot (the HTTP shell route, or the socket snapshot); with R2 it subscribes from its cursor and gets only the events since. It saves nothing across a server restart, and the measurement in K7b-1's record will say how large the shell snapshot is on the seeded copy.

B1 (3). Where the cache lives:
- web and desktop: IndexedDB database "goat:connection-runtime", store "shell", key environmentId (apps/web/src/connection/storage.ts:64-67, :730-780).
- mobile: the app's SQLite database, table client_cache, kind "shell", key "snapshot", per environment, with the schema version as a column (apps/mobile/src/persistence/mobile-database.ts:272, :369; environment-cache-store.ts:137-146).
Size bound and eviction: one shell snapshot per paired environment, overwritten on every save; there is no history of snapshots, so the bound is environments x one snapshot. A thread cache is separate and not part of R2.
Removal: the registry clears every cache of an environment when it is removed or unpaired (client-runtime connection/registry.ts:725-735 and :806-816, cache.clear plus ownedDataCleanup.clear). GOAT has no separate sign-out for a paired environment: removing the pairing is the sign-out. A GOAT Connect account sign-out is not available yet.
Another build or schema: StoredOrchestrationShellSnapshot pins `schemaVersion: Schema.Literal(3)` (orchestrationCache.ts:12, :16-20). R2 adds the origin and raises it to 4. A record written by a build with another version fails decode, and decodeOrDiscardOrchestrationCache deletes it and loads fresh (orchestrationCache.ts:32-37; web storage.ts loadShell). That holds both ways: an older build reading a 4, and a newer build reading a 3. Case: a stored record of the other version gives a fresh load and no resume, and the record is gone afterwards.

B1 (4). Two tabs: they share one IndexedDB store and one key per environment, so the last writer wins. Today the snapshot and its meta are two writes (shell.ts:153 and :168, :346-347; web storage.ts uses "<env>" and "<env>:meta"). Two tabs can interleave them, leaving tab A's snapshot with tab B's sequence. R2 therefore stores the origin, including sequence and instanceId, inside the snapshot record, in one write, and the separate meta stays only for what reads it today. A tab that starts from another tab's newer record resumes from that record's cursor on the same instance, which is valid: both snapshots came from the same server process and the cursor names what the record holds. Case: two writers interleaved, then the reader resumes from the record's own cursor, never from a mismatched pair. Two devices: each has its own store (IndexedDB per browser profile, SQLite per app install), so nothing is shared and nothing changes.

B2. Readers and writers of each map, at 9fb762a2b5 plus R1:
- GOAT's bearerDescriptors (authorization/service.ts:151; 10 s, reusable, any scheme, keyed by environmentId with the URL checked). Its only writer is verifyDirectEndpoint (:187-197, after a fresh read). Its only reader is verifyDirectEndpoint (:172-176). verifyDirectEndpoint's callers: authorizeBearer for non-SSH connects (:230; SSH reads fresh, :225-229), authorizeDpop's direct endpoint (:550), and authorizeDpopHttp's direct endpoint (:613).
- R1's checkedDescriptors (new; 5 s, single use, HTTPS or loopback after R3). Its only writer is rememberCheckedDescriptor, called from connection/driver.ts checkDescriptor (route checks via checkRoute and host checks via checkHost). Its only reader is the direct-endpoint descriptor read: in GOAT, verifyDirectEndpoint, when the bearer map has no usable entry, and before a fetch. The entry is deleted on read.
- The route-check use: checkDescriptor itself reads neither map. It always fetches the descriptor fresh, with `cache: "no-store"` and `credentials: "omit"` (driver.ts:205-220). So an entry of GOAT's looser cache can never answer a route check, and an entry of the checked map can never outlive one use or come from a plain-LAN address.
- Cases: (1) a connect fills bearerDescriptors, then a route check for the same environment and URL still fetches, counted by the fake HTTP client, and its answer decides "answered" or "silent" on its own; (2) a bearerDescriptors entry for http://192.168.x does not land in checkedDescriptors and is not handed to the next connect as a checked descriptor; (3) the reverse: a checked entry, once used, is gone, and a second connect reads the bearer map or fetches.


## K7b implementation cut, pen-mac-studio

C4 at `f82d2df4b0`, with K7 present. K7b-2 precedes K7b-1. Within K7b-2 the order is R4 (2917f28465 catalog), R5 (8b2763f638 digests), R6 (8b2763f638 omitProviders). K7b-1 starts with R2 (9557ab46c5), then R1 (dc3fdc6a3e), then R3 (2482b03a01). The coordinator owns integration and C4 review. No dev server on this host. The byte measurement will use the production config handler in process against data from a read-only seeded .goat copy, recording the exact input and any fixture substitution.

- R4/R5: an older client receives the same full catalogs unless it explicitly opts into R4's names-only projection. An older server strips unknown opt-in keys and returns full lists. The client interprets an absent digest as authoritative lists, and a new digest as requiring a fetch. The server projects only providers that scan a cwd, including on replacement. Skill name and label survive R4. Failed scans retain the pending marker. GOAT's providerStatusChanges remains the wire delta, so its application and initial seeding must account for held lists. A late cwd reply applies its machine catalog only when the digest agrees. The client never sends loadedCatalogDigest. Project-scoped identities and provider RPC permission checks still apply.
- R6: older clients get providers by default. Older servers may return them even on the wait-only path. Explicit per-instance or per-cwd refreshes still carry their reply. Denied callers receive the existing authorization error before any side effects.
- R2/R3: an older client sends no fallback or resume query and continues to get the snapshot. An older server strips unknown subscribe keys and might respond to a resume query with a full snapshot. The new client accepts either response and skips early load without the descriptor flags. Cache origin and cursor share one record, version 4, bound to the server's random per-process instance ID, server build, age, omissions and database migration. Restarted, forward-cursor, old-schema and hub-without-instance records go through a fresh snapshot. The early HTTP request uses the existing authorization and must not be applied after a session closes.
- R1: older servers without thread pagination continue to open over HTTP, and older clients have no new requirement. A declined/dropped cold socket open can retry once over HTTP, except an authorization denial. GOAT's ten-second bearer cache remains connect-only, and independent checked descriptors are one-use and five seconds. Route checks fetch without credentials, ignore the bearer cache, and evict a checked entry on failure. Cases include plain LAN, environment mismatch, expired cache, reused entry, and a retargeted loopback forward.

Cut anchors for the first gate: apps/server/src/ws.ts:1582 (initial config), :2289 (refresh), :3220 (subscription); packages/contracts/src/rpc.ts:862 and :2217 (the two RPC payloads), server.ts:689 (GOAT changes event); packages/client-runtime/src/state/server.ts:1503 (guarded refresh), rpc/session.ts:201 (wire options); packages/client-runtime/src/state/shell.ts:440–466 and platform/orchestrationCache.ts:12 (current same-instance and storage version); apps/server/src/runtimeIdentity.ts:16 (per-process UUID), packages/client-runtime/src/authorization/service.ts:151, :165, :230, :550, :613 (bearer owner and callers), connection/driver.ts:205 (fresh check). Every implementation hunk is checked against the current consumers as it lands.

### Upstream range 93cbca3fcbd..8a6342e7613

Exact upstream files touched by the five supplied commits have 52 newer commits in this range. The follow-up search by feature identifier (`providerCatalogsOnDemand|providerCatalogDigests|loadedCatalogDigest|omitRefreshedProviders|knownProjectIdentities|loadShellUnlessResumable|rememberCheckedDescriptor|httpSnapshotFallback|socketOnlyOpen|canResumeShellFrom|CACHE_RESUME_MAX_AGE`) returned no commits. Path matches follow for subsequent chase triage.
- 055b44919e feat(web,mobile,desktop): translate the whole app into every supported language (#37893)
- 2ebe7f8e22 fix(pi): fork historical turns from their original session (#38315)
- 74b1f97ce9 fix(web): reopening Settings reloads WSL distributions (#38281)
- 10784e01f8 fix: expired-session error card asks to pair again and names the rejected request's trace (#38041)
- 2904c397ad fix(server): fork a running Claude thread natively (#37955)
- 86863beede feat(issues): add Linear as a standalone issue tracker (#19274)
- 0597b9edcd feat(issues): link issues to threads and expose issue tools to agents (#19270)
- 85dcfa61ca feat(web): add the Issues page and issue detail panel (#19260)
- 20501a0221 feat(issues): add issue tracking core with GitHub issues (#19259)
- 9d28fc921b feat(themes): theme CSS can hold 100,000 characters (#37781)
- 9e32c95576 fix(client-runtime): show routes whose host refused this device's sign-in (#33199)
- 4ffa1da7cf fix(server): t3_thread_launch refuses an explicit branch that already exists (#31279)
- 27411651a4 fix(auth): bind automatic pairing codes to peer links (#37825)
- b79d277cdd fix(server): a thread_send follow-up waits only on background work its own runs started (#37793)
- ca432d7ed6 fix(server): log the connections the private-network gate closes (#31647)
- 7d32075e37 feat(web): themes can use full-size background images (#36680)
- 19b33eca4c fix(server): remote tasks report their actual model (#37332)
- c2e54e3ac9 fix(acp): recognize sessions already owned by a thread (#37244)
- 14f295e011 fix(terminal): one web viewer answers shared PTY queries (#37233)
- dcaedc9800 fix(server): skills linked by a SessionStart hook appear in the $ picker in the same session (#37165)
- 46f3ab39f2 fix(web): open terminal file links naming the server hostname (#37133)
- 94edd64e74 perf(server): skip compression for the desktop's local connection (#30832)
- efddcfeb20 perf(server): batch terminal output that arrives within 2 ms (#37060)
- 17db7082c0 fix(server): preview port discovery stops polling while no client is in the foreground (#29782)
- a62bc8156d perf(server): message ordinals are read through an index, not a scan (#30873)
- ec844a3995 fix(client-runtime): omit machine labels from relay spans (#30940)
- e82050b8b9 feat(themes): theme CSS can hold 50,000 characters (#36656)
- b60abf32e0 perf(server): Windows process launches no longer block the RPC thread (#32260)
- 7f7a1a447a fix(install): launch t3 by absolute path (#13794)
- 3a5d7f39a8 fix(server): Swift TestFlight clients can read settings again (#26455)
- eec0a37227 fix(server): a zero Git fetch interval also stops the status upstream fetch (#33845)
- a4bf7922f5 fix(clients): undoing a settle puts the thread back where you placed it (#33248)
- 1e9f93a48e fix(mobile): stop showing "cannot control this task" while permissions load or after a network blip (#28708)
- 719042d942 fix(server): MCP-launched threads no longer flash in Inbox before Working (#36682)
- 2b596b8690 fix(web): context meter no longer keeps the retired provider's usage (#28581)
- a575d45286 fix(web,server): the branch label no longer flips back after a switch (#28575)
- 77ad2ebec5 fix(server): end obsolete link cards after a matching retry succeeds (#26944)
- 5958d00ede perf(web): Update everything downloads a server's update while providers install (#35346)
- 953ce60d12 fix(web): changed root files with a leading space open in the diff panel (#36606)
- 9e19b7f7e1 feat(server): resume stopped provider threads natively (#36526)
- ca7a9448b8 fix(client-runtime): Reconnect works while the network reports offline (#24932)
- 33372a25a2 fix(pi): info notifications no longer render as warnings (#23506)
- cf60628ef9 fix(client-runtime): cache running threads when their view closes (#25213)
- 9803d1adb5 fix(web): paint the selected environment theme from the first frame on launch (#36042)
- bd9ff7eb2a fix(client-runtime): recover thread list updates after stream defects (#33244)
- fcf50ffe38 fix(connect): T3 Connect recovers when its tunnel is routed to a dead local port (#24247)
- 757f71a7f6 fix(client-runtime): new T3 Connect machines appear without signing in again (#29788)
- 913181c439 fix(server): stop the relay client a crashed server left running (#36465)
- a2edd281df feat(connect): require approval for new T3 Connect devices (#36419)
- 42057b82d0 feat: agents can restyle T3 Code with theme colors and CSS (#35247)
- 88d4d06ea3 perf(desktop): provider checks no longer compete with server startup (#35712)
- 2d80cb6bc7 fix(clients): live working timers count on the host's clock (#36420)

## K7b-2 READY

Published head `77764a6428b484da2b2d938116cbd11dde8f3580` on `chase/t3-261114-next3-k7b`. The single incoming integration merge uses `554c3c4092a8b29a2f853eb0a2e10d390d2ef424`. Its conflict resolution keeps both the integration server-update move and this lane's config-state move. The unpublished merge was amended for exact-optional types and typed snapshot fixtures flagged by the first gate. Node is 26.12.1. The coordinator owns the review and integration into PR #3700.

| Row | Commit | Port |
| --- | --- | --- |
| R4 | `0b80b0bc2fae3a6719c09ac4cf92af4e61535f5d` | Adapted `2917f28465`'s deferred on-demand catalog. Initial config and updates share a projection that reads current instance capability. Keeps GOAT's usage/provider projection order. Failed cwd scans carry the original machine catalog as pending. Fail-first on the baseline handler was 2 failures (command description retained and no pending snapshot). |
| R5 | `aa794d55096dd563664cbc2c576f8a232bd36154` | Adapted `8b2763f638`'s digests and machine catalog reply. GOAT keeps `providerStatusChanges`. The client applies those changes to the wire lists before restoring held lists. This also clears held lists when an instance loses cwd support. Cwd snapshots key their basis by digest so a changed catalog retires them. A late machine catalog reply applies under its own digest only. Fail-first had 3 failures (missing digest, lost stale marker and lists retained after losing cwd support). |
| R6 | `25d45da82c8a5d9bb5f88cf74cb5822defedf188` | Adapted `8b2763f638`'s refresh-reply portion. The mobile usage widget opts in per call. The client command distinguishes that request for single-flight matching. A machine refresh still runs its provider and usage work. One with instance and cwd still returns the workspace. Fail-first returned providers for an opted-in machine refresh. The green RPC authorization case runs through the actual scope middleware and records zero refreshes on denial. |

Supporting moves `ecd3844ee656add746930d7b43425a2b399da0af` (claims 10 and 11) and `ef5cb89a8b492cdb0f090903e6b71d590577337d` (config-state claim in records `befa016356`). Against the merged integration head, ws.ts is 3506 → 3485 lines, rpc.ts 2788 → 2773 and state/server.ts 1564 → 1429. R4–R6 used adaptations, with no full clean cherry-picks. The upstream delta event and its helpers are covered by GOAT's existing provider changes stream. No new upstream rows from the range above are included.

Rule 3: Existing expectations stayed in place. The mobile widget's `expect(fixture.refresh).toHaveBeenCalledTimes(1)` gained a separate call assertion immediately afterward: `expect(fixture.refresh).toHaveBeenCalledWith({ environmentId: "remote", input: { omitProviders: true } })`. The three other changed test files are new.

### Launch config on the seeded copy

`vp run migrate-dev-db --base-dir "$PWD/.goat/k7b-seed" --projects 5 --threads-per-project 10` exited 0. It used the live database only as a read-only migration source and produced a 347,222,016-byte isolated copy with five projects and 35,883 events. The in-process production `subscribeServerConfig` handler read settings and provider history against that seeded SQLite copy. The fixture supplied 13 copied machine provider cache entries, eight with cwd-capable drivers, and fixed the unrelated discovery and usage inputs. It opened no listener. Each row measures the first config snapshot encoded by `Schema.toCodecJson(ServerConfigStreamEvent)`, counted as UTF-8 JSON bytes. The same handler ran the legacy mobile request and both opt-in requests on the same inputs.

| Mobile request | First snapshot, bytes | Providers, bytes |
| --- | ---: | ---: |
| Before, legacy flags | 120,798 | 90,881 |
| R4, names and labels | 82,501 | 52,584 |
| R5, digests | 63,971 | 34,054 |

Total reduction 31.7% with R4 and 47.0% with R5. The seeded copy and the copied catalogs were removed after measurement.

### Verification and P1

- `GOAT_TEST_TMP_GUARD=fail vp run check:changed origin/chase/t3-261114-next3` exited 0 on the published head. Format, lint, two knip passes, server GraphQL, agent surface and context budget audits, typecheck of 38 packages, and tests passed. 71 server tests across 14 files plus 3,024 across 133 files, or 3,095 across 147 files. One existing low-value-comment warning in contracts server.ts.
- From apps/server, `GOAT_TEST_TMP_GUARD=fail vp test run src/ws.providerCatalog.test.ts` exited 0, 5 passed. From root, `vp test run apps/mobile/src/widgets/useSubscriptionUsage.test.tsx packages/client-runtime/src/state/serverConfigProjection.catalogs.test.ts packages/contracts/src/providerCatalogCompatibility.test.ts` exited 0, 7 passed.
- Older schemas strip the new flags. Older clients still get full payloads by default and older-server full lists are authoritative. Catalog cases cover same and changed digests, late replies, cwd capability loss, and the client-only digest marker never appearing in a refresh request. Scoped refreshes retain their replies and the negative read-scope case performs no refresh.
- P1 rows owed: R4/R5 mobile cold launch and reconnect, then open the composer and verify cwd-specific slash commands and skill links, including after the machine catalog changes. R6 mobile provider usage widget resume and refresh.
- NOT RUN: P1 live client, native mobile, older binary pairs, live GOAT Connect, slow-link timing, GitHub CI, full repository suites, release builds and smoke. Independent C4 review remains with the coordinator. K7b-1 is pending its cut after the coordinator integrates K7b-2, in the ruled order R2 `9557ab46c5`, R1 `dc3fdc6a3e`, R3 `2482b03a01`.

## K7b-2 fix round 1

The coordinator accepted the four findings against `77764a6428`. The fixes keep the opt-in payloads and authorization scopes. An older client still gets its existing full shape and can discover a current cwd catalog on the legacy refresh path. An older server's reply still applies through the legacy client basis and retries remain bounded. A declined refresh stays denied. Disconnected mobile transcripts keep reading the catalog already held for the thread.

One commit per finding. P2-1 compares an initial config, a live provider update and a cwd reply under projected quotas. P2-2 covers a provider update followed by a cwd reply under the existing TTL and a scan that races a catalog change. P2-3 holds the first reply until a newer digest is current and checks recovery through the mounted refresh atom. P3 exercises a cold connected transcript with an empty machine catalog. Run each case red and green, run all changed test files whole with the server guard, and run check:changed against integration. Native P1 remains with the coordinator.

### K7b-2 fix round 1 READY

Head `2dc724e37d79bd9700a863c6727848b243280d17`. Four commits on the reviewed `77764a6428` head. `git merge-tree --write-tree --name-only origin/chase/t3-261114-next3 HEAD` found no conflicts with integration `cf1e3679e3`.

| Finding | Commit | Change and fail-first proof |
| --- | --- | --- |
| P2-1 | `7ed50286c8851b63a1f961d4456b5372526cc748` | Initial config, live provider updates and cwd replies use the shared quota → /usage-limits → catalog pipeline. The RPC regression failed because the live update's digest differed while initial config and the cwd reply agreed. Owners: apps/server/src/providerConfigCatalogs.ts:35 and ws.ts:1547. |
| P2-2 | `7b4adf06a4ae11314b3e4ba5e3067ab7e790db0e` | Registry drops cwd snapshots when their effective machine commands or skills change. In-flight scans check that basis before publishing, even on the first scan with no prior cwd row. Two cases failed first: the next cwd RPC served `old` under the changed machine catalog, and an in-flight first scan published after the catalog changed. The existing global skill watch updates machine and folder entries together. Owners: apps/server/src/provider/ProviderSnapshotMerge.ts:32 and ProviderRegistry.ts:322, :867. |
| P2-3 | `540c5172e9874698b66083488771637cdee292f0` | Completion for digested providers reads the accepted snapshot from current config. A discarded reply with an absent snapshot schedules the existing ten-second cooldown, bounded to three attempts. Both deferred-response cases failed at the first retry on the old code. Owner: packages/client-runtime/src/providerSkills.ts:347, :488. |
| P3 | `2dc724e37d79bd9700a863c6727848b243280d17` | The connected, visible provider-subagent transcript mounts the existing cwd refresh while it has no composer. The mobile React case failed because the project skill link stayed missing after releasing the scan reply. Owner: apps/mobile/src/features/threads/use-thread-transcript-skills.ts:23 and ThreadDetailScreen.tsx:1002. |

Compatibility retains the opt-in keys, old-server full catalogs, and existing refresh authorization. Existing test expectations were preserved. The mobile Vite registration selects the existing React test project for the new transcript case.

- `GOAT_TEST_TMP_GUARD=fail vp run check:changed origin/chase/t3-261114-next3` exited 0 on this head, with 38 packages typechecked. Server 1,075 tests across 110 files, workspace 3,069 across 135 files. Total 4,144 across 245 files.
- From apps/server, `GOAT_TEST_TMP_GUARD=fail vp test run src/ws.providerCatalog.test.ts src/provider/ProviderWorkspaceSnapshots.test.ts src/provider/ProviderRegistry.test.ts src/skills/GlobalSkillsRegistry.test.ts` exited 0, 68 tests across four files.
- From root, `vp test run packages/client-runtime/src/providerSkills.test.ts packages/client-runtime/src/state/serverConfigProjection.catalogs.test.ts packages/contracts/src/providerCatalogCompatibility.test.ts apps/mobile/src/widgets/useSubscriptionUsage.test.tsx apps/mobile/src/features/threads/use-thread-transcript-skills.test.tsx` exited 0, 51 tests across five files.
- P1 rows owed include the cold connected subagent transcript's workspace skill link, in addition to mobile launch/reconnect, composer catalogs and widget refresh.
- NOT RUN: native P1 or other live-client passes, older binary pairs, live GOAT Connect, slow-link or seeded payload remeasurement, GitHub CI, and full builds/suites. K7b-1 begins after the coordinator merges K7b-2, in order `9557ab46c5`, `dc3fdc6a3e`, `2482b03a01`.

## K7b-2 fix round 2

The coordinator accepted P2-a and P2-b against `2dc724e37d`. P2-a exercises an exhausted refresh with unchanged snapshot status and then a changed digest. The mounted refresh watches the digest and restores the bounded budget. An active request still settles through the existing completion and cooldown path. P2-b exercises an installation update whose machine commands, skills and digest are unchanged but whose cwd scan has changed. The server cache and in-flight publication check and the client workspace cache use installed state, reported version and optional installed CLI version. Legacy clients and servers use the same wire shape and auth rules. Separate fail-first commits, guarded server tests, changed-files gate and plain push. Native P1 remains with the coordinator.
