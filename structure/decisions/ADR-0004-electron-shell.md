# ADR-0004 — decision recorded under "Shell"

- Contract owner: [desktop.md](../desktop.md#shell)
- Commit: `f194c9661c2eec85f17e972da77772a915d483cd` (2026-02-07)

## Decision record

- 목적과 의도: The subject is "Monorepo electron init". The commit creates `apps/desktop` with a main process, preload, and IPC wiring beside the web renderer.
- 기존 구현 및 제약 조건: Before this commit the repository had no Electron app. The message body is empty.
- 검토한 주요 대안: The commit message does not record a rejected alternative.
- 선택한 방식: A dedicated Electron package in the monorepo. The current main process is `apps/desktop/src/main.ts`. The renderer is still the web app, served in packaged builds from `apps/desktop/src/app/DesktopEnvironment.ts`.
- 다른 대안 대신 이 방식을 선택한 이유: The message does not say why Electron was chosen.
- 장점, 단점 및 영향: Desktop adds a shell, a bundled server process, and a preload bridge. It does not grow a second orchestration engine. Later packaging (`b79ff462c140878e0dde164dd91731fac7ada461`) gave that shell its own data directory. See ADR-0005.
