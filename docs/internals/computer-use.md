# GOAT Computer Use

Status: proposed design for the GOAT Computer Use epic (#1140). The decisions are recorded in
[ADR-0023](../../structure/decisions/ADR-0023-goat-computer-use-app.md), which amends
[ADR-0022](../../structure/decisions/ADR-0022-cua-driver-computer-use.md). What ships today is
described in [server.md](../../structure/server.md#computer-use) and
[desktop.md](../../structure/desktop.md#computer-use-host). This page keeps the constraints and
traps behind the design; the workstream issues own the remaining work.

## Process model

```text
provider (Codex, Claude, ...)
  └─ stdio MCP: goat cua-session-proxy        one per thread session, holds the thread's MCP credential
       └─ GOAT server computer-use service    admission, approvals, lease, preview session, typing of results
            └─ desktop host control pipe       Electron main on desktop; the server itself elsewhere
                 └─ helper (NDJSON over stdio) GOAT Computer Use.app / .exe / Linux helper
                      └─ cua-driver serve --embedded --host-bundle-id <helper id>
                           └─ OS accessibility, capture and input
```

- The helper is the only process that holds OS grants for computer use. It does not take grants
  away from GOAT.app: SnapShot (`apps/desktop/src/snapShot/DesktopSnapShot.ts`) asks GOAT.app for
  Screen Recording and Accessibility, grants given to GOAT.app under ADR-0022 stay until a person
  removes them, and processes GOAT starts without disclaiming responsibility, provider CLIs
  included, still run under whatever GOAT.app holds. Keeping provider processes off GOAT.app's
  grants is separate work (#1208).
- On macOS the helper disclaims responsibility at its
  own start by re-executing itself once, before it touches any TCC-protected API, and keeps the
  stdio pipes it inherited. The first process stays alive as a waiter and forwards the exit status,
  so the launcher's child handle still tracks the real helper. After that, whoever launched it
  (Electron, a standalone server, a terminal), macOS attributes the grants to the helper bundle.
- The driver runs embedded under the helper. In embedded mode pinned 0.37.0 skips its own disclaim
  and checks that its direct parent carries the bundle id passed as `--host-bundle-id`, so the
  helper must be the driver's parent, not a sibling and not a LaunchServices launch.
- Desktop servers ask Electron for the helper over the existing private control pipe
  (`cuaDriverRequest` / `cuaDriverReport` in `packages/contracts/src/cua.ts`). A standalone server
  on macOS launches the helper from an installed GOAT.app; without one it reports computer use
  unavailable with that reason. It no longer starts the driver under `si.goat.server` (#1174).
  Windows and Linux servers launch their platform helper directly.
- Every turn, interactive or unattended, attaches GOAT's proxy in place of `cua-driver mcp`. The
  proxy generalizes today's lease proxy (`apps/server/src/cua/ComputerUseLeaseProxy.ts`): it asks
  the server before each call and holds one session for its thread and generation.
- Inside the helper each session has its own driver client process, the `cua-driver mcp` child
  the lease proxy owns today, now started by the helper against its daemon. Ending a session kills
  exactly that child. That is the boundary ADR-0022 measured: cancellation and session revoke do
  not stop a running `run_script`, and killing its transport does.
- Stop, stop all, lease end, a lost stream, or computer use turned off end the session at every
  hop. The proxy refuses new calls and exits. The server marks the session ended and tells the
  helper over the control channel. The helper kills that session's driver client, releases the
  input that session holds, and sends a cleanup report over the control channel, which does not
  depend on the proxy still being there. A disconnect at any hop ends the session the same way:
  a vanished proxy makes the server end it, and a vanished server or host closes the helper's
  stdin, so the helper ends every session.
- Sessions of other threads keep running through a Stop; stop all ends every session. ADR-0022's
  six-app `run_script` stop measurement is repeated through this topology before WS6 counts as
  done.
- Remote machines run their own server and helper. Each server checks its own screen before
  starting the helper (`apps/server/src/cua/CuaDisplayCapability.ts`, from #697) and reports
  `available`, `partial` or `unavailable` per host. The controlled desktop is always the one the
  server runs on, never the client's device.

Trap: Node's `child_process` cannot set the disclaim spawn attribute, which is why the helper
disclaims itself instead of being spawned disclaimed. Launching it with `open` would disclaim too
but loses the stdio pipes, and the driver would no longer be a child of a process GOAT holds.

The Codex app's computer use helper has the same shape at the identity level: a separately signed
background app with its own designated requirement and its own updater, refreshed into a per-user
location, reached over a per-user socket and started through LaunchServices when it is not
running. GOAT keeps a spawned helper with stdio, because a spawned child gives the host its
lifetime and pipes for free and needs no listener. The disclaim interface it relies on is private.
If a macOS release breaks it, the fallback is the Codex arrangement: launch the helper through
LaunchServices, which makes it its own responsible process with public API, and connect over a
per-user socket that verifies the peer from its audit token against the helper's designated
requirement, never from a pid or path alone. The driver stays the helper's child either way.

## Channel

- Spawned helpers speak NDJSON on stdin/stdout, one JSON record per line, with request ids,
  cancellation by id, and a per-line size cap enforced on both ends. Screenshots travel as base64
  inside the record; the cap is sized for one bounded window capture, not for streams.
- The launcher verifies the helper's code signature against the expected designated requirement
  (team id and bundle id) before it spawns, then sends a per-launch random token as the first
  frame. The token never goes in argv or the environment, which other processes of the same user
  can read. The helper answers with its protocol version, helper version, driver version, bundle
  id, executable path and pid. Each side states the API version it speaks; an incompatible pair
  ends the handshake with `incompatible_client_version` rather than degrading.
- Every request carries a deadline and the session's helper generation. A response is accepted
  only from the executable, pid and generation the handshake bound; results that arrive after a
  Stop or a generation change are quarantined and never reach the agent.
- A socket, in the fallback above or for a helper that outlives its launcher, uses a 0700
  directory, the same token, and a peer check on every accept: audit token to code signature to
  the designated requirement.
- The driver's own daemon socket lives in the helper's private state directory. It has no secret
  (ADR-0022 "Limits"); the helper narrows which path agents get, not what the OS user can reach.
- Liveness runs both ways: the helper exits when stdin closes or its launcher pid disappears, and
  the driver is started so that it exits with the helper. An orphaned driver after a helper crash
  is a qualification failure.

## Observation

- A target is `{pid, windowId, epoch}`. The epoch changes when the window moves to another Space
  or display, the app relaunches, or the window is replaced. Element ids are valid only within one
  target and epoch.
- The first observation of a target is full: window screenshot plus accessibility tree. Later
  observations are diffs against the last tree the agent saw, keyed by stable element ids, with
  changed, added and removed elements. The helper falls back to a full snapshot when the tree was
  reordered, the capture was incomplete, or the window changed. Diffs are computed in the helper
  from consecutive full trees, so every platform gets them even where the native API only returns
  full trees.
- Acting on an id from an older epoch, or one that no longer resolves to exactly one element,
  returns `stale_element`. The helper never guesses among several matches.
- A text-only observation returns the tree without capturing pixels. Omitting the image from a
  response is not the same as not capturing it; the browser preview had that gap
  (`apps/server/src/mcp/toolkits/preview/tools.ts` `includeImage`), and the shared protocol makes
  capture an explicit choice.
- Coordinates in a screenshot carry the snapshot's scale, so a coordinate action cites the
  snapshot it was read from and the helper converts it for that snapshot only.
- An observation made for the preview panel or a readiness check never counts as the agent's
  fresh observation; only the agent's own observe call resets its stale state.

## Actions and results

- Actions: click, double and right click, type, key and hotkey, scroll, drag, set value, select
  text, and semantic accessibility actions (press, menu, increment). Every action names an exact
  target; there is no "frontmost window" default.
- Background delivery comes first. Foreground delivery (activating the app or raising the window)
  happens only when the lease's scope allows it and is reported in the result.
- Each action is decided before dispatch: the helper picks one route (semantic, background
  synthetic, or foreground) and does not switch routes or windows after an unknown outcome.
- Results: `confirmed` (the effect was read back), `partial` (some steps ran), `unverifiable`
  (dispatched, effect unknown), `suspected_noop` (dispatched, nothing changed), and
  `refused(reason)` (not dispatched). Synara's `not-dispatched / dispatched-unknown / verified`
  maps onto `refused`, `unverifiable` and `confirmed`.
- `partial` and `unverifiable` are never replayed automatically. The agent must observe again
  before deciding.
- Refusal reasons are typed and say what happened: `not_admitted`, `lease_expired`,
  `app_not_approved`, `private_mode`, `human_control`, `input_collision`, `stale_element`,
  `target_gone`, `target_refused` (a policy refusal, with the policy named), `blocked_url`,
  `permissions_not_granted`, `permissions_pending`, `screen_locked`, `user_intervened`,
  `incompatible_client_version`, `unsupported` and `user_stopped`. `user_stopped` is used only
  when a person pressed Stop or stop all, and `user_intervened` only when the helper saw a
  person's input. A vendor helper that reports a policy refusal as "stopped by the user" makes
  agents end their turn (#1146); GOAT's helper does not.

## Transcript fidelity

The rule: the screenshot the model saw is the screenshot the person sees.

- Every MCP result GOAT returns puts images in `content` image blocks. When a result carries an
  image, it omits `structuredContent` and repeats the metadata in a text block. The Codex harness
  sends only `structuredContent` to the model when it is present, so a result with both reaches
  the model without its image (#1154).
- The driver's `get_window_state` returns both. The session proxy rewrites such results, which is
  one more reason every turn goes through the proxy.
- Adapters keep both `content` and `structuredContent` on the turn item, so the timeline and the
  asset service find the same images the model received (#1127). The Computer Use run card shows
  the target app and window, the action, the latest screenshot, status and lease on web, desktop
  and mobile.
- Contract fixtures cover image-only, structured-only, mixed and error results for each provider
  harness GOAT ships.
- A screenshot carries the request id, helper generation, thread and environment it was taken
  for. Before it is attached, its source, size and format are checked; the helper never hands
  over a file path the server would read. A late result from before a Stop or owner change, or
  one addressed to another session, is discarded instead of attached (#1163).
- Raw screenshots and accessibility text never go into telemetry or logs.

## Preview session protocol

Native computer use and built-in browser use share one contract in `packages/contracts`, one
schema for both kinds:

```text
PreviewSession {
  id, kind: "browser" | "desktop", environmentId, platform: "mac" | "windows" | "linux",
  target: { tabId, url, title } | { bundleId, pid, windowId, title },
  owner: "agent" | "human" | "private",
  status: idle | observing | acting | waiting-for-human | paused | stopped | error | permission-needed,
  lease?: { threadId, expiresAt, scope }, lastFrame?: asset reference, capabilities
}
```

- Controls have the same names everywhere: `takeover` (a person takes control), `handBack`
  (person to agent), `requestHandoff(reason)` (agent asks a person), `stop` (this thread) and
  `stopAll` (kill switch). Status chips: "Agent controlling", "You're controlling", "Private —
  paused", "Waiting for you", "Stopped", "Permission needed". Web, desktop and mobile render the
  same panel from the same state.
- The existing browser owner (`agent | human | unclaimed` with a control generation in
  `packages/contracts/src/previewAutomation.ts`) maps onto this: `unclaimed` becomes an idle
  session with no lease, and the generation stays the fence that drops in-flight results after a
  change of owner.
- Handing control to a person is not the same as hiding the screen from the agent. Today
  `SessionControl.observe()` (`apps/server/src/preview/SessionControl.ts`) lets an agent read
  while a person drives; that stays true for `human` and must not be true for `private`.
- Private mode starts by itself while a secure field or passkey prompt has focus: `input[type=password]`,
  `autocomplete=current-password` or WebAuthn in the browser; `AXSecureTextField`, UI Automation
  `IsPassword` or the AT-SPI password role on desktops. Observation, frame streaming and recording
  pause, in-flight results from before the switch are dropped by generation, and the agent gets
  `private_mode` refusals until it ends. Only the person's explicit action ends it.
- Ego Lite level for the browser means: a task space that groups an agent's tabs and keeps their
  login state together (profile policy shared, isolated per task, or incognito, each explained),
  a text-only snapshot, and a handoff in which a person finishes a step in the same tab and the
  agent resumes in the same task. Native windows reuse the handoff and snapshot semantics; task
  spaces stay a browser concept.
- Frames stream only to a viewer that is open, at a bounded rate, dropping frames instead of
  queueing them, and stop when nobody watches. Idle panels show the last frame. A preview frame is
  never fed to the model.

## Safety

- **Approvals.** A person approves apps per thread, or always, through a handoff that needs
  `settings:write` in an authenticated client session. The capability manifest
  (`packages/shared/src/cuaDriverManifest.ts`) stays the ceiling: it excludes the GOAT host, the
  helper itself, the driver's app and credential stores, and it now adds the helper's bundle id.
  The approval card names the app and machine, warns when the app is high risk, explains on first
  use that screenshots of its windows reach the model, and offers "Allow this conversation",
  "Always allow" and "Deny". An approval binds the app's canonical identity (bundle id or
  executable path) at approval time, and the action runs on that frozen target, so a request
  cannot be approved for one app and executed against another. "Always" approvals are listed in
  Settings, where a person removes them; a removed app asks again.
- **Lease.** Control is a time-bounded lease per thread with a scope: approved apps and whether
  foreground delivery is allowed. Unattended origins keep ADR-0022's admission lease and driver
  ceiling unchanged.
- **Stop.** Per-thread Stop and `stopAll` kill the proxy transport at once. The helper then cancels
  queued input, releases anything held (mouse buttons up, modifiers cleared) and reports cleanup
  complete; a kill without that report is shown as stopped with cleanup unconfirmed. A replacement
  session for the same thread waits for the cleanup report.
- **Physical kill switch.** On macOS the helper can arm a listen-only Escape tap while an agent
  session is active. A keyboard event tap needs Input Monitoring, a third grant, so the switch is
  optional: onboarding offers it, and without it the Stop controls remain.
- **Input collision.** When a person uses the same desktop while an agent acts, the agent pauses
  and the session moves to `waiting-for-human`. On macOS the helper samples HID idle time, which
  needs no extra grant. Whether the helper's own foreground input resets that timer is a
  qualification item; background delivery to a process does not go through the HID system state.
- **Takeover and hand-back.** Takeover fences new agent input immediately and drops in-flight
  results by generation. Hand-back rechecks the lease and its expiry and requires a fresh
  observation before the next action. Disconnects and retries never hand control back by
  themselves.
- **Lock, sleep and display changes.** Screen lock, sleep, a switch to another user, or a display
  change during an admitted action starts a new interruption epoch. The helper fences queued
  input, cancels the action in progress, releases held input and counts the interruption per
  session. Results from before the epoch are discarded, element ids from before it are stale, and
  the session moves to `paused`. Resuming needs an unlocked session, a lease that is still live or
  a person's hand-back, and then a fresh observation.
- **Limits.** Interactive threads on one desktop still share the person's session; GOAT serializes
  input per target and pauses on collision, and does not promise separate seats. Operating a
  locked screen is out of scope.

## Permission onboarding

- **macOS.** First run asks for Accessibility and Screen Recording for "GOAT Computer Use", not for
  GOAT. Readiness is proven, not inferred from switches: a fresh helper must report its own bundle
  identity, read a non-empty accessibility tree and capture a non-blank window. Today's desktop
  verify (`apps/desktop/src/cua/DesktopCuaDriver.ts`) already checks this for the Electron host;
  it moves into the helper. The permission guide drags the helper bundle into System Settings
  (`apps/desktop/src/permissions/MacPermissionHelper.ts` points at GOAT.app today).
- **Migration.** A person who granted GOAT.app under ADR-0022 sees one prompt explaining that
  computer use now has its own app and grants again. GOAT never removes or resets grants. The
  prompt also says that the old GOAT entries stay on, that only SnapShot still needs them, and
  that while they are on, processes GOAT starts can use them; it opens the System Settings pane so
  a person who does not use SnapShot can turn them off.
- **Usage strings.** The helper's `Info.plist` carries the Accessibility, Screen Recording and
  Apple Events usage descriptions (GOAT.app lacks them today, #1175).
- **Development builds.** Ad-hoc signatures change the code hash on every build, and TCC keys
  grants to it, so a rebuilt development helper asks again. Sign development helpers with a stable
  local certificate to avoid it; builds never run `tccutil reset`.
- **Windows.** No OS grant. Readiness needs an interactive session (Session 0 over SSH or a
  service is `unavailable`), a non-empty UI Automation tree and a non-blank Windows Graphics
  Capture frame. Elevated windows are out of reach of a non-elevated helper; they return
  `target_refused` and the helper is never elevated to reach them.
- **Linux.** X11 needs a reachable display, a session bus and an AT-SPI bus that answer (the
  existing probe). Background input on X11 also needs an Xorg server that accepts hotplugged
  devices and a writable `/dev/uinput`; without them readiness reports `partial`, and input falls
  back to foreground delivery under a lease that allows it, never to synthetic events presented
  as background. Wayland needs the portal consent for screen cast and remote desktop, kept with a
  restore token, and reports `partial` until the person grants it.
- Readiness is four separate answers, shown separately: the OS grant, an authenticated helper,
  a real capture and tree, and the tools available to the model this turn. Pending, denied,
  abandoned and intervened are distinct states; a closed prompt never reads as granted.
- The same `permission-needed` status and chip appear on every client. Remote clients show which
  machine needs the grant; it can only be granted at that machine.

## Packaging, signing and updates

- Bundle layout on macOS: GOAT.app `Contents/Helpers/GOAT Computer Use.app`, whose main
  executable is a small Swift program (the disclaim, the channel, held-input release, the Escape
  tap, permission probes) and whose resources hold `cua-driver` and `cua-cursor-theme`. The
  release manifest already requires the cursor theme tool, which the desktop artifact does not
  copy today (#1176).
- Signing goes inside out: `cua-driver` and `cua-cursor-theme`, then the helper bundle with its
  own entitlements (hardened runtime, Apple Events; no JIT, no disabled library validation, no
  `get-task-allow`), then GOAT.app. Notarization covers the outer artifact and its nested code.
- Stage executables by writing their bytes rather than copying files: a copy can carry the
  `com.apple.provenance` attribute, and Gatekeeper then kills the helper at launch.
- The helper has its own version, records the driver version and patch set it carries, and has
  its own update. The copy inside GOAT.app is the seed; the helper that runs is an installed copy
  in a GOAT-owned directory, one directory per generation. A helper update is its own signed and
  notarized artifact. Before a switch, the host checks the new copy against the helper's
  designated requirement and the protocol version range the host supports, and it never installs
  over a generation that is running. Leases are drained or revoked and active sessions end
  through the normal Stop path with their cleanup report; the host then switches to the new
  generation in one step, keeps the previous one for rollback, and rechecks all four readiness
  answers before agents get the new helper; a failed check switches back. A GOAT update that
  carries a newer seed goes through the same switch. TCC keys
  grants to the designated requirement, not the path, so grants should survive a switch; that,
  and a revoked grant being noticed, are negative qualification cases (#1162).
- The Windows helper is signed through the existing Windows signing path and staged beside the
  driver. Linux desktop artifacts are not signed today, so signing the Linux helper and verifying
  its signature before launch is new work for WS10 and WS4, and its CI part is a proposal like
  the rest.
- This epic adds local build and signing scripts. Wiring them into CI and release workflows is a
  separate proposal issue for maintainers.
- Telemetry stays off. The helper reports nothing to anyone, and the driver keeps ADR-0022's
  opt-outs.

## Engine patches

GOAT runs upstream Cua Driver and carries only small patches it needs and upstream lacks, each a
separate file with its source and license recorded:

- batched accessibility attribute reads with a prefetch pool (the largest speedup for big trees);
- input cancellation with held-input release;
- panic containment in `serve` and host-pid liveness polling on Unix;
- a settle wait driven by accessibility notifications, text range selection, and append for set
  value;
- a wider keymap (F13–F20, keypad, Help, Menu).

Where the driver already exposes a setting, use it instead of a patch
(`CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS`, `CUA_DRIVER_KEY_GAP_MS`). Do not re-patch focus and
background delivery code 0.37 already contains, and do not carry Cua browser tool patches: GOAT
has its own browser surface. Several of these patches come from synara (MIT); its copyright
notice goes into the helper's third-party notices with them.

## Licensing and provenance

- Shipped: Cua Driver and its SDK (MIT; the SDK's Node runtime is MPL-2.0 with its notice), GOAT's
  own helper code, and synara-derived patches (MIT) with notices.
- Never shipped, linked or copied: Cua Spaces, the viewer and media components (FSL), and the
  perception models and set-of-marks code (AGPL). See
  [open-source-licenses.md](open-source-licenses.md).
- Aside, the Codex app and Ego Lite's browser are proprietary. GOAT takes their product patterns
  (a separate helper identity, per-app approval, typed refusals, handoff) and writes its own code;
  nothing from their binaries, keys, names or reverse-engineered sources enters the repository,
  test fixtures included (#1161). Ego Lite's public harness is MIT and is used only as a naming
  and behavior reference.
- Research behind this design lives outside the repository (notes L1–L5 and R1–R4 for the epic,
  a static analysis of the Codex computer use build 26.1016.51333, and a live probe of the Codex
  baseline). It is cited by name only.

## Cross-platform parity

One protocol, three helpers. Every method is implemented or returns a typed `unsupported` with a
reason; nothing fails with an untyped error. "Fallback" means the method works through a
different route that the result reports.

| Protocol method or surface                                  | macOS                       | Windows                             | Linux X11                                                                           | Linux Wayland                                                                            |
| ----------------------------------------------------------- | --------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `hello` / version handshake                                 | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| readiness (real tree + non-blank capture)                   | yes                         | yes                                 | yes                                                                                 | after portal consent where the compositor supports discovery and capture; else `partial` |
| request permission                                          | TCC prompts                 | `unsupported` (none needed)         | `unsupported`                                                                       | portal consent                                                                           |
| list apps / windows                                         | yes                         | yes                                 | yes                                                                                 | compositor dependent, else `unsupported`                                                 |
| observe full (tree + screenshot)                            | yes                         | yes                                 | yes                                                                                 | where the target can be captured; else tree only with `partial`                          |
| observe diff                                                | yes (helper computed)       | yes (helper computed)               | yes (helper computed)                                                               | yes (helper computed)                                                                    |
| observe text-only                                           | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| stale id → `stale_element`                                  | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| wait for settle                                             | accessibility notifications | UIA events                          | AT-SPI events                                                                       | AT-SPI events                                                                            |
| semantic actions                                            | AX actions                  | UIA patterns                        | AT-SPI actions                                                                      | AT-SPI actions                                                                           |
| background pointer and keys                                 | yes                         | partial, foreground fallback        | with Xorg hotplug and writable `/dev/uinput`; else `partial`, foreground with lease | `unsupported`; foreground with lease                                                     |
| foreground delivery under lease                             | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| set value / select text                                     | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| cancel by request id                                        | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| end session + held-input release + cleanup report           | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| private mode detection                                      | `AXSecureTextField`         | `IsPassword`                        | AT-SPI password role                                                                | AT-SPI password role                                                                     |
| lock, sleep and session-switch events                       | yes                         | session change notifications        | logind and screensaver signals                                                      | logind and screensaver signals                                                           |
| human input collision                                       | HID idle time               | last-input time, own input filtered | X idle time                                                                         | `unsupported`; exclusive lease                                                           |
| physical kill switch                                        | Escape tap (optional grant) | low-level keyboard hook             | XInput2 raw keys                                                                    | `unsupported`; Stop controls only                                                        |
| preview frames                                              | yes                         | yes                                 | yes                                                                                 | through the portal screen cast where granted; else last observation only                 |
| `takeover`, `handBack`, `requestHandoff`, `stop`, `stopAll` | yes                         | yes                                 | yes                                                                                 | yes                                                                                      |
| onboarding flow, panel, chips, controls                     | same                        | same                                | same                                                                                | same                                                                                     |

Tests enforce it: the contracts package declares the method list, and a conformance suite runs the
same fixture requests against each platform helper, failing when a method is missing or a refusal
is untyped. The client tests render the same panel state for each platform.

## Qualification

Evidence is kept by tier, and a lower tier never stands in for a higher one: docs and static
review, unit and contract tests, the control plane without input, GOAT-owned fixture apps, the
real gateway with providers, and a signed packaged app on a real OS and display.

- **Fixture apps.** A GOAT-owned fixture per platform with known trees, a secure field, a modal,
  drag targets and counters that record what it received. Negative cases: wrong pid or window,
  stale ids, an epoch change, Stop while queued, held modifiers during a kill, helper death, lost
  listener, a Stop of one thread while a sibling acts, and lock or sleep during a held drag and
  during typing.
- **Real apps.** Calculator, TextEdit, Finder, a Chromium browser and an Electron app on macOS, and
  equivalents per platform, each with clean and contaminated runs reported apart.
- **Latency.** The Codex baseline on Calculator (one run, 2026-10-24, macbookpro-2): full tree
  68 ms, window screenshot 86 ms, accessibility press 31–116 ms, diff observation with settle
  393 ms, no focus change. Synara's historical p50 (warm tree 219 ms, click 659 ms, semantic
  compose 1343 ms) is context, not a target. GOAT's budget starts at no worse than twice the Codex
  baseline at p50 on the same machine and app, reported with p95 over at least 30 warm runs, and
  tightens once WS11 has measured both.
- **Hard gates (#1139).** A certification run has a required case list and fails with zero
  executed rows. Its report pins at the top: helper hash, signer and bundle id, driver version and
  patches, OS build, display setup, provider and model, GOAT commit. Focus exemptions are listed,
  and a run with exemptions is never cited as zero focus change. Failed runs are kept.
- **Visual proof.** Every UI change carries real before and after screenshots from a running app;
  one thread at a time drives a machine's real GUI.

## Workstreams

Process for this epic (lead decision D9): pull requests target `dev` only, one topic each at about
20 files or fewer; agents never merge; CI, workflow and release files are not edited, and helper
signing in CI is a proposal issue; UI pull requests carry real before and after screenshots; one
thread at a time drives a machine's real GUI, assigned by the epic's lead.

| Phase | Workstream                                       | Depends on      | Phase is done when                                                                                     |
| ----- | ------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------ |
| P0    | WS1 #1127 transcript fidelity and run card       | —               | model and timeline see the same screenshot for every provider fixture; run card on web and mobile      |
| P1    | WS2 #1128 this design and the protocol contracts | —               | ADR merged; preview session and helper protocol schemas in `packages/contracts` with the parity list   |
| P2    | WS3 #1129 macOS helper core                      | WS2             | signed helper launches, disclaims, starts the driver, passes readiness, observes with diffs            |
| P2    | WS4 #1131 packaging, signing, notarization       | WS3             | notarized GOAT.app with the helper; grants survive an update; notices complete                         |
| P3    | WS5 #1133 action API                             | WS3             | typed results, no replay, exact targets, background first, on fixtures                                 |
| P3    | WS6 #1134 safety rails                           | WS3, WS5        | every turn through the proxy; Stop and stop all with cleanup report; takeover, private mode, collision |
| P4    | WS7 #1135 unified preview surface                | WS2, WS6        | one panel, chips and controls for browser and desktop on web, desktop and mobile                       |
| P4    | WS8 #1136 onboarding parity and matrix tests     | WS3, WS7        | onboarding on the helper identity; conformance suite enforces the matrix                               |
| P5    | WS9 #1137 Windows helper                         | WS2, WS5, WS6   | conformance suite green on Windows; unsupported cells typed                                            |
| P5    | WS10 #1138 Linux helper                          | WS2, WS5, WS6   | conformance suite green on X11 and Wayland; unsupported cells typed                                    |
| P6    | WS11 #1139 qualification and visual verification | runs throughout | hard gates met on a signed packaged build per platform; latency within budget                          |
