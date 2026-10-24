# ADR-0023 — decision recorded under "Computer use host"

- Contract owner: [desktop.md](../desktop.md#computer-use-host)
- Commit: pending on branch gcu/adr-goat-computer-use (recorded before implementation; decided by
  Jun on 2026-10-24 for the GOAT Computer Use epic, goat-si/goat#1140, workstream #1128)
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
    `cua-driver serve --embedded --host-bundle-id <helper bundle id>`, which inherits the helper's
    grants and passes the driver's identity check unpatched. GOAT behavior lives in the helper and
    in small, separate driver patches with recorded provenance, never in a rewritten driver.
  - **Channel.** The helper talks to its launcher over an authenticated local channel: NDJSON over
    stdio pipes when spawned, a per-launch random token plus peer process and code-signature checks
    for any socket. Agents reach the helper only through GOAT's MCP surface. Every MCP result puts
    screenshots in `content` image blocks; `structuredContent` never carries image payloads.
  - **Observation.** Window-scoped screenshot plus accessibility tree. The first observation is
    full; later ones are diffs keyed by stable element ids. A target is PID, window id and
    Space/display epoch; a new epoch invalidates ids, and a stale id is a typed `stale_element`
    error.
  - **Actions.** Click, type, scroll, drag, key, set value and semantic accessibility actions on an
    exact PID and window, background delivery first, foreground only under a lease that allows it.
    Results are typed `confirmed`, `partial`, `unverifiable`, `suspected_noop` or
    `refused(reason)`; partial and unverifiable results are never replayed automatically, and a
    refusal never claims the user stopped it (#1146).
  - **One preview surface.** Native computer use and built-in browser use share one preview session
    contract (owner `agent`, `human` or `private`; status; target; lease; last frame) with the same
    controls (take over, hand back, request handoff, stop, stop all), status chips and private mode
    on web, desktop and mobile.
  - **Safety.** Per-app approvals and a time-bounded control lease. Unattended origins keep the
    ADR-0022 driver ceiling. Interactive turns also run through the GOAT proxy, so a per-thread
    Stop and the global kill switch end the transport at once. Human input on a shared desktop
    pauses the agent and marks it waiting for the person.
  - **Parity.** Every platform implements every protocol method or returns a typed `unsupported`;
    tests enforce the matrix in the design doc.
  - **Packaging.** Inner executables are signed first, then the helper, then GOAT.app, and builds
    never reset TCC. Signing in CI is a separate proposal for maintainers; this epic adds local
    scripts only.
- **Reasons.**
  - A separate identity is the only way the grant can name what it allows, survive GOAT updates
    under a stable designated requirement, and stay off the provider processes GOAT starts. Aside
    and the Codex app ship the same shape.
  - Disclaiming in the helper and spawning the driver embedded is the one arrangement pinned 0.37.0
    accepts without patching its identity checks. It also gives standalone servers on macOS an app
    identity to launch, which removes #1174 by construction.
  - Small patches rebase; a cumulative fork does not. The deltas GOAT needs that upstream lacks
    (batched accessibility reads, input cancellation with held-input release, host liveness,
    settle waits, text selection, a wider keymap) are each tens to a few hundred lines.
  - One preview contract lets a person read the same chips and press the same buttons whichever
    surface the agent uses and whichever client they hold.
- **Tradeoffs.**
  - The first run after the change asks for macOS grants again, under the new name; grants on
    GOAT.app no longer enable computer use.
  - Ad-hoc signed development builds change their code hash on every build, so TCC asks again after
    each rebuild. That is expected in development and documented, not worked around with
    `tccutil reset`.
  - Each platform helper is one more signed artifact to build, notarize and qualify.
  - The driver's daemon socket still has no secret. A process running as the same user can reach
    it; the helper narrows the path GOAT gives agents, not the OS user boundary.
  - Background input and private mode depend on what each platform exposes. Wayland has no
    background input path, so foreground actions there need an exclusive lease.
