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
            └─ desktop host control pipe       Electron main on desktop
                 └─ helper (line JSON on stdio) GOAT Computer Use.app / Windows / Linux helper, #1207 envelope
                      └─ cua-driver mcp --direct --embedded --host-bundle-id <helper id>
                           one stdio process per session, no listening socket
                           └─ OS accessibility, capture and input
```

- The helper is the only process that holds OS grants for computer use. It does not take grants
  away from GOAT.app: SnapShot (`apps/desktop/src/snapShot/DesktopSnapShot.ts`) asks GOAT.app for
  Screen Recording and Accessibility, grants given to GOAT.app under ADR-0022 stay until a person
  removes them, and processes GOAT starts without disclaiming responsibility, provider CLIs
  included, still run under whatever GOAT.app holds. Keeping provider processes off GOAT.app's
  grants is separate work (#1208).
- On macOS the helper (`apps/desktop/native/computer-use-helper/main.swift`) checks its parent,
  then re-executes itself once with responsibility disclaimed, before it touches any
  TCC-protected API, and keeps the stdio pipes it inherited. The first process stays alive as a
  waiter and forwards the exit status, so the launcher's child handle still tracks the real
  helper. macOS then attributes the grants to the helper bundle.
- The driver runs embedded under the helper. In embedded mode pinned 0.37.0 skips its own disclaim
  and checks that its direct parent carries the bundle id passed as `--host-bundle-id`, so the
  helper must be the driver's parent, not a sibling and not a LaunchServices launch.
- The driver runs as `cua-driver mcp --direct --embedded` (lead decision D3 amendment, #1210): one
  stdio process that owns the driver runtime and listens on nothing, so no provider and no other
  process of the user ever gets a socket path. Spawned by the helper it reports host attribution
  and the helper as its parent application, exactly as `serve --embedded` does. Agent calls reach
  it only through the helper, which brokers them in the #1207 envelope. The first helper
  (#1211) still starts `serve --embedded` on a host-chosen socket; signed helper builds stay blocked
  until the broker replaces it (#1202).
- The driver's own cursor overlay is unavailable in direct mode, so the helper draws the agent
  cursor and window highlight itself (#1214), hidden in private mode and during a takeover.
- Desktop servers ask Electron for the driver over the existing private control pipe
  (`cuaDriverRequest` / `cuaDriverReport` in `packages/contracts/src/cua.ts`), and the Electron host
  runs it through the helper when the build has one (`apps/desktop/src/cua/DesktopCuaDriver.ts`).
  A standalone server on a Mac reports computer use unavailable, because its launch chain ends at a
  terminal or a launchd job (#1174). Windows and Linux servers launch their platform helper
  directly.
- Every turn, interactive or unattended, attaches GOAT's proxy in place of `cua-driver mcp`. The
  proxy generalizes today's lease proxy (`apps/server/src/cua/ComputerUseLeaseProxy.ts`): it asks
  the server before each call and holds one session for its thread and generation.
- Each session has its own `mcp --direct` driver process under the helper, and ending a session
  kills exactly that process. That is the boundary ADR-0022 measured: cancellation and session
  revoke do not stop a running `run_script`, and killing its transport does. WS3 qualifies
  several direct runtimes side by side; if they cannot coexist, that changes this decision and
  is recorded as an amendment to ADR-0023.
- Current state, not the design: the first helper (#1211) runs one `serve --embedded` daemon that
  every session shares, and Stop behaves as ADR-0022 describes: only a leased turn's proxy kills
  its `cua-driver mcp` client.
- Stop, stop all, lease end, a lost stream, or computer use turned off end the session at every
  hop. The proxy refuses new calls and exits. The server marks the session ended and tells the
  helper over the control channel. The helper kills that session's driver process, releases the
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

- The helper speaks line-delimited JSON on its inherited stdin and stdout, and nothing else.
  Requests and replies use the #1207 envelope (`packages/contracts/src/computerUseProtocol.ts`):
  request ids, a per-request `deadlineMs`, and a frame limit both sides agree on in the hello,
  between 64 KiB and 16 MiB. Screenshots cross as base64 inside one bounded frame and leave
  GOAT's MCP surface as image content.
- Trust starts at the parent. A release helper serves only a parent signed by GOAT's Developer ID
  team with the GOAT app identifier its own id extends (`si.goat.desktop` for
  `si.goat.desktop.computer-use`), and its service half accepts only its own launcher; a dev helper
  serves any parent. The host checks the helper's first line (protocol and bundle id) and that the
  driver it reports is the helper's own child (#1213), then exchanges the #1207 hello:
  `clientApiVersion` against `serverApiVersion`, with `incompatibleClientVersion` instead of a
  degraded session.
- The parent check is only as strong as the parent. GOAT's executable can run as plain Node
  (`ELECTRON_RUN_AS_NODE`), so until GOAT's backend runs from a separately identified runtime and
  the main app's run-as-Node fuses are off, any same-user process can pass the check by running
  code under GOAT's signature (#1210). Signed helper builds stay blocked on that (#1202).
- Replies are bound to the helper's executable, pid and generation from the hello.
  `admitComputerUseReply` quarantines replies from another generation, to a request a Stop or a
  deadline already ended, or over the frame limit; they never reach the agent.
- A socket, in the fallback above or for a helper that outlives its launcher, uses a 0700
  directory, a per-launch token, and a peer check on every accept: audit token to code signature
  to the designated requirement.
- Liveness runs both ways. A spawned helper exits when stdin closes or its launcher pid
  disappears. A helper reached over a socket instead ends every session of a client whose
  connection drops, through the normal Stop path with its cleanup report, and exits after an idle
  period with no client and no session. Either way the driver is started so that it exits with
  the helper, and an orphaned driver after a helper crash is a qualification failure.

## Observation

- A target is a pid, a window id and an opaque epoch that names the window, its Space or virtual
  desktop, and its display. Any change of epoch invalidates every element ref issued under it.
- The first observation of a window is full. Later ones are diffs against the latest observation
  of the same lineage, with added, changed and removed refs; "removed" means not seen, because
  accessibility reads can miss nodes. GOAT's observation tracker
  (`packages/shared/src/computerUseObservation.ts`) assigns refs by tree position, so a ref keeps
  naming the same control while the driver's own tokens rotate, and gives a position a ref only
  when it is unambiguous all the way up. A full observation starts a new lineage and says why.
- A ref from an older lineage or epoch is refused with `staleElement` or `epochChanged`. The
  helper never guesses among several matches.
- `observe` with `screenshot: false` returns the tree without capturing pixels. Omitting the image
  from a response is not the same as not capturing it; the browser preview had that gap
  (`apps/server/src/mcp/toolkits/preview/tools.ts` `includeImage`).
- Points are pixels in the screenshot of the observation the action names, and refs and points are
  accepted only from the latest observation; points only when it carried a screenshot.
- While a secure field has focus, the observation is full and incomplete with no elements and no
  screenshot, and every ref, point and action is refused with `privateMode`.
- An observation made for the preview panel or a readiness check never counts as the agent's
  fresh observation; only the agent's own `observe` resets its stale state.

## Actions and results

- The methods, actions, keys, results and refusal reasons are defined once, in
  [computerUseProtocol.ts](../../packages/contracts/src/computerUseProtocol.ts) (#1207);
  readiness steps follow #1226. This page records the rules behind them, not the lists.
- Every action names an exact target, the observation it acts on and its delivery; there is no
  "frontmost window" default. Input means the same on every platform: keys by meaning and
  modifiers by role, translated by each helper.
- Background delivery comes first. Foreground delivery happens only when the request asks for it
  and the lease allows it; otherwise the action is refused.
- Each action is decided before dispatch: the helper picks one route (semantic, background
  synthetic, or foreground) and does not switch routes or windows after an unknown outcome.
- Results say whether the helper saw the effect. Input that never left is a refusal, never an
  outcome, and a missed deadline counts as unverifiable, not refused.
- No replay: input that may have landed is observed again, never resent; only a refusal that
  dispatched nothing for a transient reason is retried (`computerUseNextStep`).
- Refusals name their cause. A person's Stop and a person's input or takeover have their own
  reasons, and a policy refusal or a missing grant never uses them: a vendor helper that reports
  a policy refusal as "stopped by the user" makes agents end their turn (#1146). The mini-view
  stack below needs two reasons the contract does not have yet, for an unsafe capture and for
  unknown window bounds; WS7 adds them.

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
  `privateMode` refusals until it ends. Only the person's explicit action ends it.
- Ego Lite level for the browser means: a task space that groups an agent's tabs and keeps their
  login state together (profile policy shared, isolated per task, or incognito, each explained),
  a text-only snapshot, and a handoff in which a person finishes a step in the same tab and the
  agent resumes in the same task. Native windows reuse the handoff and snapshot semantics; task
  spaces stay a browser concept.
- Frames stream only to a viewer that is open, at a bounded rate, dropping frames instead of
  queueing them, and stop when nobody watches. Idle panels show the last frame. A preview frame is
  never fed to the model.

### Mini-view stack

Jun asked for this on 2026-10-24 (#1215, lead decision D11): the windows and pages agents operate
appear as small live tiles stacked on the right, the same way for computer use and the built-in
browser.

- One tile component renders any preview session, desktop window or browser page. Tiles stack
  vertically with the newest or active one on top, collapse, and expand into the full preview
  panel on click.
- Each tile shows the app or page title, the window or tab, the thread, the owner and status chip,
  and a live thumbnail, with `stop` (this session), `pause` and `resume`, and `takeover` or
  `handBack`. The stack header carries `stopAll`, the kill switch (#1209, #1134).
- `pause` uses the Stop boundary and keeps the session. The proxy refuses new calls, queued
  primitives are dropped, and the session's driver client is killed, because cancellation does
  not stop admitted `run_script` or `run_steps` work (ADR-0022). The helper releases held input
  and sends its cleanup report, results from the paused generation are discarded, and the
  interrupted action reports `partial` or `unverifiable`. The agent stays owner and the lease
  keeps running. `resume` checks that the lease is live, that a person has not taken over or
  entered private mode, and that cleanup was reported. It then starts a new driver client
  generation, and the agent must observe again before acting; nothing interrupted is replayed.
  Pause during a nested script, with held input, and around lease expiry are conformance cases.
- A tile in private mode shows a "Private — paused" placeholder and never pixels.
- The desktop app docks the stack on the right of the GOAT window by default. Pop-out moves it into
  a floating stack at the right edge of the screen: always on top, never activating, and passing
  clicks through everywhere except its controls, so a person can watch while working elsewhere.
- The floating stack and the helper's cursor overlay (#1214) never appear in a computer use
  capture and never cover the point an action targets; when an action lands under the stack, the
  stack moves or hides first. Window-only capture cannot include them. A crop of the window's
  bounds can, so each helper reports a typed exclusion capability: either its capture path
  excludes GOAT's own windows, or it hides them before each capture and confirms they are off
  screen before taking it. A helper that can do neither runs without the floating stack and
  overlay on that host, and a capture that would still include them, or a crop without known
  window bounds, is refused with a typed reason (`unsafeCapture`, `targetBoundsUnavailable`).
  Tiles never capture other tiles.
- Web and mobile show the same tiles in the existing right panel or a sheet, without a floating
  mode.
- A tile captures only the operated window where the platform helper can capture windows, and a
  crop of the window's bounds otherwise; never the full desktop by default. The helper's typed
  capability decides the route on macOS, Windows and Linux, and the tile says when it shows a crop.
- Thumbnails cost little: at most 2 frames per second while a tile is visible, none while it is
  collapsed or hidden or the app is in the background. They reuse the session's frame stream,
  are downscaled on the server, and nothing in the stack animates continuously.

## Built-in Computer Use skill

Jun asked for this on 2026-10-24 (#1230, lead decision D12): GOAT ships its own computer use
skill, on by default.

- The skill is GOAT's own text, written clean room. The Codex app's computer use skill is
  proprietary and Aside has none, so nothing is taken from either. It has an OS-neutral
  `SKILL.md` and one reference per platform (`references/macos.md`, `references/windows.md`,
  `references/linux.md`).
- It teaches the behavior this page defines: observe, act, verify; typed results and no blind
  retry (`computerUseNextStep`); private mode and handing a step to the person; takeover and
  hand-back; Stop; and that the person watches the run in the mini-view stack
  ([Mini-view stack](#mini-view-stack)).
- It lives in a built-in skills registry with scope `builtin` and is enabled by default. It
  attaches under exactly the gate that attaches computer use today: never in Plan, a read-only
  sandbox, a cloud task or Muse (`apps/server/src/cua/ComputerUseAttachment.ts`). It appears in the
  composer's `$` menu and in Settings → Integrations → Computer use, where a person turns it off.
- Every adapter receives it through the runtime instructions path; an adapter whose provider
  reads skills natively also gets it from a GOAT-managed read-only directory. It replaces the
  one-paragraph `COMPUTER_USE_INSTRUCTIONS`
  (`packages/provider-core/src/server/runtimeInstructions.ts`), so there is one source of
  computer use guidance.

## Composer mentions

Jun asked for this on 2026-10-24 (lead decision D13): computer use and browser use are invoked
by mention, the way the Codex app does it. Only the pattern is taken.

- Typing `@` in the composer on web, desktop and mobile offers "Computer" and "Browser" entries
  in the mention popover; picking one inserts a chip.
- A chip turns on that capability for that turn only: its tools (computer use through the
  session proxy and lease path, or the built-in browser preview tools), its built-in skill
  ([Built-in Computer Use skill](#built-in-computer-use-skill)), and the preview mini-view
  ([Mini-view stack](#mini-view-stack)). Without a chip, settings and defaults decide as before.
- An entry for a capability that is not ready says why, from the readiness answers (#1226), and
  links to onboarding; a chip is never silently ignored.
- Mentions are a typed part of the turn input in `packages/contracts`, so every client sends the
  same shape, and providers receive the capability through the same runtime instructions and
  tool attachment path. Agents and MCP set the same per-turn capability through the same service
  method; nothing lives only in the composer.

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
  session. Results from before the epoch are discarded, element refs from before it are stale, and
  the session moves to `paused`. Resuming needs an unlocked session, a lease that is still live or
  a person's hand-back, and then a fresh observation.
- **Limits.** Interactive threads on one desktop still share the person's session; GOAT serializes
  input per target and pauses on collision, and does not promise separate seats. Operating a
  locked screen is out of scope.

## Permission onboarding

- **macOS.** First run asks for Accessibility and Screen Recording for "GOAT Computer Use", not for
  GOAT. Readiness is proven, not inferred from switches: the helper's grant probe, then a fresh
  driver under the helper that reports the helper's bundle identity and service pid, reads a
  non-empty accessibility tree and captures a non-blank window. The desktop verify
  (`apps/desktop/src/cua/DesktopCuaDriver.ts`) already does this when a helper is present. The
  permission guide should drag the helper bundle into System Settings;
  `apps/desktop/src/permissions/MacPermissionHelper.ts` still drags GOAT.app.
- **Guided macOS grant** (lead decision D14, Jun's highest priority). Onboarding walks two steps,
  Accessibility, then Screen & System Audio Recording. Each step opens the exact System Settings
  pane and places a small always-on-top guide panel next to it that shows the helper's real app
  icon as a drag source for the list, with the toggle instruction and a "Reveal in Finder"
  keyboard fallback. Each step turns to success from the helper's own readiness, checked in a
  fresh helper process because TCC answers are cached per process (#1226); when macOS needs the
  helper restarted, the step says so and offers to quit and reopen it.
- **Troubleshooting** covers stale or duplicate entries from old builds or paths, the wrong app
  toggled (GOAT.app or Terminal instead of the helper), and development builds that need a new
  grant after each rebuild. `tccutil reset` appears only as text a person can run; GOAT never runs
  it and never edits the TCC database. The panel follows light and dark, is accessible, and does
  not animate continuously. Windows and Linux use the same step structure in the shared
  onboarding component (WS8, #1136).
- **Migration.** A person who granted GOAT.app under ADR-0022 sees one prompt explaining that
  computer use now has its own app and grants again. GOAT never removes or resets grants. The
  prompt also says that the old GOAT entries stay on, that only SnapShot still needs them, and
  that while they are on, processes GOAT starts can use them; it opens the System Settings pane so
  a person who does not use SnapShot can turn them off.
- **Usage strings.** The helper's `Info.plist` carries the Accessibility, Screen Recording and
  Apple Events usage descriptions. GOAT.app has the Screen Recording one today and lacks the
  other two (#1175).
- **Development builds.** Ad-hoc signatures change the code hash on every build, and TCC keys
  grants to it, so a rebuilt development helper asks again. Sign development helpers with a stable
  local certificate to avoid it; builds never run `tccutil reset`.
- **Windows.** No OS grant. Readiness needs an interactive session (Session 0 over SSH or a
  service is `unavailable`), a non-empty UI Automation tree and a non-blank Windows Graphics
  Capture frame. Elevated windows are out of reach of a non-elevated helper; they return
  `targetRefused` and the helper is never elevated to reach them.
  Agents reach Cua Driver through the helper's MCP relay, because the driver copies the window's
  rectangle off the screen when Windows Graphics Capture fails and does not say so: the relay
  replaces a covered window's screenshot with its own PrintWindow capture of that window, or
  withholds it (#1329).
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
- panic containment and host-pid liveness polling in the driver process on Unix;
- a settle wait driven by accessibility notifications, text range selection, and append for
  `setValue` (the protocol carries `append`; settle and selection join it only when a workstream adds them);
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
- The built-in skill is GOAT's own text; no wording comes from the Codex app's proprietary skill.
- Aside, the Codex app and Ego Lite's browser are proprietary. GOAT takes their product patterns
  (a separate helper identity, per-app approval, typed refusals, handoff) and writes its own code;
  nothing from their binaries, keys, names or reverse-engineered sources enters the repository,
  test fixtures included (#1161). Ego Lite's public harness is MIT and is used only as a naming
  and behavior reference.
- Research behind this design lives outside the repository (notes L1–L5 and R1–R4 for the epic,
  a static analysis of the Codex computer use build 26.1016.51333, and a live probe of the Codex
  baseline). It is cited by name only.

## Cross-platform parity

One protocol, three helpers. The method rows are the #1207 method list: a helper's
`capabilities` must name every method as supported or unsupported, and an unsupported method answers
with an `unsupported` refusal naming the method and platform. The behavior rows are what every
helper does around those methods, each reported through a typed capability or refusal.

| Protocol method                                            | macOS                 | Windows              | Linux X11          | Linux Wayland                                                         |
| ---------------------------------------------------------- | --------------------- | -------------------- | ------------------ | --------------------------------------------------------------------- |
| `capabilities` (and the hello)                             | yes                   | yes                  | yes                | yes                                                                   |
| `permissions`                                              | TCC state             | UI Automation access | AT-SPI and display | portal consent state                                                  |
| `listWindows`                                              | yes                   | yes                  | yes                | compositor dependent, else `unsupported`                              |
| `observe` full and diff (diffs computed by GOAT's tracker) | yes                   | yes                  | yes                | where the target can be captured; else tree only, `degraded` says why |
| `observe` with `screenshot: false`                         | yes                   | yes                  | yes                | yes                                                                   |
| `click`, `doubleClick`, `rightClick`, `drag`, `scroll`     | yes                   | yes                  | yes                | foreground under a lease only                                         |
| `typeText`, `pressKey`                                     | yes                   | yes                  | yes                | foreground under a lease only                                         |
| `setValue`, `performAction`                                | AX values and actions | UIA patterns         | AT-SPI             | AT-SPI                                                                |

| Helper behavior                                                                                                             | macOS                                 | Windows                                  | Linux X11                                                                  | Linux Wayland                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| readiness: real tree and non-blank capture                                                                                  | yes                                   | yes                                      | yes                                                                        | after portal consent where the compositor supports discovery and capture |
| background delivery (`backgroundDelivery`)                                                                                  | yes                                   | partial; else `backgroundUnavailable`    | with Xorg hotplug and writable `/dev/uinput`; else `backgroundUnavailable` | `backgroundUnavailable`                                                  |
| stale refs refused (`staleElement`, `epochChanged`)                                                                         | yes                                   | yes                                      | yes                                                                        | yes                                                                      |
| private mode (`privateMode`)                                                                                                | `AXSecureTextField`                   | `IsPassword`                             | AT-SPI password role                                                       | AT-SPI password role                                                     |
| end session: kill the driver process, release held input, cleanup report                                                    | yes                                   | yes                                      | yes                                                                        | yes                                                                      |
| lock, sleep and session switch (`screenLocked`)                                                                             | yes                                   | session change notifications             | logind and screensaver signals                                             | logind and screensaver signals                                           |
| human input collision (`userIntervened`)                                                                                    | HID idle time                         | last-input time, own input filtered      | X idle time                                                                | not detectable; exclusive lease                                          |
| physical kill switch                                                                                                        | Escape tap (optional grant)           | low-level keyboard hook                  | XInput2 raw keys                                                           | none; Stop controls only                                                 |
| agent cursor overlay drawn by the helper (#1214)                                                                            | yes                                   | yes                                      | yes                                                                        | compositor dependent                                                     |
| window-only capture for tiles                                                                                               | yes                                   | yes                                      | yes                                                                        | where the portal grants a window; else crop of the window's bounds       |
| GOAT's own windows kept out of captures                                                                                     | capture filter, else hide and confirm | capture exclusion, else hide and confirm | hide and confirm, else docked only                                         | window capture only, else docked only                                    |
| preview frames                                                                                                              | yes                                   | yes                                      | yes                                                                        | through the portal screen cast where granted; else last observation only |
| preview controls (`takeover`, `handBack`, `requestHandoff`, `pause`, `resume`, `stop`, `stopAll`), onboarding, panel, chips | same                                  | same                                     | same                                                                       | same                                                                     |

Tests enforce it: `ComputerUseCapabilities` fails to decode unless every method is named, and a
conformance suite runs the same fixture requests against each platform helper, failing when a
method is missing, a refusal is untyped, or a behavior row is not reported. The client tests
render the same panel state for each platform.

## Qualification

Evidence is kept by tier, and a lower tier never stands in for a higher one: docs and static
review, unit and contract tests, the control plane without input, GOAT-owned fixture apps, the
real gateway with providers, and a signed packaged app on a real OS and display.

- **Fixture apps.** A GOAT-owned fixture per platform with known trees, a secure field, a modal,
  drag targets and counters that record what it received. Negative cases: wrong pid or window,
  stale ids, an epoch change, Stop while queued, held modifiers during a kill, helper death, lost
  listener, a Stop of one thread while a sibling acts, and lock or sleep during a held drag and
  during typing, pause and resume during a nested script, and a crop capture while the floating
  stack or cursor overlay sits inside the window's bounds.
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

| Phase | Workstream                                       | Depends on      | Phase is done when                                                                                                 |
| ----- | ------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| P0    | WS1 #1127 transcript fidelity and run card       | —               | model and timeline see the same screenshot for every provider fixture; run card on web and mobile                  |
| P1    | WS2 #1128 this design and the protocol contracts | —               | ADR merged; preview session and helper protocol schemas in `packages/contracts` with the parity list               |
| P2    | WS3 #1129 macOS helper core                      | WS2             | signed helper launches, disclaims, starts the driver, passes readiness, observes with diffs                        |
| P2    | WS4 #1131 packaging, signing, notarization       | WS3             | notarized GOAT.app with the helper; grants survive an update; notices complete                                     |
| P3    | WS5 #1133 action API                             | WS3             | typed results, no replay, exact targets, background first, on fixtures                                             |
| P3    | WS6 #1134 safety rails                           | WS3, WS5        | every turn through the proxy; Stop and stop all with cleanup report; takeover, private mode, collision             |
| P4    | WS7 #1135 unified preview surface                | WS2, WS6        | one panel, chips and controls for browser and desktop on web, desktop and mobile                                   |
| P4    | WS8 #1136 onboarding parity and matrix tests     | WS3, WS7        | onboarding on the helper identity; conformance suite enforces the matrix                                           |
| P5    | WS9 #1137 Windows helper                         | WS2, WS5, WS6   | conformance suite green on Windows; unsupported cells typed                                                        |
| P5    | WS10 #1138 Linux helper                          | WS2, WS5, WS6   | conformance suite green on X11 and Wayland; unsupported cells typed                                                |
| P4    | WS12 #1230 built-in computer use skill           | WS1, WS6, WS7   | skill in the builtin registry replaces the runtime paragraph for every adapter; real-task evidence on a ready host |
| P6    | WS11 #1139 qualification and visual verification | runs throughout | hard gates met on a signed packaged build per platform; latency within budget                                      |
