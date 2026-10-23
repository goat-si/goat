# GOAT

GOAT runs the coding agents people already use, such as Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Pi and ACP agents, on the machines they own, puts cloud agents that run in their vendor's environment beside them, and lets people steer all of it from the desktop app, a browser, or a phone. Every machine runs a GOAT server: a Node WebSocket server that wraps the provider CLIs and serves the web, desktop, and mobile clients. On top of that, GOAT adds GOAT Bot, agents that start and follow work on other machines, Fleet, memory, and the `goat` MCP tools agents use to orchestrate other threads.

GOAT began as a fork of [T3 Code](https://github.com/pingdotgg/t3code). It keeps that event-sourced core and still merges upstream changes, so many files here are shared with upstream. [Fork delta](devlog/_chase/010_fork_delta.md) records the areas where the two differ.

## What GOAT protects

These are the things we do not trade away while the product changes.

### 1. Open at the core

GOAT is developed in a public repository. We track work in GitHub issues and pull requests, explain our reasoning there, and keep the code readable for the people who run forks of it.

### 2. Performance without compromise

Users drive agents all day, and a slow client costs them every minute. Performance regressions usually come from sending too much data over websockets, CSS animations causing GPU spikes, lists that are hard to render, and similar choices. Make sure every change is considerate of performance impact.

### 3. Every machine, every screen

The GOAT server's websocket layer is what makes remote work possible, and remote work is core to the product. Users connect directly over their local network, over Tailscale, or through SSH hosts that receive their own GOAT runtime, and they link other GOAT servers so agents can start work there. GOAT Connect, the managed tunnel, is not available yet. New features need to work when the client, the server, and the agent are on different machines.

### 4. Multi-surface

GOAT has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is served by every GOAT server: `goat` opens it locally, and paired browsers reach it from other devices.

**Desktop** is the Electron app most users install first. It bundles the server, so it can also host the environment that browsers, phones, and other desktops connect to.

**Mobile** is a React Native app for iOS and Android (`apps/mobile`). It connects to any GOAT server to control work remotely. GOAT's own build (`si.goat.mobile`) is not in the App Store or Google Play yet; the store listings the user guides link are upstream's app.

## Design stance

We like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most GOAT contributions come from GOAT itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the GOAT instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing GOAT.
- **we, us, and maintainers** mean the people building GOAT. These are who you are talking to now.
- **user** means the person using GOAT to direct coding agents.
- **agent** means the coding agent a user runs inside GOAT. Depending on context, that may also include you.
- **provider** means the agent runtime or harness GOAT talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running GOAT server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **GOAT home** means the base data directory. Runtime state normally lives below its userdata directory.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.goat/userdata` is the developer's real database, and `~/.t3/userdata` is the fallback when that file is absent. Both are in use while you work. Reading them and copying from them are fine, and a good way to get real test data (see Test data). Never start a server against either, never open one read-write, never clean one up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, and Antigravity each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Development discipline

Classify a change before choosing how much process it gets, and reclassify it when it grows: C0 text, C1 local to one file, C2 a conventional slice, C3 across module boundaries, C5 still ambiguous. Security, auth, data deletion or migration, public contracts, release, permissions, and new dependencies are C4 however small they look. Each class has a verification floor.

- Do not claim that tests pass, a bug is fixed, or work is done without a fresh command and its output. A child's report is not proof. Name each check you did not run on a `NOT RUN:` line.
- No placeholders, TODO-only changes, or fallbacks that hide a failure. Findings and plans cite `path:line`.
- Search consumers before removing an export. Get approval before destroying anything. Commit each working step. Pass generated text through files or `--body-file`.

The full rules and the lane brief checklist are in [Development discipline](docs/operations/discipline.md). Load the `goat-dev` skill for implementation work in this repository.

## Dev servers

- `vp i` installs. New worktrees get this from a `post-checkout` hook that runs `scripts/setup-worktree.ts`; if module resolution looks broken, it probably did not run, so run `node scripts/setup-worktree.ts`.
- Setup runs in the background. While `.goat/setup-running` names a live PID, wait for it and do not run `vp i`. It ends with `.goat/setup-done` or `.goat/setup-failed` (with the error tail). With no marker at all, setup never ran here, so run `vp i` yourself.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.goat` (a worktree created earlier keeps its `.t3`), which deliberately outranks an ambient `GOAT_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair`. It carries standard scopes, while the startup URL carries admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, configure one fixed `GOAT_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. Worktree setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop what you started, by the PID you tracked. See rule 1.
- Need a second checkout? `git worktree add` it next to this worktree, not in `/tmp`. Remove it when done.

## Test data

An empty database is a bad test. Seed your worktree's `.goat` with a copy of real data instead of pointing at live state:

- The first `vp run dev` in a worktree does this for you when its database is missing. `--no-seed` or `GOAT_DEV_SEED=0` skips it.
- Run `vp run migrate-dev-db` with your dev server stopped to refresh. It rebuilds `<worktree>/.goat/userdata/statev2.sqlite` from a read-only snapshot of `~/.goat/userdata/statev2.sqlite`, or `~/.t3/userdata/statev2.sqlite` when the GOAT database is absent. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Before you push, run `vp run check:changed`. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, and tests beside changes. CI still runs the full test suites.
- While you iterate, run `vp test run <files>`. For big files, add `-t "<name>"`.
- Use `vp run typecheck`, not `npx tsc`; it caches per package. Both run tsc-rs (`typescript` is the `@tsc-rs/typescript` drop-in).
- Run `node -e` snippets from `apps/server` or the owning package. `effect` does not resolve from the repo root.
- A test proves observable behavior, a contract, the regression of a real bug, or an invariant under concurrency, and its title says which. Test count is not a goal. Do not write tests that restate the implementation, assert private call sequences or mocks of internals, repeat a path another level already covers, dump snapshots without intent, or check getters and types. Prefer one integration or contract test over several unit tests of internals. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring. See the [testing policy](docs/operations/testing.md).
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- Proof for a bug fix depends on the bug. Logic, data, state, and protocol bugs get a failing test first (the fewest that fail on `main` for that reason, in the module's existing test file), then the fix. Purely visual bugs (spacing, colour, alignment, a layout shift) get before/after captures as their proof and no test: do not add UI tests for nitpicks, and do not ask for one in review when a capture already shows it. A server-only fix with no visible surface ships the test plus a short runtime transcript.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong. Concretely:
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `goat/no-test-timeout-or-unreasoned-skip`, `goat/no-frame-waits-in-browser-tests`, `goat/no-wall-clock-in-tests`, `goat/no-real-time-wait-in-tests`, `goat/no-polling-loop-in-tests`.
- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `goat/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

- User-visible frontend changes should get one integrated pass in a real client: `test-goat-app` for web, `test-goat-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Browsers and computer use are always allowed; do not ask permission first.

For authorized mobile verification, a missing or outdated native client is a build step, not a blocker. Run `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` on the simulator host before starting Metro. It checks the local Expo fingerprint and builds/installs when needed. See `test-goat-mobile` for the full workflow.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images embedded in the PR description. Motion or timing needs a short video. The `goat-screenshot-gate` check flags a PR that changes `apps/web`, `apps/desktop`, `apps/mobile`, or `apps/marketing` without an embedded image; after adding one, re-run that job. Drafts and non-UI PRs are skipped, and only a maintainer can waive it with the `gui-screenshot-waived` label.
- Attach images by dragging them into the description editor, or, from the command line, run `node scripts/pr-assets.ts upload <pr> <files...>`. It commits them to the orphan `pr-assets` branch as `<pr>/<name>` without touching your checkout, checks that each URL loads, and prints markdown that links them by commit SHA. Add `--patch-body` to repoint embeds already in the description, such as `![after](pr-assets/after.png)`. Relative paths and branch-name links never render, and the gate rejects them. Never commit screenshots or PR-only assets to the PR branch; the squash merge carries them into `dev`.
- One request is one PR. Split it only when the maintainer asks. Outside contributions follow the stricter [one problem per PR](CONTRIBUTING.md#one-problem) rule.
- When babysitting: call `goat_pull_request_watch` and end your turn. GOAT wakes you on checks, comments, or conflicts. Do not poll or sleep. Verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Merging

- Do not rebase or update-branch because `dev` moved. Rebase only on `CONFLICTING`, or when CI needs a fix that exists only on `dev`.
- Squash-merge with `gh pr merge <pr> --admin --squash --match-head-commit <head-sha>` once `goat-ci-result` is `SUCCESS` on that exact head. `CLEAN` and `UNSTABLE` (behind `dev`) are both fine.
- A failure that reproduces identically on `dev` does not block: note it in the PR and merge. Re-run flaky or cancelled jobs instead of rebasing.
- Stacks, batch merging, and the `dev` full-run cadence: [Merging pull requests](docs/operations/merging.md).
- Nightly builds `dev`; stable builds `main`, which changes only by a `Merge dev into main: release ...` promotion. A hotfix merges to `dev` first, then is cherry-picked onto `main`; never patch `main` alone. See [Release channels](docs/internals/release-channels.md).

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- [structure/INDEX.md](structure/INDEX.md) is the one compact map of the current system, including the records in `structure/decisions/`. Update a subsystem doc and `structure/manifest.json` only when a module boundary, contract, or decision changes, not on every PR. User workflows stay in `docs/user/`. `docs/internals/` keeps the reasons and traps; [`devlog/_chase/010_fork_delta.md`](devlog/_chase/010_fork_delta.md) keeps the fork areas that conflict with upstream.
- In `docs/` and other prose, do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index. The `structure/` map is the one catalog this rule allows.
- Keep a local implementation explanation in a nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed GOAT server in the user guides.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without doing any I/O. The _event sink_ commits those events, the _projections_ the UI reads, the _command receipt_, and _outbox_ effects in one transaction. The _effect worker_ then runs the effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Architecture and its constraints: `docs/internals/overview.md`. Glossary: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect-smol/LLMS.md` for the Effect library itself.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency. Thread worktrees leave `.repos/` out (`worktreeSparseExclude` in `goat.json`), so read it from the main checkout, the first path in `git worktree list`, read one file with `git show origin/dev:.repos/<path>`, or run `git sparse-checkout disable` to bring it into this worktree.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES` in contracts and use the command's `permissionAtom` for UI availability. Grants are checked at execution against the destination environment; the server remains authoritative. Keep raw RPC clients inside `rpc/`, and extend the permission behavior tests when adding a protected method.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations. See [Web UI](docs/internals/web-ui.md).
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable span name, not a
  function wrapping `Effect.gen`. Keep `Effect.gen` for inline programs and layer construction.
  Use `Effect.fnUntraced` only when spans would be too frequent (stream chunks, per-event
  projection, tight loops) or duplicate an existing tracing boundary; explain that choice nearby.
  Named `Effect.fn` creates a span; the unnamed form does not. Preserve existing span names and
  options, and pass combinators as additional function-builder arguments.
- Inferred types over annotations. `any` is the enemy.
- New files stay under about 800 lines. `goat/code-budget` fails a file over 1000 lines, a listed file that grows past its recorded length, and new non-null assertions (outside tests) or casts to `any`. Move code into a new module instead of raising the baseline. See [code budgets](docs/operations/code-quality.md).
- GOAT features live in GOAT-owned modules. An upstream file gets a thin hook only (an import, a registration, a call), because every changed upstream line can conflict on the next upstream merge.
- Comments say why: a constraint, an external quirk, or an invariant the code can't show. Don't restate names or signatures, narrate steps, or record history. `goat/no-low-value-comments` catches the mechanical cases.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Verifying with browsers or computer use is pre-approved. Use it whenever it helps prove a change works.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
