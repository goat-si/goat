# ADR-0023 — decision recorded under "Computer use host"

- Contract owner: [desktop.md](../desktop.md#computer-use-host)
- Commit: `276d781642` in #1184, with review follow-ups on the same branch, recorded before
  implementation. The commit messages record the documents only. The decision is Jun's of
  2026-10-24 (the lead decisions for epic #1140, workstream #1128); the alternatives and reasons
  come from the epic's research notes, which live outside the repository.
- Amends: [ADR-0022](ADR-0022-cua-driver-computer-use.md). Its "Identity" bullet (the Electron
  process owns the driver and macOS grants land on `si.goat.desktop`) and its note that the
  Electron host is ported separately are superseded here. The pin, telemetry opt-outs, capability
  manifest, unattended origins, admission lease, transport kill boundary and display probe in
  ADR-0022 still stand.
- Design: [computer-use.md](../../docs/internals/computer-use.md)
- Amended 2026-10-25, D7 (owner decision, Jun, 2026-10-25; kept in
  [#1550](https://github.com/goat-si/goat/pull/1550) at `6eb17f5764`): a person's keyboard and
  pointer input no longer pauses an agent with approved control, unattended attachment requires
  private-mode detection but not human-input detection, and human-input detection remains for
  input arbitration and reports only. The Safety bullet below states the amended decision.
- Amended 2026-10-28, D7 and D16 (owner decision, Jun, 2026-10-28): no detection signal gates
  admission, so unattended work no longer needs private-mode detection, and in full access a
  thread launched from another environment, and turns it launches or sends here, use every app like a
  person's threads instead of holding the screen alone. They stay unattended for steering and
  outside full access. The Safety bullet and D16 below state the amended decision.
- Amended 2026-10-25, D15 (Jun, 2026-10-25; #1594, tracking #1595): GOAT builds Cua Driver from
  its own fork, [goat-si/cua-driver](https://github.com/goat-si/cua-driver), instead of
  downloading upstream release binaries. The Engine and Driver fork bullets below state the
  decision; GOAT pins the fork's `cua-driver-rs-v0.37.0-goat.2` archives since #1591.
- Amended 2026-10-25, D16 (owner decision, Jun, 2026-10-25 18:15 KST, corrected 18:17; #1617,
  #1396): every run in full-access runtime mode uses apps without per-app approval, whoever or
  whatever started it, whatever `cuaFullAccessAutoAdmit` says. This replaces #1396's
  off-by-default behavior. The Readiness and approvals bullet below states the decision; #1649
  implements it.
- Amended 2026-10-26, D17 (owner decision, Jun, 2026-10-26; recorded in `6c428224d6`):
  agents get one screen code tool that runs a bounded
  JavaScript cell against built-in browser tabs and desktop apps. The owner bundles it as
  validated by code mode already shipping in the Codex app, so it does not wait for the
  agent-surface D8 measurement gate for a general `goat_eval`; D8's paired protocol is kept as a
  post-ship regression check. The cursor's bounded thinking motion is an owner exception to
  GOAT's rule against continuously repainting animation. The Screen code mode bullet below
  states the decision.
  BEH-29's yield-on-human-input rule was considered and rejected in favor of D7.
- Related: [ADR-0004](ADR-0004-electron-shell.md), [ADR-0014](ADR-0014-desktop-runtime-identity.md)

## Decision record

- **Purpose.** Computer use in GOAT should work as one product on every machine and screen: the
  person grants it once to an app named for it, sees what the agent sees, takes over and hands
  back, and stops any thread or all of them at once. Agents should get the same observation and
  action contract on macOS, Windows and Linux, and the screenshot a model saw should be the one the
  person sees in the transcript.
- **Before.**
  - ADR-0022 ships Cua Driver 0.37.0 hosted by the Electron main process on desktop and by the
    server itself elsewhere. On macOS, Accessibility and Screen Recording are granted to GOAT.app,
    so processes GOAT starts without disclaiming responsibility, provider CLIs and their shells
    included, can run under those grants.
  - A standalone server on macOS starts the driver with `--embedded --host-bundle-id si.goat.server`
    from a parent that is not an app bundle, so the identity check fails and the grant lands on the
    terminal that started the server (#1174).
  - Interactive turns attach `cua-driver mcp` directly; only unattended turns run through the lease
    proxy, so a thread Stop cannot kill an interactive turn's transport
    (`apps/server/src/cua/ComputerUseAttachment.ts`).
  - Codex and Claude adapters keep `structuredContent` and drop the MCP `content` that carries the
    screenshot (#1127), and the Codex harness gives the model only the structured JSON when both are
    present (#1154).
  - Native computer use and the built-in browser preview have separate ownership models, status and
    controls (`packages/contracts/src/previewAutomation.ts`, `packages/contracts/src/cua.ts`).
- **Alternatives.**
  - Keep the driver in the Electron process. Grants stay on all of GOAT, the System Settings entry
    reads "GOAT" with no hint of what it allows, and a standalone server has no app identity.
  - Put the `cua-driver` executable in an app bundle of its own and start it without `--embedded`.
    Pinned 0.37.0 then requires its path to contain `/CuaDriver.app/Contents/MacOS/` and its bundle
    id to be `com.trycua.driver`, so its health report fails under any GOAT name.
  - Have Electron spawn the driver with responsibility disclaimed. In embedded mode the driver checks
    that its parent process carries the host bundle id, and that parent would still be GOAT.app.
  - Write a native engine from scratch in Swift or Rust. It repeats the accessibility, capture,
    background input and focus work the MIT driver already does on three platforms, and must call
    the same private macOS SkyLight interfaces without upstream's fixes for them. The closest prior
    art, synara's fork, carries one cumulative driver patch of about 25,000 lines whose revisions
    repeat each other's diffs, and much of it is already in upstream 0.36–0.38.
  - Carry synara's patch whole. Rebasing it onto 0.37 means resolving conflicts with code upstream
    already absorbed, and it brings Cua browser tools GOAT does not ship.
  - Reuse a vendor helper (the Codex or Aside computer use service). They are proprietary, signed
    by their vendor, and keep the grant under the vendor's name.
  - Launch the helper through LaunchServices and connect over a per-user socket, as the Codex app
    does. It avoids the private disclaim interface but needs a listener, peer verification on
    every connect and its own lifetime management. It is kept as the fallback if a macOS release
    breaks the disclaim interface.
  - Keep downloading upstream's release binaries (D15). A driver bug that blocks GOAT then waits
    for an upstream release, upstream moves several times a day (0.38.0 is already out), and GOAT
    ships bytes it cannot rebuild from source it has reviewed.
  - Vendor the driver under `third_party/` in this repository (D15). Its Rust workspace of 642
    crates would put a Rust toolchain into every pull request's CI, fight the repository's lint
    and code-budget tooling, and mix two release cadences.
- **Decision.**
  - **Helper app per OS.** GOAT Computer Use is a separate signed native helper with its own
    identity, signing, notarization and version. On macOS it is "GOAT Computer Use.app",
    `LSUIElement`, bundle id `si.goat.desktop.computer-use` (nightly
    `si.goat.desktop.nightly.computer-use`, development `si.goat.desktop.dev.computer-use`),
    embedded in GOAT.app under `Contents/Helpers/` and launched by the desktop host. Windows (UI
    Automation) and Linux (AT-SPI, X11 and the Wayland portals) get helpers of their own behind the
    same protocol.
  - **Engine.** Cua Driver (MIT, at the 0.37.0 protocol, built from GOAT's fork; see Driver fork)
    runs as a child of the helper. The macOS helper disclaims responsibility at its own start, so
    it becomes the TCC
    principal whoever launched it, then spawns
    `cua-driver mcp --direct --embedded --host-bundle-id <helper bundle id>`: one stdio process per
    session that owns the driver runtime and listens on no socket, inherits the helper's grants and
    passes the driver's identity check unpatched (D3 amendment, #1210). Each agent connection's
    proxy starts its own helper with `--mcp` for that driver, and Stop ends the pair (D3 amendment
    2); the desktop's readiness check starts its own helper with `--mcp` the same way. Direct mode has no driver cursor overlay, so the helper draws
    the agent cursor itself (#1214). GOAT behavior lives in the helper and in small, separate
    driver changes in the fork with recorded provenance, never in a rewritten driver.
  - **Driver fork (D15).** `goat-si/cua-driver` is a `git subtree split` of trycua/cua
    `libs/cua-driver` that keeps upstream history: the `upstream` branch holds only upstream splits
    (`upstream-v0.37.0` is the split of `cua-driver-rs-v0.37.0`, `2d2f99228d`), `main` adds GOAT's
    changes through pull requests, and releases are tagged `cua-driver-rs-v0.37.0-goat.N`. Its
    artifacts are unsigned; GOAT signs the driver in its helper build, so the helper's identity
    and people's grants do not change. GOAT consumes the fork through the same pin-and-verify path
    it uses today, so switching is a pin change (#1591). When the driver has a problem, GOAT does
    not work around it: the fix goes into the fork, the same fix goes upstream as a pull request,
    and the problem is reported upstream. Upstream is synced on purpose, not tracked: split the
    new range onto `upstream`, review the diff for security and behavior, merge into `main` with
    `cargo deny`, pass the 0.37.0 protocol-compatibility test and one live check per OS, then tag
    and bump GOAT's pin.
  - **Channel.** The desktop's helper talks to its launcher over line-delimited JSON on stdio for
    readiness, app listing and watches; an agent connection's helper passes MCP straight between
    its launcher and the driver. A release helper serves only a parent
    signed by GOAT's team with the GOAT app identifier, and its service half only its own
    launcher; any socket, as in the fallback, adds a per-launch token and an audit-token peer
    check. The hello negotiates `clientApiVersion` and `serverApiVersion`, every request has a
    deadline, and replies are bound to the helper's executable, pid and generation, so late
    replies after a Stop are quarantined. Agents reach the helper only through GOAT's MCP surface. Every MCP result
    puts screenshots in `content` image blocks; `structuredContent` never carries image payloads,
    and screenshots keep their request, generation and destination thread through to the
    transcript.
  - **Observation.** Window-scoped screenshot plus accessibility tree. The first observation is
    full; later ones are diffs keyed by element refs that survive re-reads. A target is PID,
    window id and an epoch naming the window, its Space and display; a new epoch invalidates refs,
    and a stale ref is refused with `staleElement` or `epochChanged`.
  - **Actions.** Click, type, scroll, drag, key, set value and semantic accessibility actions on an
    exact PID and window, background delivery first, foreground only under a lease that allows it.
    Results are typed `confirmed`, `partial`, `unverifiable`, `suspected_noop` or
    a typed refusal; partial and unverifiable results are never replayed automatically, and a
    refusal never claims the user stopped it (#1146). Stops and refusals name their cause: the
    user stopped, the user intervened, the screen locked, a missing or pending permission, an app
    not approved, a blocked URL, an incompatible client, or a named policy.
  - **Readiness and approvals.** Readiness is four answers shown separately: OS grant, an
    authenticated helper, a real capture and tree, and tools available to the model. Apps are
    approved from a card for a span the agent asks for, 5 to 120 minutes, and each call on an
    app's windows is checked against the approved apps before it runs. No approval is standing: a person ends one
    early from its card, and after it expires the thread asks again (owner decision, Jun,
    2026-10-27; an "Always allow" choice with a Settings list was considered and not built).
    A run in full-access runtime mode needs no per-app approval, whether a person, an automation,
    a schedule, a webhook, Slack or another channel started it, because choosing full access for a
    thread already gives that trust (D16). The "Full access without approval" switch is gone from
    Settings and settings search on web and mobile; the `cuaFullAccessAutoAdmit` field stays in
    the settings contract so older clients and settings files still decode, and the server ignores
    it. What differs by origin stays: only a person's run takes the foreground without asking,
    while unattended work asks for it and holds the screen one thread at a time. A full access
    turn launched from another environment is the exception: it works beside other threads
    (amended 2026-10-28). The
    password-manager exclusions, pause, Stop and stop all, each
    call's scope, and the screen-sharing, reservation and foreground checks apply to every run;
    the physical kill switch is not implemented yet (#1505). Runs in other runtime modes keep the
    approval flow. Owner decision (Jun, 2026-10-25), implemented in #1649 after #1617; it replaces
    #1396's off-by-default setting.
  - **One preview surface.** Native computer use and built-in browser use share one preview session
    contract (owner `agent`, `human` or `private`; status; target; lease; last frame) with the same
    controls (take over, hand back, request handoff, stop, stop all), status chips and private mode
    on web, desktop and mobile.
  - **Mini-view stack.** Every preview session, computer use window or browser page, appears as a
    tile in one vertical stack on the right: docked in the desktop app by default, poppable into
    a floating, non-activating stack at the screen edge, and in the right panel or a sheet on web
    and mobile. Tiles carry the session's chips and controls, plus pause and resume, and the
    stack header has stop all. Pause uses the Stop boundary but keeps the owner and lease, and
    resume needs a live lease and a fresh observation. Private tiles show a placeholder, never
    pixels. Tiles capture only the operated window, or a crop of its bounds where window capture
    is unavailable, the same on every OS. Thumbnails run at most 2 frames per second and only
    while visible. The floating stack and the cursor overlay never appear in a capture and never
    cover an action's target; a helper that cannot keep them out runs without them, and an unsafe
    capture is refused with a typed reason. Requested by Jun on 2026-10-24 (#1215).
  - **Built-in skill.** GOAT ships its own computer use skill, written clean room, as an OS-neutral
    `SKILL.md` with one reference per platform. It sits in a built-in skills registry (scope
    `builtin`), is on by default and attaches under the same gate as computer use (never in Plan,
    a read-only sandbox, a cloud task or Muse). It is listed in the composer's `$` menu and in
    Settings → Integrations → Computer use, where it can be turned off. Every adapter gets it
    through the runtime instructions path, and providers that read skills natively also from a
    GOAT-managed read-only directory. It replaces `COMPUTER_USE_INSTRUCTIONS` as the single source
    of computer use guidance and teaches the observe-act-verify loop, typed results, private mode,
    takeover, Stop and the mini-view stack. Requested by Jun on 2026-10-24 (#1230).
  - **Mentions.** `@computer` and `@browser` chips in the composer turn on that capability's tools,
    built-in skill and mini-view for one turn. They are a typed part of the turn input in the
    contracts, agents and MCP set the same per-turn capability through the same service method,
    and an unavailable capability shows its readiness reason with a link to onboarding.
    Requested by Jun on 2026-10-24 (lead decision D13).
  - **Guided macOS grant.** Onboarding grants Accessibility, then Screen & System Audio Recording,
    each from the exact System Settings pane with a floating guide panel whose helper icon is a
    drag source, a Reveal in Finder fallback, readiness checked in a fresh helper process, restart
    handling, and troubleshooting for stale entries and the wrong app. GOAT never runs
    `tccutil reset` or edits the TCC database. Windows and Linux follow the same steps. Requested
    by Jun on 2026-10-24 (lead decision D14).
  - **Safety.** Per-app approvals (except full-access runs, D16) and a time-bounded control
    lease. Unattended origins keep the
    ADR-0022 driver ceiling. Interactive turns also run through the GOAT proxy, so a per-thread
    Stop and the global kill switch end the transport at once. An agent with approved control
    keeps working while a person uses the same desktop; the person's keyboard and pointer input
    is not a pause condition. Stop, stop all, takeover and hand-back, lease expiry and the
    private-field pause still stop or pause it. No detection signal gates attachment, for
    unattended work either (2026-10-28). Human-input detection
    (#1426, #1477, #1504, #1512) remains for input arbitration and reports; it is neither an
    admission gate nor a pause condition. Owner decision (Jun, 2026-10-25), #1550.
  - **Screen code mode (D17).** One agent tool runs a short JavaScript cell in a QuickJS
    WebAssembly guest, in a child process the GOAT server starts per active turn, with no file,
    network, process or credential access. The cell reaches browser tabs and desktop apps only
    through host calls, and every call passes the same check a direct call passes: preview owner,
    generation and private mode for a tab, and the lease proxy's scope, reservation and quarantine
    for an app. Cua Driver is not changed and its `run_script`, `run_steps` and browser tools stay
    excluded. Stop, pause, private mode and turn end fence new calls and kill the guest; a call that
    may already have reached an app is reported as an unknown outcome and never replayed. A person's
    input still does not pause approved control (D7); a code-mode-only refusal of desktop input to
    browser windows is not added, so the cell keeps parity with direct calls, and an origin-aware
    rule shared by both is a follow-up. The agent cursor may show a short "thinking" motion while a
    cell is live, under five rules: it restarts only on a host call or action, stops by itself
    within five seconds, stops at idle hide or turn end, is off under reduced motion, and is hidden
    before every capture. An idle cursor stays still; no hovering or "levitation" motion is
    adopted. Native cursor motion on Windows and Linux is a follow-up. Owner decision (Jun,
    2026-10-26).
  - **Parity.** Every platform implements every protocol method or returns a typed `unsupported`;
    tests enforce the matrix in the design doc.
  - **Packaging and updates.** Inner executables are signed first, then the helper, then GOAT.app,
    and builds never reset TCC. The copy in GOAT.app seeds an installed helper that updates on its
    own as a signed, notarized artifact, switched one generation at a time after its signature and
    protocol version are checked. Signing in CI is a separate proposal for maintainers; this epic
    adds local scripts only.
- **Reasons.**
  - A separate identity is the only way the grant can name what it allows and survive GOAT updates
    under a stable designated requirement, and it means computer use no longer needs any grant on
    GOAT.app. Aside and the Codex app ship the same shape.
  - Disclaiming in the helper and spawning the driver embedded is the one arrangement pinned 0.37.0
    accepts without patching its identity checks. A standalone server on a Mac has no GOAT app at
    the top of its launch chain, so it reports computer use unavailable instead of granting a
    terminal (#1174).
  - Running the driver in direct mode behind the helper's stdio leaves nothing for another process
    to connect to, which closes the same-user socket gap ADR-0022 recorded without a driver patch;
    the cost is the driver's cursor overlay, which the helper replaces.
  - Small reviewed changes merge; one cumulative patch does not. The deltas GOAT needs that
    upstream lacks (batched accessibility reads, input cancellation with held-input release, host
    liveness, settle waits, text selection, a wider keymap) are each tens to a few hundred lines.
  - Building from a fork lets GOAT fix a blocking driver bug on its own schedule and makes the
    driver reproducible from source GOAT reviewed, while sending each fix upstream keeps the fork
    close to upstream (D15).
  - One preview contract lets a person read the same chips and press the same buttons whichever
    surface the agent uses and whichever client they hold.
- **Tradeoffs.**
  - The first run after the change asks for macOS grants again, under the new name; grants on
    GOAT.app no longer enable computer use.
  - The helper does not revoke grants already on GOAT.app, and SnapShot still asks GOAT.app for
    Screen Recording and Accessibility. While GOAT.app holds them, processes it starts without
    disclaiming responsibility, provider CLIs included, can still use them. Isolating those
    processes is separate work (#1208).
  - Ad-hoc signed development builds change their code hash on every build, so TCC asks again after
    each rebuild. That is expected in development and documented, not worked around with
    `tccutil reset`.
  - Each platform helper is one more signed artifact to build, notarize and qualify.
  - The helper trusts a parent that carries GOAT's signature, and GOAT's executable can run as
    plain Node, so a same-user process can pass that check until GOAT's run-as-Node fuses are off
    and its backend runs from a separately identified runtime (#1210). Signed helper builds stay
    blocked until then (#1202).
  - Background input and private mode depend on what each platform exposes. Wayland has no
    background input path, so foreground actions there need an exclusive lease.
  - The fork is GOAT's to maintain (D15): a Rust toolchain and builds for three operating systems;
    a security and behavior review of every upstream range taken, never blind tracking; the
    supply chain (the fork's CI, artifact attestations, `cargo deny` and the license audit, #1589);
    and the 0.37.0 protocol, which the helper and the `@trycua/cua-driver` SDK depend on, so any
    protocol change needs its own decision. The fork keeps upstream's MIT license and copyright,
    uses the Cua Driver name only to say where the code comes from, and GOAT never presents its
    builds as official upstream releases.
