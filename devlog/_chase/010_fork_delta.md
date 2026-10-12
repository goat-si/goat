# 010 — GOAT 의도적 분기 레지스트리

> 기준: fork point `de49d637d` 이후 GOAT dev `f4b6c14e5`의 44커밋 (devlog 제외 378파일)

upstream 머지에서 충돌이나 의미 회귀를 만드는 것은 아래 영역이다. 새 GOAT 기능이 upstream 파일을
바꾸면 영역을 추가하거나 기존 영역을 고친다. 충돌이 여기 적힌 정책으로 풀리지 않으면 카드를
만든다.

## 영역

영역 ID는 짧은 kebab-case 슬러그다. 번호가 아니므로 병렬 브랜치가 같은 ID를 고를 일이 없고, 머지
때 다시 매길 것도 없다. 새 영역을 더하는 규칙은 이렇다.

- 블록은 ID의 알파벳 순서 자리에 끼워 넣는다. 끝에 덧붙이면 병렬 브랜치가 모두 같은 줄을 고쳐
  머지 충돌이 난다. 표 대신 블록을 쓰는 이유도 같다. 표는 한 행이 길어지면 포매터가 모든 행을 다시
  정렬한다.
- 브랜치에서 커밋은 PR 번호(`#17`)로 적는다. 브랜치 해시는 rebase 뒤 dev에서 찾을 수 없다. dev에
  들어온 해시는 그대로 적어도 된다.
- 같은 ID가 이미 있으면 다른 슬러그를 고른다. 한 영역이 넓어졌으면 새 블록 대신 기존 블록의 경로와
  정책을 고친다.
- `devlog/_chase/scan.sh --delta`가 ID 중복, 슬러그 형식, 순서, dev에서 닿지 않는 해시를 검사하고
  문제가 있으면 1로 끝난다. 영역을 고친 브랜치와 머지 관리자는 머지 전에 돌린다.

2026-10-12 이전 커밋 메시지의 G 번호는 이렇게 읽는다: G1 `brand`, G2 `global-agent`,
G3 `mcp-names`, G4 `cli-home`, G5 `desktop-identity`, G6 `ssh-runtime`, G7 `server-activity`,
G8 `ci`, G9 `composer-footer`, G10 `link-thread-maximize`, G11 `devlog`, G12 `no-t3-import`,
G13 `goat-copy`, G14 `launch-watch`.

### `brand` 브랜드

- 커밋: `cc1ba0550` `8f36aefa3`
- 경로: `apps/{web,mobile}`, `apps/desktop/src/{app,window}`, `apps/desktop/resources/dmg`, `assets`, `scripts/export-*-icons.ts`
- 정책: 보이는 이름, 마크, 아이콘은 GOAT 유지. 같은 컴포넌트의 upstream 로직 변경은 받는다.

### `channels` 채널 원장과 GOAT 봇

- 커밋: #32 #56
- 경로: `apps/server/src/channels`, `apps/server/src/mcp/toolkits/channel`, `apps/server/src/persistence/Migrations/064_*`, `apps/server/src/orchestration-v2/{Orchestrator,ThreadMessageIntake,runtimeLayer}.ts`, `apps/server/src/textGeneration`, `apps/server/src/{server,ws}.ts`, `packages/contracts/src/{channelGateway,orchestrationV2,rpc,clientRpcPermissions}.ts`, `packages/client-runtime/src/state/channels.ts`, `apps/web/src/state/channels.ts`, `apps/web/src/components/goatBot`, `apps/web/src/routes/_chat.bot.tsx`, `apps/web/src/AppRoot.tsx`, `apps/web/src/components/{ThreadRouteView,Sidebar,LegacySidebar}.tsx`, `apps/web/src/components/sidebar/{SidebarChrome,SidebarViewToggles}.tsx`, `apps/web/src/components/sidebar/SidebarViewToggles.logic.ts`, `apps/web/src/state/entities.ts`
- 정책: GOAT 전용. 마이그레이션 064는 다시 실행해도 안전하게 써서(`IF NOT EXISTS`) upstream이 그 id를 가져가면 옮길 수 있다. upstream의 orchestrator, intake, text generation, RPC 변경은 받고 봇 스레드의 provider run 거부, 봇 입력의 채널 접수, 채널 RPC·MCP 도구, reception 생성을 다시 얹는다. 웹에서는 봇 스레드가 `ThreadRouteView`에서 메신저 화면(`components/goatBot`)으로 갈라지고 작업자 `ChatView`는 그대로다. 두 사이드바의 봇 행과 봇 스레드 제외, 로고의 봇 경로, `AppRoot`의 채널 포트 공급은 upstream 사이드바 변경을 받은 뒤 다시 얹는다.

### `ci` CI

- 커밋: `bfce4301d` `cc5003979` `095115376`
- 경로: `.github/workflows/goat-ci.yml`, `.vite-hooks/`, `packages/ssh/src/tunnel.*.test.ts`
- 정책: GOAT CI는 EPYC의 goat-ci 하나이고 upstream workflow는 goat-si/goat에서 모두 비활성이다. `tunnel.test.ts`는 여러 파일로 나뉘었다.

### `cli-home` CLI `goat`와 `~/.goat`

- 커밋: `ddb93f2b5` `d85eb9aff`
- 경로: `apps/server/src/cli`, `apps/server/src/cloud`, `apps/desktop/src/wsl`, `scripts/install.sh`
- 정책: upstream 로직을 받고 실행 파일 `goat`, `runtime/goat/versions`, SSH 호스트 `~/.goat`를 유지한다.

### `composer-footer` 컴포저 푸터

- 커밋: `bb13f89b5` `a122f433a` `f4b6c14e5`
- 경로: `apps/web/src/components/chat`, `apps/web/src/index.css`
- 정책: 레이아웃은 GOAT, 컴포저 동작은 upstream.

### `delegated-tasks` 사이드바 위임 작업, 승격, launch 계보

- 커밋: #33
- 경로: `apps/web/src/components/{Sidebar.tsx,Sidebar.logic.ts,Sidebar.drag.ts,promoteThread.ts,CommandPalette.tsx,threadActionMenu.logic.ts}`, `apps/web/src/components/sidebar/{SidebarOpenSubagent.tsx,subagentIndex.ts}`, `apps/web/src/components/chat/{ChatHeader.tsx,ThreadRelationshipsControl.tsx,threadLauncher.logic.ts}`, `apps/server/src/orchestration-v2/{Orchestrator.ts,ThreadManagementService.ts,ThreadLaunchService.ts,ThreadForkService.ts,ProjectionStore.ts}`, `apps/server/src/mcp/{OrchestratorMcpService.ts,AcpMcpStdioBridge.ts,toolkits/{project,ssh,orchestrator}}`, `apps/server/src/sshRemote/SshRemoteDispatch.ts`, `packages/contracts/src/{orchestrationV2.ts,environment.ts}`, `packages/client-runtime/src/{operations/commands.ts,state/threadCommands.ts,state/threadRelationships.ts}`, `packages/provider-core/src/server/subagentProjection.ts`
- 정책: GOAT 전용 계약 필드(`launchedBy`, subagent `promotedAt`, `thread.stop.stopCascadeFrom`), 명령 `thread.promote`, capability `threadPromotion`. 마이그레이션 없음(`payload_json`). upstream이 같은 이름이나 계보 변경 명령을 들이면 카드로 결정한다. upstream의 사이드바, Orchestrator, fork/subagent builder 변경은 받고 이 동작을 다시 얹는다. 머지 때 확인할 것: Orchestrator의 "계보는 분리만 일어난다" 가정(`appOwnedSubagentParentThreadId`), 연쇄 Stop의 조상 확인, fork·subagent builder의 `launchedBy` 제거.

### `desktop-identity` 데스크톱 정체성

- 커밋: `b79ff462c`
- 경로: `apps/desktop/src/app`, `scripts/build-desktop-artifact.ts`, `.github/workflows/release-desktop.yml`
- 정책: 앱 id, userData, 업데이트 피드는 GOAT 유지. release workflow의 upstream 변경은 손으로 옮긴다.

### `devlog` devlog

- 커밋: `24d4ee846` `37073207d`
- 경로: `devlog/`, `.gitignore`의 `!/devlog/`
- 정책: GOAT 전용, 충돌 없음. `.gitignore` 충돌에서는 `!/devlog/` 줄을 남긴다.

### `global-agent` 글로벌 에이전트

- 커밋: `f391710d2` `0dc31be25` `83d1ebbd0` `6bebb0699`
- 경로: `apps/web/src/globalAgent*.ts`, `Sidebar.tsx`, `ChatView.tsx`, 헤더와 메뉴 컴포넌트
- 정책: `globalAgent*` 파일은 GOAT 전용이다. 공유 컴포넌트는 upstream을 받고 글로벌 에이전트 분기를 다시 얹는다.

### `goat-copy` 보이는 문구 GOAT

- 커밋: `e0596e725`
- 경로: UI·토스트·CLI 도움말 문자열 전반, `packages/provider-*/src/server`, `provider-core` 안내문, MCP 도구 설명, `docs/user`, `README.md`
- 정책: upstream 문구 변경을 받고 앱을 가리키는 "T3 Code"/"T3"만 GOAT로 다시 쓴다. 주석과 아래 이름 규칙의 "그대로" 항목은 바꾸지 않는다.

### `launch-watch` 띄운 스레드 완료 알림

- 커밋: `840e58797`
- 경로: `apps/server/src/mcp/LaunchWatchService.ts`, `launchWatch.ts`, `HostThreadsMcpService.ts`, `toolkits/{project,ssh,orchestrator}`
- 정책: GOAT 전용 상태 파일, 마이그레이션 없음. upstream을 받고 launch 등록, send re-arm, watch 도구를 다시 얹는다.

### `link-thread-maximize` 링크로 시작한 스레드 최대화

- 커밋: `ef4748eb7`
- 경로: `apps/web/src/components`
- 정책: upstream 우선, GOAT 동작만 다시 얹는다.

### `mcp-names` MCP 이름 `goat_*`

- 커밋: `e893682a4` `7a7a16584` `4dee8b21c`
- 경로: `apps/server/src/mcp/toolkits/*/tools.ts`, `orchestration-v2`, `packages/provider-*/src/server`, `t3McpToolPresentation.ts`
- 정책: upstream 로직을 받고 도구 이름은 `goat_*`, 서버 이름은 GOAT로 다시 쓴다. 새 `t3_*` 도구는 이름을 바꾸고 표시용 legacy alias를 둔다.

### `no-t3-import` T3 불러오기 제거

- 커밋: `59d7fe1a6`
- 경로: `ProjectScriptsControl.tsx`, `settings/ProjectActionsSettings.tsx`, `chat/ThreadDetailsPanel.tsx`, `hooks/useT3ProjectFileScripts.ts`
- 정책: t3.json 액션 가져오기 메뉴("Import scripts", "From t3.json")는 다시 들이지 않는다. 같은 파일의 다른 upstream 변경은 받는다. upstream이 `ThreadDetailsPanel.test.tsx`를 고치면 삭제를 유지한다. t3.json 기본값, iconPath, 깨진 파일 경고, V1→V2 스레드 마이그레이션은 upstream 그대로다.

### `remote-reports` 원격 보고와 원격 위임

- 커밋: #5 #10 #6
- 경로: `apps/server/src/remoteReports`, `apps/server/src/mcp/toolkits/{remoteReport,ssh}`, `apps/server/src/persistence/Migrations/06{2,3}_*`, `packages/contracts/src/remoteReports.ts`
- 정책: GOAT 전용. 마이그레이션 062·063은 다시 실행해도 안전하게 써서(`IF NOT EXISTS`) upstream이 그 id를 가져가면 옮길 수 있다. upstream의 SSH·MCP 변경은 받고 출발지 보고, 원격 위임, 첨부 전달을 다시 얹는다.

### `server-activity` 서버 activity와 마이그레이션 61

- 커밋: `c96310a1a` `d18f83e4e`
- 경로: `apps/server/src/persistence/Migrations*`, `ProjectionStore.ts`, `apps/server/src/http.ts`, `packages/contracts/src/environment*`
- 정책: 아래 마이그레이션 규칙.

### `ssh-runtime` SSH 런타임 공급과 원격 디스패치

- 커밋: `aa2eaf2ff` `480ed90da` `b32fe81d1` `b6a829960` `716f27dac`
- 경로: `packages/ssh/src/tunnel.ts`, `apps/server/src/sshRemote`, `apps/server/src/mcp/toolkits/ssh`, `apps/desktop/src/ssh`
- 정책: GOAT가 `tunnel.ts`를 크게 다시 썼다. upstream ssh 변경은 의도를 GOAT 코드에 손으로 옮긴다. 충돌 위험이 가장 높다.

## 깨끗하게 머지되고도 깨지는 것

다음 세 가지는 텍스트 충돌이 없어도 확인한다. `scan.sh`가 모두 출력한다.

**마이그레이션 id.** Effect migrator는 기록된 최대 id 이하의 마이그레이션을 이름과 상관없이
건너뛴다 (`.repos/effect-smol/packages/effect/src/sql/Migrator.ts:258`). GOAT가 먼저 쓴 id를
upstream이 다른 이름으로 쓰면, 이미 GOAT 마이그레이션을 기록한 DB는 upstream 스키마 변경을 영영
받지 못한다. `apps/server/src/persistence/Migrations.ts:202`도 이 상황을 경고만 한다. 그래서
규칙은 이렇다.

- GOAT 전용 마이그레이션은 가능하면 만들지 않는다. 필요하면 upstream에 올릴 수 있는 형태로 만든다.
- 만들어야 한다면 다시 실행해도 안전하게 쓴다 (`CREATE ... IF NOT EXISTS`, 컬럼 존재 확인). 나중에
  id를 옮길 때 이미 적용된 DB에서도 실패하지 않아야 한다.
- 높은 번호대(예: 9000번대)를 예약하지 않는다. 기록된 최대 id가 올라가 그 아래의 upstream
  마이그레이션이 전부 건너뛰어진다.
- 사이클 스캔에서 id가 겹치면 머지 전에 `⛔` 카드로 결정한다.

**`t3_*` 이름 누수.** upstream이 새 MCP 도구나 프롬프트 문자열을 `t3_*`로 추가하면 깨끗하게 머지된
뒤 GOAT의 `goat_*` 이름과 어긋난다. GOAT dev에는 legacy alias와 테스트로 `t3_*` 문자열이 이미
214줄(57파일) 있으므로 전체 0을 목표로 하지 않고, upstream이 그 사이클 범위에서 추가한 줄만 본다.

**workflow.** upstream이 `.github/workflows/`에 파일을 추가하거나 바꾸면 pre-push guard
(`.vite-hooks/goat-workflow-guard.mjs`)가 push를 거부한다. 그 workflow를 goat-si/goat에서 먼저
비활성화한다. 절차는 guard 메시지에 있다.

## 이름 규칙 요약

| 대상                  | upstream               | GOAT                                                                                                             |
| --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MCP 도구              | `t3_*`                 | `goat_*` (`t3_*`는 표시용 legacy alias)                                                                          |
| MCP 서버 표시 이름    | T3 Code                | GOAT                                                                                                             |
| provider 등록 키      | `t3-code`              | `t3-code` (그대로)                                                                                               |
| MCP env               | `T3_MCP_URL` 등        | 그대로                                                                                                           |
| CLI 실행 파일         | `t3`                   | `goat` (npm 패키지 `t3`, bin 둘)                                                                                 |
| SSH 호스트 홈         | `~/.t3`                | `~/.goat`                                                                                                        |
| 런타임 디렉터리       | `runtime/.../versions` | `runtime/goat/versions`                                                                                          |
| 보이는 앱 이름        | T3 Code, T3            | GOAT (UI, CLI 출력, 에이전트 안내문, docs/user)                                                                  |
| upstream 클라우드     | T3 Connect, T3 account | 그대로 (`app.t3.codes` 계정과 릴레이를 그대로 쓴다)                                                              |
| 외부에 남는 식별 이름 | T3 Code                | 그대로 (Codex `clientInfo`, ChatGPT `agent_name_hint`, Cursor API 키·세션 이름, OpenCode 세션 제목, 커밋 작성자) |
| 설치된 시스템 통합    | T3 Code                | 그대로 (GNOME 확장, KDE 항목, systemd 유닛, AppArmor 프로필, 원격 실행 스크립트 기준선)                          |
| 모바일 앱 정체성      | T3 Code                | 그대로 (`apps/mobile/app.config.ts` 이름·번들 id·권한 문구, `desktop-identity` 같은 결정 전)                     |
