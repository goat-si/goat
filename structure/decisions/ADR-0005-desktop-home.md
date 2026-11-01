# ADR-0005 — decision recorded under "State roots"

- Contract owner: [settings-and-storage.md](../settings-and-storage.md#state-roots)
- Commit: `b79ff462c140878e0dde164dd91731fac7ada461` (2026-10-11)

## Decision record

- 목적과 의도: Package GOAT as its own desktop app, with its own data directory and update feed, so it can sit beside an upstream T3 Code install.
- 기존 구현 및 제약 조건: The message says a packaged build was still "T3 Code" with upstream's bundle id, Electron profile, and `~/.t3/userdata`, and that its update feed followed `GITHUB_REPOSITORY`. That could collide with an upstream install or update into upstream T3.
- 검토한 주요 대안: The message does not name a third layout. It rejects sharing upstream's identity and `~/.t3/userdata`.
- 선택한 방식: Packaged builds are GOAT, with their own bundle ids and profile, data under `~/.goat/desktop`, and an update feed only when the build opts in with `goat-si/goat`. The Electron runtime name stays so saved SSH credentials remain readable. The message says the standalone CLI keeps `~/.t3`.
- 다른 대안 대신 이 방식을 선택한 이유: Sharing `~/.t3/userdata` and the upstream bundle identity is the collision the message describes.
- 장점, 단점 및 영향: `resolveDesktopBaseDir` in `apps/desktop/src/app/DesktopStatePaths.ts` still returns `~/.goat/desktop` for a packaged build and `~/.t3` for development when `GOAT_HOME` is unset. `node apps/server/scripts/import-desktop-home.ts` is the one-shot import the message adds. The CLI default is unchanged by this commit. ADR-0006 covers the SSH host home.
