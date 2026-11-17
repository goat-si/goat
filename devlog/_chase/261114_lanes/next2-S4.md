# S4 auth (lane record)

Lane branch: `chase/t3-261114-next2-s4-auth`, head `13309271ae7760a4d01e3c27dff5c09b11bccfa4`, cut from the integration branch `chase/t3-261114-next2` at `ed4268897e3183341694f27e488232572d5c5151` (draft PR #3660). Host pen-macbookpro2. Both rows are C4. Plain push, no force.

## Rows and commits

| row | GOAT commit | result |
| --- | --- | --- |
| goat#3657 (dev's #3612) | `ec3c14cab263994bae13ea8382d9d576e78b75be` | the call's child reads the removal mark when it starts (apps/server/src/auth/SessionEndLatches.ts:58-60) |
| goat#3522 | `13309271ae7760a4d01e3c27dff5c09b11bccfa4` | option B: the github.com token goes with a repository file or LFS object only of the request's repository; anything else is fetched without it |

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
