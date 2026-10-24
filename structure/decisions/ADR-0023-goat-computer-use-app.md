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
- **Decision.**
  - **Helper app per OS.** GOAT Computer Use is a separate signed native helper with its own
    identity, signing, notarization and version. On macOS it is "GOAT Computer Use.app",
    `LSUIElement`, bundle id `si.goat.desktop.computer-use` (nightly
    `si.goat.desktop.nightly.computer-use`, development `si.goat.desktop.dev.computer-use`),
    embedded in GOAT.app under `Contents/Helpers/` and launched by the desktop host. Windows (UI
    Automation) and Linux (AT-SPI, X11 and the Wayland portals) get helpers of their own behind the
    same protocol.
  - **Engine.** Cua Driver (MIT, pinned 0.37.0; 0.38.0 is evaluated separately) runs as a child of
    the helper. The macOS helper disclaims responsibility at its own start, so it becomes the TCC
    principal whoever launched it, then spawns
    `cua-driver mcp --direct --embedded --host-bundle-id <helper bundle id>`: one stdio process per
    session that owns the driver runtime and listens on no socket, inherits the helper's grants and
    passes the driver's identity check unpatched (D3 amendment, #1210). Each agent connection's
    proxy starts its own helper with `--mcp` for that driver, and Stop ends the pair (D3 amendment
    2); only the desktop's readiness check still runs `serve --embedded` on a private socket. Direct mode has no driver cursor overlay, so the helper draws
    the agent cursor itself (#1214). GOAT behavior lives in the helper and in small, separate
    driver patches with recorded provenance, never in a rewritten driver.
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
    approved for a conversation or always from a card, the approved target is frozen before the
    action runs, and always-allowed apps can be removed in Settings.
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
  - **Safety.** Per-app approvals and a time-bounded control lease. Unattended origins keep the
    ADR-0022 driver ceiling. Interactive turns also run through the GOAT proxy, so a per-thread
    Stop and the global kill switch end the transport at once. Human input on a shared desktop
    pauses the agent and marks it waiting for the person.
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
  - Small patches rebase; a cumulative fork does not. The deltas GOAT needs that upstream lacks
    (batched accessibility reads, input cancellation with held-input release, host liveness,
    settle waits, text selection, a wider keymap) are each tens to a few hundred lines.
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
