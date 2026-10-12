# ADR-0006 — decision recorded under "State roots"

- Contract owner: [settings-and-storage.md](../settings-and-storage.md#state-roots)
- Commit: `ddb93f2b5ca34852ff328bff2267338e2fb804b3` (2026-10-11)

## Decision record

- 목적과 의도: Ship the command as `goat`, and stop SSH hosts from running GOAT out of `~/.t3`.
- 기존 구현 및 제약 조건: The message says the executable, archives, and installers were still named `t3`, and GOAT on an SSH host reused upstream's `ssh-launch` runner and runtime directories. A dispatch to a MacBook kept downloading an upstream nightly and failed with a 404.
- 검토한 주요 대안: The message does not record a third directory layout. It rejects sharing `~/.t3` on a host that also runs upstream T3 Code.
- 선택한 방식: One executable named `goat`. Archives are `goat-<version>-<platform>`. Runtimes live in `<home>/runtime/goat/versions`. On SSH hosts the runtime, launch state, and server home are under `~/.goat`, and those scripts do not touch `~/.t3`. A retained runner is reused only when its own GOAT runtime is installed. The npm package stays `t3` and exposes both `goat` and `t3` bins.
- 다른 대안 대신 이 방식을 선택한 이유: Sharing the upstream runtime directory is how the 404 happened.
- 장점, 단점 및 영향: `packages/ssh/src/tunnel.ts` still sets `DEFAULT_SERVER_HOME="$HOME/.goat"`. `apps/server/package.json` still has both bins. `resolveBaseDir` in `apps/server/src/os-jank.ts` still defaults a local server to `~/.t3`. This commit does not change that local default. ADR-0005 is the packaged desktop directory.
