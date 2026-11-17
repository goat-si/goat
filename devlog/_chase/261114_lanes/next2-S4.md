# S4 auth (lane record)

Lane branch: `chase/t3-261114-next2-s4-auth`, head `4c0eb424639bf6af93614a821b048bb8f2d5c11f` (the fix round `df3aec02db`, then a merge of the integration head `bd3901fca9`) (first READY `13309271ae7760a4d01e3c27dff5c09b11bccfa4`, blocked by its C4 review), cut from the integration branch `chase/t3-261114-next2` at `ed4268897e3183341694f27e488232572d5c5151` (draft PR #3660). Host pen-macbookpro2. Both rows are C4. Plain push, no force.

## Rows and commits

| row | GOAT commit | result |
| --- | --- | --- |
| goat#3657 (dev's #3612) | `ec3c14cab263994bae13ea8382d9d576e78b75be` | the call's child reads the removal mark when it starts (apps/server/src/auth/SessionEndLatches.ts:58-60) |
| goat#3522 | `13309271ae7760a4d01e3c27dff5c09b11bccfa4`, then `df3aec02dbdeb8d6da81aabee7663d52d3a49907` (with move-outs `8fd3f84eb7`, `096b025a81`, `adb9c8c088`) | option B: the github.com token goes with a repository file or LFS object only of the repository the server's project list allows; anything else is fetched without it. 13309271ae says "Fixes #3522" but does not fix it alone (it compared with a client-chosen name); the closing reference that counts is in df3aec02db |

## Coordinator answers (verbatim)

> Coordinator to lane coordinator, 2026-11-17 08:54:24 UTC, for S4 (quote verbatim in S4's record).
> goat#3657, the deviation: ACCEPTED. The failing-first test belongs where the first step's effect can be seen, so a new case beside SessionStore.sessionEnd.test.ts:122 with a synchronous write is right, and the McpSessionCut case stays as it is. Conditions for the record and the review: (1) the case is deterministic: the sweep over MaxOpsBeforeYield 2..64 runs inside one test with no sleep, retry or timeout, and each budget asserts "the call did not run and the result is none"; say why 19 of 63 budgets failed before the fix and the rest did not (where the turn boundary falls), so nobody reads the sweep as a flake hunt; (2) the fix keeps the caller's result the same in every other ordering: name the existing cases that cover a cut mid-run, a cut after finish, the caller's interrupt and a call that revokes its own session, all still passing; (3) the record carries the fail-first output (which budgets, the message) and the 39-budget scratch observation for McpSessionCut as the reason no test was added there. No push needed for this answer; carry on with goat#3522 and bring me the public-image question when you reach it.

> Coordinator to lane coordinator, 2026-11-17 08:55:37 UTC, for S4 (quote verbatim in next2-pr-plan.md under "Coordinator answers" and in S4's record).
> goat#3522, QUESTION 1: OPTION B. A repository file or LFS file whose owner/name is not the request's repository (or the cwd checkout's repository when the client sends none), and any such file when no repository is known at all, is fetched WITHOUT the GitHub credential. The credential goes only with a file of the request's own repository. Conditions, each with a test or a path:line in the record:
> (a) Nothing cached or stored may bridge the two: say how a fetched media response is cached or stored (the asset URL from assets.createUrl, any response cache) and show that content fetched WITH the credential can never be served to a request that would have been fetched without it (the same URL asked for under another repository, or with no repository). If the cache key is the URL alone, that is the bug to fix here; a test: fetch a same-repository private file, then ask for the same URL with another repository and get what an uncredentialed fetch gives, not the cached bytes.
> (b) Redirects: an uncredentialed or a credentialed fetch must not follow a redirect to another host with the Authorization header; name the redirect mode at path:line.
> (c) The comparison: owner and name compared case-insensitively as GitHub does, on the parsed pathname as you describe; a negative test each for another repository, another owner with the same name, dot segments, an encoded separator, a missing repository with no cwd checkout (uncredentialed), and the older client relying on the cwd fallback (credentialed for that repository only).
> (d) What a person sees is unchanged except one case: an image from another PRIVATE repository in a pull request body or comment no longer loads. One line in docs/user/source-control.md only if that page says such images load; a Known limits line in #3660's body either way.
> (e) Uploads (user-attachments, legacy /assets/) keep their rules, as you say; say in the record which credential rule they follow so the reviewer need not rediscover it.
> QUESTION 2, rule 3: AUTHORISED. "Coordinator authorisation, 2026-11-17, rule 3, packages/source-control-github/src/server/gitHubMediaFetch.test.ts:84-87 ('loads private media immediately after login with the GitHub credential'): the request literal { url: "https://raw.githubusercontent.com/owner/repo/main/shot.png", headers: {}, } may become { url: "https://raw.githubusercontent.com/owner/repo/main/shot.png", headers: {}, repository: "owner/repo", }. Reason: under goat#3522 the credential goes only with a file of the request's own repository; the case is a same-repository file, so naming the repository keeps its meaning. Input only; every expect unchanged." The record lists the line before and after.
> This row is C4 (a credential boundary): fail-first for the cross-repository case (today the Authorization header goes out; the test asserts it does not), and the review reads it as C4.

Correction (09:26:34 ruling, point 4): option B stands for what is fetched without the token, but the repository the URL is compared with is the server's, not the request's. The repository named in the request (or the cwd checkout's, for an older client) is only a name to test against the server's project list at fetch time; see the fix round below.

## goat#3657

Fix: `Effect.forkChild(Effect.suspend(() => (admission.removed ? Effect.interrupt : effect)))` (SessionEndLatches.ts:58-60). When the mark is already set as the child starts, it interrupts itself before the call's first step. The parent's own read (:64) and the interrupt-on-removed mapping (:73) are unchanged, so every other ordering returns what it returned before.

Deviation (accepted above). McpSessionCut.test.ts:500, "a call whose session was revoked before it started…", cannot fail at a small budget. A scratch sweep on ed42688, with the call counted when its child started after the mark was set, saw the child start after the removal at 39 budgets between 2 and 4000: 2-8, 10, 11, 14, 15, 17-19, 21, 22, 30, 36, 40, 63-68, 83, 87, 145, 186, 198, 214, 376, 388, 413, 461, 824, 1183, 1753, 1809. Even so, `project.create`'s mock never recorded a write: the tool's path from the child's start to `ProjectService.create` is longer than the child's first turn. No test was added there, and the McpSessionCut case is unchanged.

Test (apps/server/src/auth/SessionStore.sessionEnd.test.ts:140, beside the existing :123): "a call that starts after its session was removed never runs, wherever the caller's scheduler turn ends". The session is revoked first. One test runs `end.run(Effect.sync(() => { ran = true }))` under `Scheduler.MaxOpsBeforeYield` 2..64, through `Effect.forEach` with no sleep, retry or timeout, and asserts the whole list equals `{ budget, ran: false, outcome: Option.none() }` for each budget. A failure therefore names every failing budget.

Fail-first, on ed42688's SessionEndLatches.ts with the final test: `AssertionError: expected [ …(63) ] to deeply equal [ …(63) ]`, with `"ran": true` at budgets 2 3 4 5 6 7 8 9 10 11 13 17 19 22 30 31 35 44 56 63 (20 of 63). Two runs gave the identical list. A first draft of the same case (a for loop instead of `Effect.forEach`) failed at 19 budgets: 2-10, 12-15, 17, 19, 31, 35, 56 and 61.

Why those budgets. The run loop counts the parent fiber's operations and yields when the count reaches the budget (effect 4.1.3 Scheduler.ts:198-199; internal/effect.ts:690-704). `forkChild` queues the child's start. If the parent's turn ends in the few operations between the fork and the interrupt that follows the mark's read, the scheduler starts the queued child first, and its first synchronous step runs. If the turn ends anywhere else, the interrupt reaches the child before it starts. Below about 12 the turn is no longer than that window, so every budget fails. Above that, a budget fails only when its turn boundary lands inside the window, which depends on how many operations the fiber has run since it last yielded. That count is fixed by the program: no clock or I/O enters it. So the same budgets fail on every run, and a change to the code before the fork (such as the draft's loop) shifts which ones. After the fix the child reads the mark itself, so the boundary no longer matters.

Other orderings, all passing after the fix, with fresh runs below:

- Cut during a run: SessionStore.sessionEnd.test.ts:68 "%s interrupts a call running on the session and no other" (4 paths); :96 the durable-check cut; :211 "a revoke still cuts a call whose session is already past its expiry"; McpSessionCut.test.ts:201 "a project create admitted before a %s never lands and returns the cut"; :479 "an eval cut during one step never runs its next step".
- Cut after the call finished, and a call that revokes its own session: no existing case covered either, so the row adds SessionStore.sessionEnd.test.ts:169, "a revoke after a call finished keeps its result; a call that revokes its own session stops there". A revoke after `run` returned keeps `Option.some("done")`, and a call whose first step revokes its own session returns none without reaching its next step. It passed on ed42688's code and passes after the fix.
- The caller's interrupt: SessionStore.sessionEnd.test.ts:224 "a call returns its own result or failure, and its caller can still stop it"; McpSessionCut.test.ts:568 "a client that stops waiting still stops a guarded call, which never lands"; :589 notifications/cancelled and a client abort over /mcp.
- Expiry never cuts: SessionStore.sessionEnd.test.ts:196; McpSessionCut.test.ts:520.

C4, both ways: server-internal with no wire or schema change. An older client sees the same cut result; an older server keeps the narrow race.

## goat#3522

This section describes the first commit, 13309271ae. Its comparison and tests stand. The repository it compares with is no longer the request's value as written, which the C4 review blocked (P1-1). The fix round below replaces it with the server's decision.

Rule (packages/source-control-github/src/server/gitHubMediaFetch.ts:32-63, used at :111 on every hop). The token is sent only to a host in `GITHUB_CREDENTIALED_MEDIA_HOSTS`, and then only with:

- a github.com upload path (the upload rule below);
- a repository file or LFS object whose `owner/name` is the request's repository. The addressed repository is read from the parsed pathname: `raw.githubusercontent.com/<o>/<r>/…`, `media.githubusercontent.com/media/<o>/<r>/…`, or `github.com/<o>/<r>/raw|blob/…`. Each segment must match `[\w.-]+`, the request's repository must match `REPOSITORY_PATTERN`, and the comparison is case-insensitive.

WHATWG parsing has already resolved `..` and `%2e%2e`, so the check reads what GitHub will be asked for. A segment such as `repo%2F..` fails the segment pattern. Any other file, or a request with no repository, is fetched without the token.

Fail-first (gitHubMediaFetch.test.ts:284 and :322 on ed42688's fetcher): all eight negative cases went out with `Bearer signed-in` and got 200 where the test expects no credential and 404, and the redirect case expected 404 and got 200 (the token followed owner/repo to other/secret). After the fix both pass.

(a) Caching. Nothing bridges a credentialed response to an uncredentialed request:

- assets.createUrl seals the claims `{cwd, url, repository?}` with a synthetic IV (apps/server/src/assets/AssetAccess.ts:862-873; assetClaimsSeal.ts:26). Another repository gives another asset URL.
- The response is `cache-control: private, max-age=<remaining>` (sourceControlMediaResponse.ts:39), so a browser caches by that URL.
- Client caches key on the resource, repository included: web, the createUrl input (apps/web/src/assets/assetUrls.ts:41); mobile, `goat-media:[environmentId, cwd, repository, fetchUrl]` (apps/mobile/src/lib/assetImageSource.ts:26).
- The server's only cache is the signed-upload map keyed by fingerprint, repository and URL (gitHubMediaFetch.ts:174, :211), and raw files are not cached at all.
- Test: gitHubMediaFetch.test.ts:284 uses one fetcher across all its cases. The same private file gets 200 with the token for owner/repo, then 404 with no token under `someone/else` and with no repository.
- Residual: an older client sends no repository, so the server resolves the cwd checkout's repository at fetch time. If that checkout's remote changes within an asset URL's lifetime, the same browser could reuse its own cached copy of bytes it was already shown.

(b) Redirects use `redirect: "manual"` (gitHubMediaFetch.ts:18, applied at :126). Each hop decides the header again with `carriesCredential(target, repository)` (:111), so a hop to another host, or to another repository's file, carries none. Tests: :322 (own repository → other/secret, and own repository → objects.example.com, both without the header) and :170 (upload → object store, existing).

(c) Comparison tests, all in gitHubMediaFetch.test.ts:284:

- credentialed: own repository, own repository in other letter case, own repository's LFS file;
- uncredentialed: another repository, another owner's repository of the same name, another repository's LFS file, dot segments, encoded dot segments, an encoded separator, and no repository.

Missing repository with no cwd checkout: apps/server/src/assets/sourceControlMediaResponse.test.ts:55 (new) shows the fetcher then gets no repository, and :284's "the same file with no repository" shows that fetch carries no token. Older client relying on the cwd fallback: AssetAccess.test.ts:1581 (existing) shows a resource with no repository is fetched as the checkout's `owner/repo`, and an explicit repository wins. :284 shows the token then goes with owner/repo's files only.

(d) What a person sees: unchanged, except that an image or video from another PRIVATE repository in a pull request body or comment no longer loads (web PullRequestMarkdown and the Code tab; mobile pull-request media). docs/user/source-control.md does not say such images load, so it is unchanged. Proposed Known limits line for #3660's body, for the PR owner: "Images and videos in a pull request body or comment that come from another private repository no longer load; GitHub media is fetched with your GitHub sign-in only for the pull request's own repository (goat#3522)."

(e) Uploads keep their rules (gitHubMediaFetch.ts:58, and `uploadRepository` at :70):

- `github.com/user-attachments/assets/<id>` and legacy `github.com/<o>/<r>/assets/<n>/<id>` get the token on github.com whatever the request's repository; the asset id is the capability.
- For SAML SSO the signed URL is rendered in the legacy path's repository, or else in `request.repository`. The signed URL itself is fetched without the token.

Rule 3 (authorised above): gitHubMediaFetch.test.ts:119, "loads private media immediately after login with the GitHub credential".

- before: `{ url: "https://raw.githubusercontent.com/owner/repo/main/shot.png", headers: {}, }`
- after: `{ url: "https://raw.githubusercontent.com/owner/repo/main/shot.png", headers: {}, repository: "owner/repo", }` (the new key at :127)

Input only; every expect is unchanged.

C4, both ways: no wire or schema change. An older client that sends no repository still gets the cwd checkout's repository from the server, as before, and its own repository's media still loads. A newer client on an older server behaves as before the fix: the token still goes everywhere, but nothing breaks.

## Checks (fresh, on the head unless noted)

- `vp test run apps/server/src/auth/SessionStore.sessionEnd.test.ts apps/server/src/mcp/McpSessionCut.test.ts apps/server/src/hub/HubMembership.move.test.ts apps/server/src/hub/OpenCodexSync.test.ts` on ec3c14cab2's code: 4 files, 84 tests passed.
- `vp test run packages/source-control-github/src/server/gitHubMediaFetch.test.ts packages/source-control-github/src/shared`: 3 files, 27 passed. With apps/server/src/assets/sourceControlMediaResponse.test.ts: 2 files, 9 passed. AssetAccess.test.ts "credentialed media": 1 passed.
- `vp run check:changed origin/chase/t3-261114-next2` at 13309271ae, 5 files: exit 0 (format, lint, knip 1/2 and 2/2, graphql, agent surface audit, context budget, typecheck of 10 packages, tests beside the changes: 3 files, 22 passed).
- Budgets: no touched file has an entry in oxlint-plugin-goat/code-budgets.json; the largest is gitHubMediaFetch.test.ts at 343 lines.

NOT RUN: full CI suites and build (ci:full; CI owns them). The real-client pass: no client code changed, and the one visible change needs a private cross-repository embed against live GitHub. A live fetch against real GitHub private repositories; tests use a mocked HttpClient. The independent C4 review, which the coordinator runs per READY. The quote in next2-pr-plan.md under "Coordinator answers" is left to that file's owner, because this lane touches only its own record.

## READY and review

READY sent at lane head `13309271ae7760a4d01e3c27dff5c09b11bccfa4`, records `318cfa5fec`.

> Coordinator to lane coordinator, 2026-11-17 09:12:32 UTC (verbatim).
> 1. S4 READY at 13309271ae: checked on origin (two commits on ed4268897e, 5 files +242/-17). The fresh C4 review is running (Opus 5.5 xhigh, read-only, task goat-next2-S4-final-13309271): the start window in every ordering and the sweep test's determinism; for goat#3522 the cache and stored-asset bridge, redirects per hop, the comparison against attack inputs, the hosts the fetcher can reach, the tests and the one authorised input change, clients and compatibility. S4 stands by; no push to its branch until I send the verdict. The Known limits line it proposes is accepted for #3660's body as written.

## Fix round after the BLOCK at 13309271ae

### Rulings (verbatim)

> Coordinator to lane coordinator, 2026-11-17 09:26:34 UTC (append each part to the lane's rulings and quote verbatim in its record and in next2-pr-plan.md under "Coordinator answers").
>
> A. S4: THE FRESH C4 REVIEW at 13309271ae7760a4d01e3c27dff5c09b11bccfa4 IS A BLOCK (Opus 5.5 xhigh, read-only). Report /Users/jun/handoff-in/chase/next2-S4-review-13309271.md (its probes in /Users/jun/handoff-in/chase/next2-S4-review-probes/); relay the report in full to S4, its host cannot read this Mac.
> - ec3c14cab2 (goat#3657) is CORRECT: the window is closed in every ordering; the sweep test is deterministic and the reviewer's own replica of the base failed at exactly S4's 20 budgets (2-11 fail at every offset because the fork-to-read stretch is about 10 operations). Nothing to change there.
> - 13309271ae (goat#3522): the comparison holds against every encoding attack, redirects and caches are sound. BUT S4-P1-1: MY OPTION B TRUSTS A VALUE THE ATTACKER CHOOSES. The repository the URL is compared with comes from the client: packages/contracts/src/assets.ts:60-63 (any trimmed string), apps/server/src/ws.ts:2967-2974 (a github-media resource goes straight to issueAssetUrl with no check), AssetAccess.ts:862-873 (the client's repository and cwd are copied into the signed claims), sourceControlMediaResponse.ts:56. A paired client with only orchestration:read (RpcAuthorization.ts:252, :418-426) calls assets.createUrl with { _tag: "github-media", cwd: "/x", url: "https://raw.githubusercontent.com/victim/private/main/a.png", repository: "victim/private" } and gets any image, video or audio file at any ref in any private repository the owner's token can read, plus an existence check for any path. That is goat#3522's own attack and it still works; my decision was wrong on that point and the reviewer is right.
> FIX ROUND for S4, one or two commits on top of 13309271ae, test first:
> (1) The server decides the repository when the URL is MINTED (ws.ts, the github-media branch), never the client alone: cwd must be an active project root (as the favicon branch requires at ws.ts:2985; today the fallback accepts any checkout on disk); the client's repository is kept in the claims only if it belongs to that project, matching its origin or upstream the way PullRequestService.requireProject does (PullRequestService.ts:727-750; :3676 states the rule: "PR read access does not grant arbitrary repository reads with the project credential"); otherwise the URL is minted WITHOUT a repository, so the file is fetched without the token (option B's outcome for a foreign file, now decided by the server). Reuse requireProject's own matching; do not write a second one. The cwd fallback for older clients gets the same requirement: an active project root, and the repository is that project's.
> (2) Failing tests first, at the boundary the reviewer says the current tests never touch: through the real mint path (the ws handler or AssetAccess with the real claims), a repository that does not belong to the project at cwd gets NO Authorization header; a cwd that is not a project root gets none; a project's own origin and its upstream each get the token; the attack row above gets none. Keep the eight fetch-level negative cases.
> (3) BEFORE CODING, list every caller that sets sourceControlMedia or mints a github-media URL (web PullRequestMarkdown.tsx:41-47 and :127, the Code tab PullRequestImageAnnotation.tsx:49, mobile PullRequestMarkdown.tsx:69-75 and pullRequestMediaSource.ts:17-21, anything else) with where its cwd and repository come from, and say for each whether a legitimate same-repository image would lose the token under (1): a pull request opened from the Pulls list for a repository that is not the project at cwd, a pull request of an upstream when the project is a fork, a thread in a worktree (is the worktree path "an active project root" or does it resolve to one), a remote environment. If any honest case breaks, bring it to me with the smallest rule that keeps it (for example: cwd resolves to its project through the worktree) before you build.
> (4) The record corrects my 08:55:37 answer in place: option B stands for what is fetched without the token, and the repository it is compared with is the server's. goat#3522 stays OPEN until this round is reviewed; the commit message of 13309271ae says "Fixes"? If it does, the fix commit's message carries the closing reference and the record says the first commit alone does not fix it.
> (5) S4-P3-1 (the cwd residual: a 15 minute identity cache, the browser's one hour cache, mobile's immutable media key; only the same device can see bytes it was already shown): one paragraph in the record, no code.
> Then check:changed and READY; a NEW reviewer reads the fix round with this report in its brief. The Known limits line for #3660 stays as accepted.
>
> === THE REVIEW REPORT IN FULL (next2-S4-review-13309271.md) ===
> **BLOCK** 13309271ae7760a4d01e3c27dff5c09b11bccfa4
>
> I confirmed the head with `git ls-remote` at the start and at the end: `origin/chase/t3-261114-next2-s4-auth` = `13309271ae7760a4d01e3c27dff5c09b11bccfa4`, on base `ed4268897e3183341694f27e488232572d5c5151`.
>
> The #3657 commit (`ec3c14cab2`) is correct, and its test is deterministic and sound. The #3522 commit (`13309271ae`) builds the coordinator's Option B exactly, and its comparison holds against every encoding attack I tried. But Option B trusts a value the attacker controls, so the attack in #3522 still works. Merging with "Fixes #3522" would close an open credential issue that is still exploitable.
>
> ## Findings
>
> **P1-1. The token decision trusts the `repository` field, and the attacker chooses that field**
>
> - **Where:**
>   - `packages/contracts/src/assets.ts:60-63`: `repository` is any trimmed string up to 512 characters.
>   - `apps/server/src/ws.ts:2967-2974`: a `github-media` resource goes straight to `issueAssetUrl` with no check.
>   - `apps/server/src/assets/AssetAccess.ts:862-873`: the client's `repository` and `cwd` are copied into the signed claims.
>   - `apps/server/src/assets/sourceControlMediaResponse.ts:56`: `asset.repository` is used as it is.
>   - `packages/source-control-github/src/server/gitHubMediaFetch.ts:60-62`: the URL is compared against that value.
>   - `apps/server/src/auth/RpcAuthorization.ts:252,418-426`: minting needs only `orchestration:read`.
> - **Trigger:** a paired client with only `orchestration:read` calls `assets.createUrl` with `{_tag:"github-media", cwd:"/x", url:"https://raw.githubusercontent.com/victim/private/main/a.png", repository:"victim/private"}`, then fetches the returned URL. A `github.com/victim/private/blob/...` URL or a `media.githubusercontent.com/media/victim/private/...` URL works the same way. `cwd` is not read at all once `repository` is set.
> - **Consequence:** the server sends the owner's GitHub token. The attacker gets any image, video or audio file, at any ref, in any private repository the token can read. They also get an existence check for any path: 200, 404 or 415. This is #3522's own trigger, and #3522 names "a read-only paired device" or a "modified" client as the attacker. The change only stops honest clients from showing another private repository's image to the same person, and it costs the visible change in (f). Every new fetch test hands the fetcher the repository the test wants, so the tests check the comparison and never the boundary.
> - **Precedent:** the repository already draws this line elsewhere. `PullRequestService.ts:727-750` (`requireProject`) refuses a repository that "does not belong to the selected project". `:3676` says "PR read access does not grant arbitrary repository reads with the project credential". The media path has no such check.
> - **Smallest fix:** decide the repository on the server when the URL is minted (`ws.ts` `github-media` branch):
>   - Require `cwd` to be an active project root, as the favicon branch does at `ws.ts:2985`. Today the fallback also accepts any checkout on disk.
>   - Keep the client's `repository` only if it belongs to that project, matching origin or upstream as `requireProject` does. Otherwise mint without it, so the file is fetched without the token.
>   - Add a test: a repository that does not belong to the project at `cwd` gets no `Authorization` header.
>   - If the coordinator would rather land this commit as it is, remove "Fixes #3522" from the commit and from #3660, and keep the issue open.
> - **Basis:**
>   - Read: the code path above.
>   - Run: the head's own `gitHubMediaUrl` and `carriesCredential`, loaded unchanged in a scratch probe. The attack rows return `token=true`.
>   - Not run: an end-to-end server request.
>
> **P3-1. The cwd residual in the record, stated plainly**
>
> - **Where:** `sourceControlMediaResponse.ts:55-63`, `RepositoryIdentityResolver.ts:22` (15-minute identity cache), `sourceControlMediaResponse.ts:39-40`, and `apps/mobile/src/lib/assetImageSource.ts:23-27`.
> - **Trigger:** an older client sends no `repository`. The checkout at `cwd` changes its GitHub remote.
> - **Consequence:**
>   - Each fetch credentials media for whatever identity was cached at that moment, which can be up to 15 minutes stale.
>   - The browser can reuse its private cached copy for up to 1 hour.
>   - Mobile keeps immutable media (commit-SHA files and uploads) under a key without the resolved identity, beyond the URL's life.
>   - Only the same device can see bytes it was already shown, so nothing reaches another person or session.
> - **Rating:** negligible; no fix needed for this row.
> - **Basis:** read.
>
> ## What checks out
>
> **(1) The #3657 window is closed in every ordering.**
>
> - **Session removed before the fork:** the child reads the mark when it starts and interrupts itself (`SessionEndLatches.ts:58-60`). If the parent reads first, `interruptUnsafe` ends a child that has not started straight away (effect 4.1.3 `internal/effect.ts:594-616`), and its queued start does nothing.
> - **Removed between the fork and the child's start:** the same check catches it, including when `cut` runs before `calls.add` at `:62`.
> - **Removed after the child starts:** the child is already in `calls`, so `cut` interrupts it (`:33-40`). If the parent's turn ended before `calls.add`, the parent's own read at `:64` catches it.
> - **Caller interrupt, self-revoke, nested call:** all unchanged. A nested call runs inside the parent's child because `InsideGuardedCall` skips the second `run` (`McpSessionCut.ts:51-55`).
> - **Session not removed:** the new branch never fires. `removed` is set only by `cut` or `markRemoved`, and never cleared. The child is one operation longer, which shifts scheduling but not results.
> - **Basis:** read and run. Scratch replicas of base and head `run()` covered every ordering. Success and typed failure returned unchanged at budgets 2–40.
>
> **(2) The mark is read at the right moment, and the read is atomic with `cut`.**
>
> - `cut` sets the mark and interrupts in one synchronous loop. Every read of the mark is a plain synchronous read, so a read sees the state either before or after the whole cut.
> - `cut` runs one step after the Ref update inside an uninterruptible chain (`SessionStore.ts:355-386`). A call that starts in that gap counts as one that started before the revoke; that ordering is not the #3657 window.
> - The verify fence (`SessionStore.ts:903-921`) records the admission before it reads `cutFences`, so a removal during verify is never missed.
>
> **(3) The sweep test is deterministic, and it would catch the bug again.**
>
> - It has no sleep, retry, timeout or wall clock. It uses `Effect.forEach` with no waits, so the polling-loop lint rule does not apply.
> - Turns end by operation count (`Scheduler.ts` `shouldYield`). The task queue runs first in, first out, and the count resets at each slice.
> - My replica of base failed at exactly the author's 20 budgets: 2–11, 13, 17, 19, 22, 30, 31, 35, 44, 56 and 63.
>   - The list was the same at each of 40 preamble offsets and across repeated runs.
>   - Head never ran the call.
> - Budgets 2–11 fail at every offset because the fork-to-read stretch is about 10 operations. Any budget no longer than that lands a turn boundary inside it, so removing the fix would fail again reliably.
> - `provideService(MaxOpsBeforeYield)` reaches both the parent and the child, because the cache refreshes when the context changes and the child inherits the parent's context.
>
> **(4) The Effect 4.1 traps do not apply.**
>
> - `forkChild` is not a fork into a scope.
> - The mixed-cause mapping at `:73` is unchanged, and the self-interrupt produces a pure interrupt (`internal/effect.ts:4658`).
> - No value is captured before a yield and compared after: `removed` is read live each time.
>
> **(a) Nothing cached bridges a credentialed response to an uncredentialed request.**
>
> - The claims (`url`, `cwd`, `repository`, `expiresAt`) are sealed and signed (`assetClaimsSeal.ts`, `AssetAccess.ts:903-904`), so another repository gets another URL.
> - The asset route trusts only that signature (`http.ts:546-577`). Handing the URL to another client gives the same decision, apart from P3-1.
> - Raw files are never cached on the server. The only server cache is for signed upload links, keyed by account fingerprint, repository and URL (`gitHubMediaFetch.ts:174-177`).
> - Clients key their caches on the resource, repository included.
>
> **(b) Redirects.**
>
> - `redirect: "manual"` (`:18`, applied at `:126`), and the token rule runs again on every hop (`:111`).
> - A hop to another repository or another host carries no header; the tests at `:322` and my probe show this.
> - The hop limit is 3, so at most 4 requests, and a fourth redirect returns 502.
> - Only `https` hops are followed, and userinfo is refused (`:134`).
>
> **(c) The comparison.**
>
> - My probe gave no token for:
>   - another owner with the same repository name
>   - a name that is a prefix or suffix of the real one
>   - `..`, `%2e%2e`, `.%2e` and backslash dot segments
>   - `%2F` in a segment
>   - a trailing dot or `.git` in the name
>   - `media.githubusercontent.com` without `/media/`
>   - another repository on github.com
> - Userinfo and ports: the mint rebuilds the URL from host and path; as a redirect hop they are refused.
> - An uppercase host is lowercased.
> - A `<ref>` or `<path>` that names another owner/repo still addresses the URL's own owner/repo.
> - Uploads keep their old rule:
>   - `github.com/user-attachments/assets/<id>` and legacy `/<o>/<r>/assets/<n>/<id>` get the token on github.com and www.github.com whatever the repository; the asset id is the capability (`:54`).
>   - Single sign-on rendering uses the legacy path's repository, otherwise `request.repository` (`:70-88`).
>
> **(d) Hosts and bounds.**
>
> - The first hop is always one of the four GitHub hosts on port 443 (`gitHubMedia.ts:49-65`).
> - Later hops can reach any `https` host and port, including private addresses, without the token.
> - There is no size or time limit; the body is streamed through (`sourceControlMediaResponse.ts:94`).
> - Both behaviours predate this change and are unchanged by it.
>
> **(e) Tests.**
>
> - The three test files have no removed lines. The only edit to an existing test is the authorised `repository: "owner/repo"` at `gitHubMediaFetch.test.ts:127`, and every `expect` is unchanged.
> - No sleeps, timeouts or retries were added. The one non-null assertion is in a test (`sourceControlMediaResponse.test.ts:59`).
> - There are 8 negative cases, as claimed. Reading the base fetcher, they would fail there: it sent the token to every raw URL.
> - `sourceControlMediaResponse.test.ts:55` passes on base too. It pins existing behaviour, and the record does not claim it fails first.
>
> **(f) Clients and compatibility.**
>
> - These send `repository` when they know it:
>   - web PR markdown (`PullRequestMarkdown.tsx:41-47`, `:127`)
>   - the web Code tab (`PullRequestImageAnnotation.tsx:49`)
>   - mobile PR media (`PullRequestMarkdown.tsx:69-75`, `pullRequestMediaSource.ts:17-21`)
> - Chat turns on `sourceControlMedia` only through PR markdown.
> - An older client falls back to the checkout's repository. A newer client on an older server behaves as before.
> - What a person sees: an image from another private repository returns 404 and shows the failed-image state with Retry (`ChatMarkdownMedia.tsx:273,293`; inferred).
> - `docs/user/source-control.md` never says such images load, so no doc change is needed. The Known limits line is fine.
>
> **(g) Budgets and rules.**
>
> - `code-budgets.json` is unchanged, and none of the touched files has an entry. The largest is 343 lines.
> - No new casts to `any` and no event emitters.
> - Comments stay within 1–3 lines and explain constraints.
>
> ## Merge state
>
> - **Into `origin/chase/t3-261114-next2`:** clean; the base is an ancestor of the head.
> - **Into `origin/dev`:** clean against both `3ecea04f19` and the new tip `9835304ca7` (it moved during the review). The new dev commits touch none of these files.
> - **Other #3660 lanes:**
>   - `-x1-ci` (`6ff107eda7`) touches none of these files.
>   - `-n4-worktree` (now `b5075c7a70`) changes `code-budgets.json`, which S4 does not touch.
>   - `-cf1-clients` (`fdfda95783`) appeared during the review and touches none of these files.
>   - Each merges cleanly with S4.
>
> NOT RUN: the repository's tests and `check:changed`, because no checkout has `node_modules`; the lane's test results above are author-reported. Also not run: an end-to-end `assets.createUrl` against a running server, a live GitHub fetch, CI on this head, and a real-client pass. The latch and token-rule results come from scratch copies of the base and head code run on effect 4.1.3.
>
> Scratch folder to remove: `/tmp/s4-review-13309271` (62 MB).
>
> **BLOCK** 13309271ae7760a4d01e3c27dff5c09b11bccfa4

> Coordinator to lane coordinator, 2026-11-17 10:07:04 UTC (quote each part verbatim in the lane's record and in next2-pr-plan.md under "Coordinator answers").
>
> A. S4, goat#3522, the three questions:
> 1. B1 (a pull request opened by URL for a private repository that no project here has checked out: its own images stop loading): ACCEPTED as a known limit. The #3660 Known limits line is widened to say so: "...GitHub media is fetched with your GitHub sign-in only for repositories of projects on this server; a pull request opened by its URL for a private repository that no project here uses shows its images as broken."
> 2. Which projects count: ANY ACTIVE PROJECT of this environment. A repository counts when it is the origin or the upstream of an active project (requireProject's own matching, applied over the active projects). Reason: a paired client's read scope is the environment, not one project, so this gives it nothing it cannot already read, and it keeps a pull request link opened from another project's thread working. cwd then matters only for older clients that send no repository: their fallback repository is the cwd checkout's and it must pass the same test.
> 3. Where the check lives: AT FETCH TIME, in sourceControlMediaResponse.ts, is allowed and is better than my "minted in ws.ts" wording: it also covers URLs minted before the fix and a project removed after the mint. Conditions: the record says this departs from my earlier wording and why; the reviewer confirms no other route serves GitHub media with the credential (git grep the fetcher's callers); the decision is made from the server's project list at fetch time, never from a claim the client wrote (the claim's repository is only the name to test); tests through the real route: the attack row (a repository of no project) gets no Authorization header; a repository of another active project gets it; a removed project loses it; the older-client fallback gets it only for the cwd checkout's repository when that is an active project's. A lookup that fails or times out means NO token (fail closed), with a test.

### Commits

| commit | what |
| --- | --- |
| `8fd3f84eb7` | move-out: PullRequestService.ts stood at its entry (3759); the provider error helpers move unchanged to apps/server/src/pullRequest/pullRequestProviderErrors.ts |
| `096b025a81` | move-out: AssetAccess.test.ts stood at its entry (1673); its screenshot fixtures and layerTest move unchanged to apps/server/src/assets/AssetAccess.testkit.ts so the route test can build the same asset layer |
| `adb9c8c088` | move-out: http.test.ts stood at its entry (1290); mediaAsset moves unchanged to apps/server/src/assets/MediaFile.testkit.ts |
| `df3aec02db` (`df3aec02dbdeb8d6da81aabee7663d52d3a49907`) | the fix, with "Fixes #3522" |

Budget entries are at real length: PullRequestService.ts 3732 (dev 3759), AssetAccess.test.ts 1609 (dev 1673), http.test.ts 1280 (dev 1290). server.ts stands at its entry (1325). The fix changes one line of it in place (:1022), so its length does not change.

### What changed

- The decision lives at fetch time in apps/server/src/assets/sourceControlMediaResponse.ts:59-81. This departs from the 09:26:34 wording ("minted in ws.ts"), as allowed at 10:07:04 point 3. A fetch-time decision also covers URLs minted before the fix and a project removed after the mint. It also keeps ws.ts (3522 of 3522) and AssetAccess.ts (1077 of 1077) unchanged, both at their entries.
- The claims' repository is only the name to test, as is the cwd checkout's for an older client. Either one reaches the fetcher only if PullRequestService.hasProjectRepository answers true, for the GitHub definition's publicHost (github.com). Otherwise the fetcher gets no repository and sends no token (gitHubMediaFetch.ts carriesCredential, unchanged since 13309271ae).
- A lookup that fails, or takes longer than 10 seconds, sends no token: Effect.timeout, then a logged warning, then orElseSucceed with no repository (sourceControlMediaResponse.ts:27, :74-80).
- hasProjectRepository (PullRequestService.ts:205, :693-701) uses requireProject's own match. That match is now one function, listsRepository (:371), and requireProject calls it at :708. hasProjectRepository applies it over listWorkspaceProjects for the host across every active project, which per 10:07:04 point 2 covers a project's origin and a fork's upstream. projectRepositories keeps upstream entries, and the project list excludes deleted projects (ProjectStore.ts:138).
- Route handlers read their services per request (HttpRouter.add types them as Request.From<"Requires">). server.ts:1022 therefore gives the asset route the shared PullRequestService with HttpRouter.provideRequest(layerPullRequestService). Layer memoization makes that the same instance the routes get at :1140.
- No other route serves GitHub media with the credential. `rg fetchMedia` outside tests finds only the driver contract (source-control-core driver.ts:42), the test fake, the GitHub driver's construction (driver.ts:81) and the one caller, sourceControlMediaResponse.ts:48-82, which only the asset route uses (http.ts:577).
- The driver contract's `SourceControlMediaRequest.repository` doc now says what it is: the `owner/name` the host credential may go with (source-control-core driver.ts:22).
- Uploads: the token rule is unchanged. github.com user-attachments and legacy /assets/ uploads get the github.com token whatever the repository; the asset id is the capability. The SSO render's context is now the server-allowed repository, or the legacy path's own repository. A user-attachment in a pull request of a repository no project uses therefore gets no SSO render, which matches B1.

### Point (3): callers, before coding

- **Web PR markdown** (PullRequestMarkdown.tsx:41-47, :127) covers the Summary, Timeline, Guide and review-annotation tabs. cwd is detail.workspaceRoot and repository is the PR's.
- **Web Code tab** (PullRequestImageAnnotation.tsx:44-50): the same.
- **Mobile** (PullRequestMarkdown.tsx:65-75 → pullRequestMediaSource.ts:17-21): cwd is the root of the ref's project, and repository is the ref's.
- **Elsewhere:** chat only through PR markdown; no MCP tool mints github-media. detail.workspaceRoot is the project requireProject routed to (PullRequestService.ts:1411, :1494).

All four cases asked about keep the token: the Pulls list, a fork's upstream, a worktree thread (no caller passes a worktree path) and a remote environment. Two honest cases broke under the 09:26:34 rule:

- **B1**, a PR opened by URL for a private repository no project here uses. Accepted at 10:07:04 as a known limit.
- **B2**, mobile, when the ref's project differs from the project that holds the repository. Kept by 10:07:04 point 2 (any active project).

### Tests (failing first)

- **apps/server/src/pullRequest/PullRequestForkListing.test.ts:303** "counts a repository as a project's only while an active project's origin or upstream is it": the real PullRequestService over its project list. True for a project's origin, a fork's upstream in other letter case, and another project's origin. False for a repository of no project and for another host. After the project is removed, false for its repository.
- **apps/server/src/assets/sourceControlMediaCredential.test.ts** (new), through the real route: assets.createUrl's decoding, issueAssetUrl, resolveAsset, sourceControlMediaResponse, then the real GitHub fetcher (gitHubMediaFetch.testkit, a new package export) over an HTTP client that records the Authorization header:
  - :118 the attack row, a repository of no project named by the client, in raw, github.com blob and LFS forms: no header, 404;
  - :136 another active project's repository: the token; the same minted URL after that project is removed: none;
  - :155 an older client with no repository: the token for the cwd checkout's repository, none for a foreign file, and none once no active project uses that checkout;
  - :172 a lookup that fails, and one that never answers (TestClock past the 10 s timeout): no token.
- **Fail-first** at 13309271ae plus the move-outs: PullRequestForkListing.test.ts new case: TypeError: service.hasProjectRepository is not a function. sourceControlMediaCredential.test.ts: 5 of 5 failed with 'expected 200 to be 404' (the token went out): attack row (victim/private raw URL, first URL form), another project's repository after the project's removal, older-client fallback after the checkout stopped being a project's, lookup fails, lookup never answers.
- The eight fetch-level negative cases in gitHubMediaFetch.test.ts:284 are kept unchanged.
- **Provide lines only (rule 3):**
  - AssetAccess.test.ts "serves a host's credentialed media through that host's driver" and both sourceControlMediaResponse.test.ts cases get a PullRequestService mock in which their repositories are projects' own.
  - http.test.ts's signed-media route case gets an empty PullRequestService mock, as it does for the other services its media-file asset never reaches.
  - No expectation changed.

### S4-P3-1, the cwd residual (no code)

An older client sends no repository. If the checkout at cwd changes its GitHub remote, each fetch tests whatever identity RepositoryIdentityResolver has cached, which can be up to 15 minutes stale. The browser may reuse its private copy for up to an hour (sourceControlMediaResponse.ts:39-40), and mobile keeps immutable media under a key without the resolved identity (assetImageSource.ts:23-27). Since this round, the cached identity must still be an active project's repository to get the token. Only the same device can see bytes it was already shown, so nothing reaches another person or session.

### Known limits line for #3660 (as widened at 10:07:04)

"...GitHub media is fetched with your GitHub sign-in only for repositories of projects on this server; a pull request opened by its URL for a private repository that no project here uses shows its images as broken."

### Merge of the integration head and checks

> Coordinator to lane coordinator, 2026-11-17 10:29:46 UTC, the paragraph for S4 (verbatim):
> FOR THE OTHER LANES of #3660 (S4, X1, N4, N12, N15b): the integration head is now bd3901fca9. Each lane merges it (a merge, no rebase) when it next reaches a READY or fix-round point, not mid-row; both-sides files the reviews saw: ThreadWorkspaceService.ts (N4, merges cleanly) and GitCommitSheet.tsx (N15b, merges cleanly; N15b keeps the sheet open until a commit succeeds and the merged sheet must still render GitActionFailure). N15b takes CF1's phone captures after that merge, under the one-heavy-job token: the missing-worktree banner (goat#3658), Usage dimming (goat#3652), the Create worktree refusal (goat#3557), the failure inside a Git sheet and on the thread screen with its close button (goat#3654), the review screen's failure card on iPhone and Android.
> (Lane coordinator: relayed verbatim; for S4 the paragraph "FOR THE OTHER LANES" applies: merge origin/chase/t3-261114-next2 at bd3901fca9 into your branch (a merge, no rebase) before your READY, say whether it is git's own merge, and run check:changed against bd3901fca9.)

Merge: `4c0eb424639bf6af93614a821b048bb8f2d5c11f` merges `bd3901fca9` (CF1) into the lane after the fix round. It is git's own merge, with no conflicts: CF1's 26 files and the lane's 19 share none.

Checks, fresh:

- `vp test run` of sourceControlMediaCredential.test.ts, sourceControlMediaResponse.test.ts, AssetAccess.test.ts, http.test.ts, PullRequestForkListing.test.ts, PullRequestService.test.ts and gitHubMediaFetch.test.ts at df3aec02db's tree (before the knip autosquash, which only drops an `export`): 7 files, 227 passed.
- `vp run check:changed bd3901fca9dc8ab57dd560874b06e37fa40a2050` at 4c0eb42463, 19 files: exit 0. Format, lint, knip 1/2 and 2/2, graphql, agent surface audit, context budget, typecheck of 42 packages and the tests beside the changes (79 files, 1233 passed) all pass.
- An earlier run against ed4268897e failed only knip (`layerConfig` exported from AssetAccess.testkit.ts with no importer). That was fixed inside move-out 096b025a81 by autosquash before anything was pushed. A second run against ed4268897e was stopped when the integration head moved.

NOT RUN for the fix round:

- ci:full (CI owns it).
- An end-to-end assets.createUrl against a running server: the route test drives issueAssetUrl, resolveAsset and sourceControlMediaResponse directly.
- A live fetch against real GitHub private repositories (the HTTP client is recorded).
- The real-client pass: no client code changed.
- The independent C4 review of this round (the coordinator's, with the block report in its brief).

The quotes asked for in next2-pr-plan.md under "Coordinator answers" are left to that file's owner, because this lane touches only its own record.

### Second READY and review

READY sent at lane head `4c0eb424639bf6af93614a821b048bb8f2d5c11f`, records `5f6f63078a`.

> Coordinator to lane coordinator, 2026-11-17 10:41:02 UTC: S4's fix round at 4c0eb42463 is checked on origin (three move-outs, the fix df3aec02db, the merge of bd3901fca9; 19 files against the integration head) and its NEW C4 review is running (Opus 5.5 xhigh, task goat-next2-S4-fix-4c0eb424, with the block report in its brief): the attack closed at every input a client controls, the matcher's normalisation, fail closed on every error path, requireProject unchanged, the move-outs verbatim, the tests through the real route. S4 stands by; no push until the verdict.
>
> (Lane coordinator: relayed verbatim; quote it in next2-S4.md (records branch only). This overrides my earlier note to merge b531d2511c now: do NOT merge or push to the lane branch until the verdict; if you already merged b531d2511c locally, keep it local and say so.)

Before this note arrived, the lane had already merged `b531d2511c` (CF1F2-P3-1) locally, under the 10:39:09 instruction. The merge is `a1e390d03c`, git's own, with no conflicts, touching three mobile files the lane does not touch. It stays local, unpushed, until the verdict; the lane branch on origin stays at 4c0eb42463.
