# 001 — Research (gpt-6.1-sol, 2026-10-11)

Leaves: r2 01a12880-e8fd (install-before-switch), r1 01a12880-ea21 (bundled runtime), r3 01a12880-eb0e (protocol reuse), r4 01a12880-ec13 (updates/identity/packaging/push). Key facts:

- tunnel.ts: RUNNER_NEXT written ~626, REPLACE_RUNNER_INSTALL ~803 renames before '--version' at ~637; restarts at ~739; stale tunnel closeTunnelEntry ~2055 → finalizer stopRemoteServer ~1987 (desktop lacks leaveRemoteServerRunning). Pairing rewrites runner ~792 and prepares without stateKey ~1307; MCP ~844.
- WSL bundle pattern: build-desktop-artifact.ts ~1080/2993/3022/2791/3956/3428-3479; release-desktop.yml ~318/366/438/456/463; resources via process.resourcesPath (ElectronApp.ts:124, DesktopEnvironment.ts:199, DesktopBackendConfiguration.ts:674). Linux CLI archives cannot be cross-built on macOS (node-pty compile, GNU tar flag).
- Protocol: ORCHESTRATION_PROTOCOL_VERSION=2 (contracts/environment.ts:12), descriptor serverVersion/orchestrationProtocolVersion (ServerEnvironment.ts:208), WS 426 on mismatch, server-runtime.json has no version fields.
- Updates: feed from T3CODE_DESKTOP_UPDATE_REPOSITORY → GITHUB_REPOSITORY (build-desktop-artifact.ts:2666/2800); preview builds omit feed (:2703); app T3 Code (Alpha/Nightly), bundle com.t3tools.t3code, profile t3code-v2, state ~/.t3/userdata; --signed requires passkey provisioning (:3800). goat-ci runs on push to dev/main/preview/goat/**; pre-push guard checks workflow states.
