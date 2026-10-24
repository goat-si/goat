# ADR-0022 — decision recorded under "Computer use"

- Contract owner: [server.md](../server.md#computer-use)
- Commit: `ba39b38a3` in #665 (pin, telemetry opt-outs, identity), on top of the ports of
  pingdotgg/t3code#21694 at `b8569ac92` and #21695 at `dc307c8a7`. The commit messages do not
  record the alternatives below; they come from the lane plan and research for this program.
- Related: [ADR-0003](ADR-0003-effect-services.md), [ADR-0014](ADR-0014-desktop-runtime-identity.md)
- Amended by: [ADR-0023](ADR-0023-goat-computer-use-app.md). The Electron-owned host and the
  `si.goat.desktop` identity under "Identity" are superseded by a separate signed helper app; the
  rest of this record stands.

## Decision record

- **Purpose.** Agents in GOAT should be able to see and operate the GOAT host's desktop (computer
  use) on macOS, Windows and Linux, with a driver GOAT can ship under its own license terms, keep
  pinned, and keep from reporting usage to a third party.
- **Before.**
  - GOAT had no computer use. Agents could drive the collaborative browser preview only.
  - Upstream T3 Code had two open, unmerged Cua Driver stacks. The newer one (#21694-#21697, by
    Julius Marminge, rebuilt from his #16527) adds verified distribution, an opt-in server
    lifecycle, an Electron-owned host and packaging, and attaches nothing to agents. It pins Cua
    Driver 0.34.1.
  - The Cua Driver SDK and executable speak a private protocol and must share a version.
    `@trycua/cua-driver` on npm stops at 0.37.0; driver 0.38.0 exists only as a GitHub release.
- **Alternatives.**
  - The Cua SDK (`@trycua/cua`) or Cua Spaces. They target sandboxes and VMs, are several hundred
    MB per platform, and Spaces (`cua-spacesd`) is FSL licensed.
  - A provider's built-in computer use (for example a Codex `cua_repl` tool). It exists for one
    provider only and runs under that provider's identity, not GOAT's.
  - Writing a GOAT host for each OS. It repeats the accessibility, capture and input work the MIT
    driver already does on three platforms.
  - Waiting for upstream to merge. GOAT would carry nothing until then and the eventual chase would
    land the same files anyway.
- **Decision.**
  - **Port upstream.** GOAT carries the upstream stack at its frozen heads with GOAT renames
    (`scripts/goat-rename.ts`), and reconciles file by file when upstream merges its version
    (fork delta area `cua-driver`).
  - **Pin 0.37.0.** `packages/shared/src/cuaDriverRelease.ts` pins the official 0.37.0 archive
    names, byte sizes and SHA-256 from the release's `SHA256SUMS`, and the pnpm catalog pins
    `@trycua/cua-driver` 0.37.0, the newest version published for both halves. Updates happen only
    through GOAT releases. The driver's own update check and `update --apply` are never used.
  - **MIT parts only.** GOAT ships the `cua-driver` executable and the `@trycua/cua-driver` SDK
    (MIT; the SDK's native packages add an MPL-2.0 Node runtime with its notice). Never the Cua
    SDK, Spaces, perception or set-of-marks components (FSL or AGPL), extensions or skill packs.
  - **Telemetry and update check off.** The driver sends usage events by default. The embedded
    host clears the daemon's environment and rejects names outside its allowlist, so every host
    passes `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`, `CUA_TELEMETRY_ENABLED=false` and
    `CUA_DRIVER_RS_UPDATE_CHECK=false` (`cuaDriverHostOptions`). `DO_NOT_TRACK` and
    `CUA_TELEMETRY` are not on that allowlist and passing them makes host construction fail. The
    MCP descriptor agents spawn (`cua-driver mcp`) is a separate process outside the allowlist,
    so the server adds all five opt-outs to it (`withCuaDriverPrivacyEnvironment`).
  - **Off by default.** The server setting `enableCua` starts false. Standalone servers
    honor `GOAT_CUA_DRIVER_PATH` before downloading. Desktop servers ask the Electron main
    process for a host over the private control pipe; the Electron host itself is ported
    separately (#21696, #21697 on feat/cua-driver-desktop).
  - **Identity.** macOS grants Accessibility and Screen Recording to the app at the top of the
    driver's launch chain. On a Mac the desktop host runs the driver through
    `GOAT Computer Use.app` (`<appUserModelId>.computer-use`, in `Contents/Helpers`), which
    re-execs itself with responsibility disclaimed and spawns `cua-driver serve --embedded` as
    its direct child, so the grants and the driver's `bundle_identity` check name the helper
    (`apps/desktop/native/computer-use-helper`, epic #1140). A build without the helper falls
    back to the Electron host under the app's `appUserModelId`. A standalone server on a Mac
    reports `unavailable`: its launch chain ends at a terminal or launchd job (#1174). Elsewhere
    the standalone host identifies as `si.goat.server`.
  - **Provider attachment.** Ported from pingdotgg/t3code#16528 at `7418a6084`: every provider
    that runs on the GOAT host gets the driver as a stdio MCP server named `cua-driver`, with no
    GOAT HTTP proxy, plus a short `<computer_use>` block that keeps input in the background. One
    server function (`computerUseAttachment`) decides it for every session; see "Per-adapter
    decision" below.
  - **Safety.** Standard permission mode under a GOAT capability manifest, and admission of
    unattended threads through an approved lease, with every attached driver behind a GOAT
    proxy that enforces Stop, the host kill switch, pauses and app approvals; see "Safety" below.
  - **Remote hosts.** Each server checks its own screen (`CuaDisplayCapability.ts`) and reports
    `available`, `partial` or `unavailable` with a reason and display. Turning computer use on
    is refused only on `unavailable`; `partial` (an X display without a session bus or AT-SPI
    that answers, a live Wayland socket without XWayland, or a Mac before its grants are seen) is
    allowed with the reason shown, and turning it on completes the verified install before it
    reports success. Every check proves something answers: an X11 setup handshake per Xauthority
    cookie, a Wayland socket that accepts, a session bus and AT-SPI bus that answer D-Bus calls.
    Only the driver can read macOS grants, so a Mac is `available` only after the running daemon's
    `check_permissions` reports both. Only the current daemon's latest answer counts: a restart, or
    a check that fails or times out, drops the Mac back to `partial`. The display check reruns
    before every driver start, because a session can sign out after the last check, and its
    DISPLAY, XAUTHORITY, D-Bus session bus and runtime directory reach the standalone host
    through the embedded allowlist, since a server started over SSH has none of them. The host copies
    allowlisted names from the server's own environment before these and cannot unset one, so on
    Linux a session bus the check rejected is passed empty (`CUA_DRIVER_PROBED_SESSION_NAMES`).
    Windows Session 0 (SSH, services) is `unavailable`: GOAT does not launch the driver into
    another session.
- **Reasons.**
  - Upstream's design already went through six adversarial review rounds. Carrying it unchanged
    keeps the chase small and the review history meaningful.
  - 0.37.0 is the only version where the SDK and the executable can match from public sources.
  - The embedded allowlist is enforced in the driver (`allowed_environment_name` in
    `cua-driver-sdk/src/embedded.rs` at `cua-driver-rs-v0.37.0`); naming only allowed switches is
    the one way an opt-out reaches the daemon.
- **Tradeoffs.**
  - This combined port and 0.37.0 pin is a new integration that upstream has not reviewed.
  - Standalone servers download about 37-53 MB on first enable. Once desktop packaging lands,
    packaged desktop builds carry the driver whether or not the user enables it.
  - Native macOS TCC attribution, Windows hosting and packaged Linux capture still need human
    qualification, as upstream's PRs state.

## Per-adapter decision

`computerUseAttachment` returns `none` (with a reason) or `proxied`. It attaches only when
`enableCua` is on, the driver is running, the provider runs on this host, and the turn is neither
Plan nor a read-only sandbox. An unattended turn gets `none` with `cuaDriverBlocked` unless its
thread holds a lease and the host's helper reports both a person's input and secret fields as
supported signals in its readiness (`cuaReadiness`, also shown as `CuaHostStatus.readiness`;
otherwise `detection-unsupported`, #1235). Every attachment carries GOAT's proxy
instead of `cua-driver mcp` under the thread's control (see "Safety") with
`cuaDriverOverridesUserConfig`: a `cua-driver` the person configured would skip Stop, pauses and app
approvals. Without the proxy subcommand nothing could stop the driver, so there is no attachment.

| Provider (driver kind)                                | Decision                                    | How                                                                                                                                                                       | A change reaches a live session                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude (`claudeAgent`)                                | Attach                                      | SDK `mcpServers` beside `goat`; `mcp__cua-driver__*` preapproved, never in a read-only sandbox                                                                            | Next turn, through `setMcpServers` without replacing the process; the block rides the next prompt if needed                                                                          |
| Codex (`codex`)                                       | Attach unless the user defines `cua-driver` | Thread config path `mcp_servers.cua-driver` beside `mcp_servers.goat`; the user's merged config is read once per directory (`config/read`), theirs wins unless overridden | Next turn, through the `thread/resume` reconfigure; a dropped driver is sent with `enabled: false`                                                                                   |
| Cursor (`cursor`)                                     | Attach                                      | SDK `mcpServers` when the agent opens                                                                                                                                     | Next turn reopens the same agent                                                                                                                                                     |
| Grok, Antigravity, ACP registry including Devin local | Attach                                      | ACP stdio `mcpServers`, also in the MCP-over-ACP list                                                                                                                     | Next turn. A session that loses or changes its driver (Plan, read-only, a new daemon) restarts the agent process first, because agents keep the stdio servers a session started with |
| OpenCode 1.x (`opencode`)                             | Attach on a server GOAT owns                | `mcp.add` named `cua-driver`, disconnected when dropped                                                                                                                   | Next turn                                                                                                                                                                            |
| OpenCode 2 (`opencode`)                               | Attach on a server GOAT owns                | Per thread and directory as `cua-driver-<digest>`. Every turn denies `cua-driver-*`, even without a driver, and only a turn with one allows its own exact server          | Next turn                                                                                                                                                                            |
| Pi (`pi`)                                             | Attach                                      | Pi has no MCP client; GOAT's Pi extension bridges the stdio server and passes screenshots through as images                                                               | Added at the next Pi process start. Before each turn the adapter writes a gate file; a turn without the launched driver closes its connection and tools in `before_agent_start`      |
| Muse (`muse`)                                         | Not supported                               | GOAT gives Muse session MCP servers over streamable HTTP only; the driver is a stdio server                                                                               | -                                                                                                                                                                                    |
| Claude cloud, Cursor cloud, Devin cloud (cloud tasks) | Not supported                               | The driver operates the GOAT host's desktop, not the cloud runner's                                                                                                       | -                                                                                                                                                                                    |

- **Alternatives.** Upstream #15006's per-thread proxy that ends the driver session at every turn
  end (dropped upstream too: Stop ends the provider turn and the driver's idle timeout hides its
  cursor). Reopening Claude's query when the server set changes, as #16528 does: GOAT refuses to
  replace a Claude process that runs background work, so a live `setMcpServers` keeps the turn
  from failing.

## Safety

Commit: on `feat/cua-safety-guard` (lane 4, Phase 3). Verified against the pinned 0.37.0 binary on
macOS and its source at `cua-driver-rs-v0.37.0`.

- **Purpose.** GOAT Bot runs with full access and is read-only by instruction only, and scheduled,
  webhook and channel work runs with nobody watching. Seeing and operating the host's screen needs
  a guard of its own that does not depend on the prompt.
- **Driver ceiling.** Both hosts start the daemon in `standard` mode with
  `--capability-manifest <file> --approve-capability-manifest`, written at each start by
  `packages/shared/src/cuaDriverManifest.ts` (v3 schema).
  - Tools: observation, input, `run_steps`, `run_script`, sessions and cursor. Excluded with
    reasons in `CUA_DRIVER_EXCLUDED_TOOLS`: installs, driver configuration, update checks,
    trajectory replay, the perception extension, deprecated capture tools, recording (writes
    files), both clipboard tools (the person's copied secrets; file loading), `kill_app` (unsaved
    work; no terminate scope is granted) and every browser tool (they need per-origin grants a
    launch-time file cannot know, and logged-in profiles are never granted).
  - Resources: `desktop.display` plus one `apps[].bundle_id` per app the driver's own
    `list_apps` reports at start, from a short-lived `cua-driver mcp` (`--direct` on macOS). No
    file paths, processes, origins or existing browser profiles. Excluded apps: the GOAT host
    itself (where people approve), the driver's app and credential stores. 0.37.0 checks every
    window and application observation and every input against the manifest once one is loaded,
    and has no wildcard app grant, so an app installed after the start stays out until computer
    use restarts.
  - Verified live: a display-only manifest refused `list_windows` on Finder; an app grant
    admitted Finder and refused Dock, including a `click` nested in `run_steps` and calls nested
    in `run_script` (tool and resource refusals); the full GOAT manifest starts and refuses
    `clipboard_read` and `get_config`. A bad manifest (unknown tool, empty allow list, missing
    approval) exits 64 before listening; the SDK reports only the exit, so hosts map it to "Cua
    Driver refused GOAT's capability manifest" and the reason stays in the inherited stderr.
  - The manifest is a ceiling. It cannot judge intent: typing a secret into an admitted window
    stays possible.
- **Bounded mode, rejected.** It requires `expires_after` and `idle_timeout` (24 h at most), and
  an expired idle lease is terminal for the daemon instance. The daemon is shared by every thread
  on the host, so its lifetime would end interactive work too and force restarts; and it offers
  no runtime approval path GOAT could answer. That is an ownership tradeoff, not a flaw in
  bounded mode; GOAT keeps per-thread lifetimes in its own lease.
- **Unattended origins.** `ComputerUseOrigin` classifies each turn: the GOAT Bot thread, channel
  task workers, runs whose message came from a scheduled or webhook task or a channel, messages
  sent by an unattended thread, and threads launched or delegated by an unattended turn (judged
  at the launch time) are unattended. Launches from another machine are unattended. A person
  promoting or forking a thread takes it over. Any read failure or runaway lineage counts as
  unattended.
  - Provenance is read from what is fixed before a turn can run. A channel worker is known from
    its thread id (`channel-worker:<digest>`, `isChannelWorkerThreadId`), which the dispatcher
    chooses before launch, not from the ledger's `task.worker.bound`, which commits after the
    launch and could lose a race with the first turn's preparation. Scheduled and webhook runs
    carry `scheduledTaskId` on the message that starts them, committed with the run.
  - Steering keeps a turn's starting message, so a classification at attachment would never see
    an instruction that joins a running turn. A message from an unattended origin (a scheduled
    task, or a sender thread that classifies unattended) aimed at a person's running turn is
    therefore queued behind that turn instead of steering it
    (`gateUnattendedSteering`, applied where `ThreadManagementService` sends) while computer use
    is on. The same gate runs when a message that queued behind a slow-starting turn would be
    promoted into it once the turn can steer, so that delayed path keeps the message as its own
    turn too. It then starts its own turn, which this message classifies as unattended. Steering
    into an unattended turn is unchanged, since that turn has no direct driver, and so is all
    steering while computer use is off, when no turn holds a driver. A sender this host cannot
    classify, such as a thread on another machine, counts as unattended. A person promoting the
    queued message to steer is their decision.
- **Admission lease.** An unattended thread asks with `goat_computer_use_request`, which creates
  an approval handoff on `computer_use.grant` whose text names the thread and turn, this host,
  the stated purpose and the expiry. Approving it needs `settings:write` in an authenticated
  client session, the same as turning computer use on, so channel text cannot answer it. It is
  admission for the thread's turns until the expiry, not per-action approval. The approved
  handoff is the lease: it expires on its clock rather than when the asking turn ends, a person
  ends it early by moving it to cancelled (the only terminal transition allowed after approval),
  and turning computer use off ends it. At most one live lease per host: a second request is
  refused naming the holder, and a second approval is refused while one is live. Interactive
  threads still overlap a leased one; there is no focus or input isolation.
- **App approvals.** A grant may name apps (`Handoff.apps`, bundle ids as `list_apps` reports
  them); it then admits only those apps' windows. Interactive threads ask the same way: without a
  grant they may list apps and windows but act on none. The proxy ties a call to an app by the
  pid it targets and learns which app a pid is from the driver's own answers, asking
  `list_apps` when it has not seen one. Calls with no target act on the whole desktop, and
  `run_script` and `run_steps` cannot be read ahead, so under a list they are refused
  (`targetRefused`, detail `desktop_not_approved`) unless a grant covers the whole screen.
- **Controls.** Every attached driver runs under a control the server mints per thread: an
  unattended one lives on its grant, an interactive one for 60 minutes. Stop on a turn
  (`ProviderTurnControlService` interrupt and restart) and the host kill switch
  (`computerUse.stopAll`, which also cancels every live grant) end it; the next turn mints a new
  id, which changes the attachment key, so adapters respawn the proxy. A person's input reported
  by the desktop host (`cuaHumanInput`) or a takeover pauses every control on the host until
  `computerUse.resume`; a pause with no agent on the screen does nothing. A secret field the host
  reports (`cuaPrivateMode`, window only, never its content) pauses every control as `private`
  until it loses focus. The control counts these pauses, so a proxy that only sees the state after a
  pause has already ended still ends the call it overlapped. Narrowing a thread's approved apps ends
  the call in flight. Interactive
  turns run where the helper cannot report these yet, with the gap shown as unsupported; unattended
  ones do not. Controls and pauses are
  in memory, ended by a restart like the provider processes they serve.
- **Proxy.** Every attached provider runs `goat cua-lease-proxy --control` in place of
  `cua-driver mcp`. It holds the thread's own MCP credential and reads
  `/api/computer-use/lease`, which streams the control's state (with its apps) and pushes its
  pause or end. Every `tools/call` waits for the server's confirmation and checks the deadline and
  the apps; the proxy holds its own timer on the expiry. On an end, a lost stream or computer use
  turned off, it refuses new calls, sends MCP cancellation for every outstanding request, kills its
  `cua-driver mcp` child, answers the provider, and only then revokes the driver sessions the
  agent named, in the background: a slow or stuck revoke never delays the kill. A pause does the
  same without ending; when the server hands control back the proxy starts a fresh child and
  replays the provider's MCP handshake to it. Refusals carry a typed `refused` reason from the
  shared list in `packages/contracts/src/cua.ts` (`ComputerUseRefusalReason`, which the native
  helpers use too; a policy refusal is never a person's stop) and the proxy's finer `detail` in
  `structuredContent`, and are never replayed for the agent.
- **Stopping boundary (0.37.0, measured on macOS).** A `run_script` launching six apps 1.5 s
  apart was stopped three ways. MCP `notifications/cancelled` and `cua-driver revoke --session`
  ("Revoked 1 authorization scope") both let all six launch: 0.37.0 defers session cleanup while
  admitted work is in flight (`cua-driver-core/src/session.rs`, `end_session_with_reason`).
  Killing the `cua-driver mcp` transport stopped it each time after the launch already
  dispatched (kills at 2.4, 5.2 and 7.4 s left 1, 3 and 4 apps). Through the real proxy, a pushed
  revocation and the proxy's own expiry each stopped the script after the actions already
  dispatched and refused later calls. So the boundary is the primitive in progress, and killing
  the transport is what enforces it; cancellation and revocation are kept as protocol hygiene.
  Restarting the daemon is not needed for this.
- **User-defined servers.** For an unattended turn without a lease, Codex gets a whole
  `mcp_servers.cua-driver` entry with `enabled: false`, and Claude gets a stand-in
  `cua-driver` that exits at once, so their merge by name never starts a user's own driver; with
  a lease both resolve the name to the proxy. Cursor, the ACP agents, OpenCode and Pi read their
  own MCP config in ways GOAT cannot override by name; GOAT never attaches or pre-approves a
  driver there for such a turn, but a driver the user configured in those tools stays theirs.
- **Limits.** The daemon's socket has no secret (the SDK keeps the MCP descriptor to the socket
  path), so any process running as the same OS user, including a full-access agent's shell, can
  reach it directly. The lease guards the path GOAT gives agents; separating agents from the
  person's own account needs another OS user. Desktop sessions are shared with the person.
- **Alternatives.** Prompt-only rules (what GOAT Bot already has); per-action approvals (the
  driver's standard grants have no approval provider in embedded mode, and an unattended thread
  has nobody to answer them); bounded mode (above); restarting the daemon on every lease end
  (stops interactive threads too and is not needed once the transport kill is proven).
