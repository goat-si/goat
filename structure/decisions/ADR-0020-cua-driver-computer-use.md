# ADR-0020 — decision recorded under "Computer use"

- Contract owner: [server.md](../server.md#computer-use)
- Commit: `ba39b38a3` in #665 (pin, telemetry opt-outs, identity), on top of the ports of
  pingdotgg/t3code#21694 at `b8569ac92` and #21695 at `dc307c8a7`. The commit messages do not
  record the alternatives below; they come from the lane plan and research for this program.
- Related: [ADR-0003](ADR-0003-effect-services.md), [ADR-0014](ADR-0014-desktop-runtime-identity.md)

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
  - **Identity.** The standalone host identifies as `si.goat.server`. The Electron host is to
    use the app's `appUserModelId` (`si.goat.desktop` and its nightly and dev variants).
  - **Provider attachment.** Ported from pingdotgg/t3code#16528 at `7418a6084`: every provider
    that runs on the GOAT host gets the driver as a stdio MCP server named `cua-driver`, with no
    GOAT HTTP proxy, plus a short `<computer_use>` block that keeps input in the background. One
    server function (`computerUseAttachment`) decides it for every session; see "Per-adapter
    decision" below.
  - Pending in later records: the permission mode and capability ceiling (including removal of
    the driver's on-demand `check_for_update` tool), approval for unattended threads, and
    enabling it on remote hosts.
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

`computerUseAttachment` returns `none` (with a reason) or `direct`. It attaches only when
`enableCua` is on, the driver is running, the provider runs on this host, and the turn is neither
Plan nor a read-only sandbox. Unattended origins are gated later by adding a branch to that
function, which hands adapters a different stdio descriptor through the same session field and can
set `cuaDriverOverridesUserConfig`.

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
