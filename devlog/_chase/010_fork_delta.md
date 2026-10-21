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

### `channels` 채널 원장, GOAT 봇, Slack

- 커밋: #32 #56 #55 #54
- 경로: `apps/server/src/channels`, `apps/server/src/mcp/toolkits/channel`, `apps/server/src/persistence/Migrations/*_ChannelLedger*`, `apps/server/src/orchestration-v2/{Orchestrator,ThreadMessageIntake,runtimeLayer}.ts`, `apps/server/src/textGeneration`, `apps/server/src/{server,ws}.ts`, `packages/contracts/src/{channelGateway,channelLedger,channelReception,orchestrationV2,rpc,clientRpcPermissions}.ts`, `packages/provider-core/src/server/channelReceptionPrompt.ts`, `packages/client-runtime/src/state/channels.ts`, `apps/web/src/state/channels.ts`, `apps/web/src/components/goatBot`, `apps/web/src/routes/_chat.bot.tsx`, `apps/web/src/AppRoot.tsx`, `apps/web/src/components/{ThreadRouteView,Sidebar,LegacySidebar}.tsx`, `apps/web/src/components/sidebar/{SidebarChrome,SidebarViewToggles}.tsx`, `apps/web/src/components/sidebar/SidebarViewToggles.logic.ts`, `apps/web/src/state/entities.ts`, `apps/web/src/components/settings/{SlackChannelSettings*,IntegrationsSettings.tsx,settingsSearch.ts}`, `apps/server/package.json`
- 정책: GOAT 전용. ChannelLedger 마이그레이션은 다시 실행해도 안전하게 써서(`IF NOT EXISTS`) upstream이 그 id를 가져가면 옮길 수 있다. upstream의 orchestrator, intake, text generation, RPC 변경은 받고 봇 스레드의 provider run 거부, 봇 입력의 채널 접수, 채널 RPC·MCP 도구, reception 생성을 다시 얹는다. 다른 기기 작업자(`ChannelRemoteWorkers`)는 `remote-reports` 영역의 SSH launch와 출발지 보고 도구 위에 서므로, 그 영역의 upstream 충돌을 풀 때 함께 확인한다. 웹에서는 봇 스레드가 `ThreadRouteView`에서 메신저 화면(`components/goatBot`)으로 갈라지고 작업자 `ChatView`는 그대로다. 두 사이드바의 봇 행과 봇 스레드 제외, 로고의 봇 경로, `AppRoot`의 채널 포트 공급은 upstream 사이드바 변경을 받은 뒤 다시 얹는다. 채널·Slack RPC는 `WsChannelRpcGroup`에 따로 두고 서버는 그 handler를 별도 layer로 등록한다. 모든 RPC를 한 handler layer에 두면 타입 검사기의 instantiation 한도를 넘는다 (사이클 261013에서 209개). Slack 어댑터(`apps/server/src/channels/slack`)는 GOAT 전용이고 `@slack/socket-mode`, `@slack/web-api`, `undici`를 apps/server 직접 의존성으로 유지한다. Integrations 설정의 Slack 섹션 한 줄과 설정 검색 항목은 upstream 변경 위에 다시 얹는다.

### `ci` CI

- 커밋: `bfce4301d` `cc5003979` `095115376`
- 경로: `.github/workflows/goat-ci.yml`, `.vite-hooks/`, `packages/ssh/src/tunnel.*.test.ts`, `.github/scripts/pr-screenshot-gate.*`, `.github/pull_request_template.md`
- 정책: GOAT CI는 goat-ci 하나이고(신뢰 실행은 EPYC, fork PR은 hosted ubuntu-24.04), upstream workflow는 goat-si/goat에서 모두 비활성이다. GOAT에 쓸모없는 새 upstream workflow는 머지에서 빼고 사이클 카드에 적는다 (`mobile-android-apk.yml`, 사이클 261013). `tunnel.test.ts`는 여러 파일로 나뉘었다. PR 템플릿의 Screenshots 섹션은 goat-ci의 `screenshot-gate` 태스크와 짝이므로, upstream 템플릿 변경을 받을 때 그 섹션을 다시 얹는다. 사이클 261020: upstream `goat/no-dom-test-environment`(#21937)가 per-file jsdom pragma를 거부한다. GOAT 자체 jsdom 테스트는 루트 `vite.config.ts`의 `DOM_TEST_ENVIRONMENT_ALLOWLIST`에 두고 하나씩 browser 테스트나 Vitest project로 옮긴다 (#514). 새 GOAT 테스트는 목록에 더하지 않는다. 사이클 261021: upstream lint 규칙(#22000 `prefer-effect-fn`, #22187 `require-disposable-render`, 테스트 시간 규칙)은 `goat/*` 이름으로 받고 `goat-rename`의 `LINT_RULE_IDS`에 더한다. 그 전부터 있던 GOAT 위반 파일은 `vite.config.ts`의 `PREFER_EFFECT_FN_BACKLOG`·`DISPOSABLE_RENDER_BACKLOG`에 두고 하나씩 옮기며 뺀다. 새 파일은 더하지 않는다.

### `cli-home` CLI `goat`와 `~/.goat`

- 커밋: `ddb93f2b5` `d85eb9aff`
- 경로: `apps/server/src/cli`, `apps/server/src/cloud`, `apps/desktop/src/wsl`, `scripts/install.sh`, `scripts/build-npm-launcher.ts`, `scripts/npm-launcher`
- 정책: upstream 로직을 받고 실행 파일 `goat`, `runtime/goat/versions`, SSH 호스트 `~/.goat`를 유지한다. npm 배포는 upstream 단일 launcher(`scripts/build-npm-launcher.ts`, `scripts/npm-launcher/goat.mjs`) 위에 패키지 `goat`, bin `goat`·`t3`, 릴리스 저장소 `goat-si/goat-releases`를 얹는다 (사이클 261019).

### `composer-footer` 컴포저 푸터

- 커밋: `bb13f89b5` `a122f433a` `f4b6c14e5`
- 경로: `apps/web/src/components/chat`, `apps/web/src/index.css`
- 정책: 레이아웃은 GOAT, 컴포저 동작은 upstream.

### `cua-driver` Cua Driver 컴퓨터 사용 포트

- 커밋: #665 #667
- 경로: `apps/server/src/cua`, `packages/shared/src/cuaDriverRelease.ts`, `packages/shared/src/cuaDriverManifest.ts`, `apps/server/src/mcp/toolkits/computerUse`, `apps/server/src/handoffs/Handoffs.ts`, `apps/server/src/orchestration-v2/handoffState.ts`, `apps/server/src/channels/channelIds.ts`, `apps/server/src/orchestration-v2/ThreadManagementService.ts`, `apps/server/src/bin.ts`, `packages/contracts/src/handoff.ts`, `packages/contracts/src/agentSurface/registry.ts`, `packages/client-runtime/src/computerUseGrant.ts`, `apps/web/src/components/chat/HandoffCard.tsx`, `apps/mobile/src/features/threads/HumanHandoffCard.tsx`, `packages/contracts/src/{cua,resourceTelemetry,settings,index}.ts`, `apps/server/src/resourceTelemetry/DesktopTelemetryReceiver.ts`, `apps/desktop/src/telemetry/DesktopTelemetryPublisher.ts`, `apps/server/src/server.ts`, `apps/server/package.json`, `packages/shared/package.json`, `pnpm-workspace.yaml`, `third-party-licenses.config.json`, `apps/desktop/src/cua`, `apps/desktop/src/{main,preload}.ts`, `apps/desktop/src/ipc`, `apps/desktop/src/backend/DesktopBackendManager.ts`, `apps/desktop/package.json`, `packages/contracts/src/ipc.ts`, `scripts/build-desktop-artifact.ts`, `scripts/lib/{cli,desktop}-external-packages.ts`, `patches/@ubjs__node@0.31.0-3.patch`, `structure/decisions/ADR-0020-cua-driver-computer-use.md`, `apps/server/src/orchestration-v2/{ProviderSessionManager.ts,Adapters/ClaudeAdapterV2.ts,Adapters/CodexAdapterV2.ts}`, `apps/server/src/provider/CodexDeveloperInstructions.ts`, `packages/provider-core/src/server/{mcpSession,runtimeInstructions}.ts`, `packages/provider-acp/src/server/adapter.ts`, `packages/provider-cursor/src/server/adapter.ts`, `packages/provider-opencode/src/server/{adapter.ts,v2/adapter.ts}`, `packages/provider-pi/src/server/{mcpExtensionSource,mcpInjection}.ts`
- 정책: upstream이 머지하지 않은 PR #21694-#21697(고정 head `b8569ac92` `dc307c8a7` `6b627499b` `25852df14`)을 포트한 것이다. 이미 검토된 upstream 스택이 아니라 0.37.0 고정과 합친 새 통합이다. upstream이 자기 버전을 머지하면 대체하지 말고 고정 head와 파일별로 대조해 upstream 로직을 받고 GOAT 델타만 다시 얹는다: 0.37.0 고정(아카이브 바이트·SHA-256, catalog SDK 버전), `cuaDriverHostOptions`의 텔레메트리·업데이트 확인 끄기와 MCP 설명자의 `withCuaDriverPrivacyEnvironment`, 독립 서버 호스트 id `si.goat.server`, `GOAT_CUA_DRIVER_PATH`, `server.ts` layer 병합(`pipe` 20단계 한도). 데스크톱 쪽 델타: Electron 호스트도 `cuaDriverHostOptions`로 시작, 빌드 캐시 `node_modules/.cache/goat/cua-driver`, `apps/desktop/src/cua/notices`에 둔 0.37.0 고지 파일과 `third-party-licenses.config.json`의 `Cua Driver` 항목. provider 부착은 upstream PR #16528(고정 head `7418a6084`)의 포트다. upstream이 머지하면 같은 방식으로 대조하고 GOAT 델타만 다시 얹는다: 모든 세션의 부착 여부를 정하는 단일 함수 `apps/server/src/cua/ComputerUseAttachment.ts`(Plan·읽기 전용·클라우드·Muse 제외, 이후 lease 분기 자리), Claude는 쿼리를 다시 열지 않고 `setMcpServers`로 붙이고 `mcp__cua-driver__*` 사전 승인과 `canUseTool` 판정을 둔다, Codex는 upstream의 `mcp_servers.goat` 점 경로 옆에 `mcp_servers.cua-driver`로 넣고 `thread/resume` 재구성 키에 드라이버를 넣으며 떼어 낸 드라이버를 `enabled: false`로 보내며 `cuaDriverOverridesUserConfig`로 사용자 설정을 덮을 수 있다, Codex `<computer_use>`는 별도 추가 컨텍스트 키, Cursor는 드라이버가 바뀌면 에이전트를 다시 연다, ACP는 세션 활성화 기준으로 안내를 붙인다, OpenCode 2 서버 이름은 항상 digest인 `cua-driver-<16 hex>`(64자 제한). 첫 실행 안내와 원격 호스트 판정도 같은 영역에 더한다. 안전(lane 4)은 upstream에 없는 GOAT 델타다: 두 호스트 모두 standard 모드와 GOAT capability manifest(`cuaDriverManifest.ts`, 시작 때 드라이버 자신의 `list_apps`로 앱을 허용)로 데몬을 띄우고 exit 64를 manifest 거부로 표시한다, 무인 출처(`ComputerUseOrigin.ts`)는 `computer_use.grant` 승인 handoff(시계 만료, 승인 뒤 cancelled로 조기 종료, 호스트당 하나, `settings:write`)가 있을 때만 `cua-lease-proxy` 하위 명령을 받는다, Codex·Claude는 lease 없는 무인 턴에서 사용자 `cua-driver`를 끈다. upstream이 부착 경로를 바꾸면 `ComputerUseAttachment.ts`의 `leased`·`cuaDriverBlocked` 분기를 다시 얹는다.

### `delegated-tasks` 사이드바 위임 작업, 승격, launch 계보

- 커밋: #33
- 경로: `apps/web/src/components/{Sidebar.tsx,Sidebar.logic.ts,Sidebar.drag.ts,promoteThread.ts,CommandPalette.tsx,threadActionMenu.logic.ts}`, `apps/web/src/components/sidebar/{SidebarOpenSubagent.tsx,subagentIndex.ts}`, `apps/web/src/components/chat/{ChatHeader.tsx,ThreadRelationshipsControl.tsx,threadLauncher.logic.ts}`, `apps/server/src/orchestration-v2/{Orchestrator.ts,ThreadManagementService.ts,ThreadLaunchService.ts,ThreadForkService.ts,ProjectionStore.ts}`, `apps/server/src/mcp/{OrchestratorMcpService.ts,AcpMcpStdioBridge.ts,toolkits/{project,ssh,orchestrator}}`, `apps/server/src/sshRemote/SshRemoteDispatch.ts`, `packages/contracts/src/{orchestrationV2.ts,environment.ts}`, `packages/client-runtime/src/{operations/commands.ts,state/threadCommands.ts,state/threadRelationships.ts}`, `packages/provider-core/src/server/subagentProjection.ts`
- 정책: GOAT 전용 계약 필드(`launchedBy`, subagent `promotedAt`, `thread.stop.stopCascadeFrom`), 명령 `thread.promote`, capability `threadPromotion`. 마이그레이션 없음(`payload_json`). upstream이 같은 이름이나 계보 변경 명령을 들이면 카드로 결정한다. upstream의 사이드바, Orchestrator, fork/subagent builder 변경은 받고 이 동작을 다시 얹는다. 머지 때 확인할 것: Orchestrator의 "계보는 분리만 일어난다" 가정(`appOwnedSubagentParentThreadId`), 연쇄 Stop의 조상 확인, fork·subagent builder의 `launchedBy` 제거. 다른 스레드 agent의 send는 요청 mode와 상관없이 `steer_when_ready`다(`threadSendMode`). upstream 테스트가 agent의 `mode: "queue"` send로 대기 turn을 만들면 GOAT에서는 steer가 되므로 그 테스트는 다른 경로로 옮긴다 (사이클 261020, #555; 사이클 261021 #19759 "reports $label child results"도 같음).

### `desktop-identity` 데스크톱 정체성

- 커밋: `b79ff462c`
- 경로: `apps/desktop/src/app`, `scripts/build-desktop-artifact.ts`, `.github/workflows/release-desktop.yml`
- 정책: 앱 id, userData, 업데이트 피드는 GOAT 유지. 안정판 라벨 `Alpha`도 유지한다. 라벨이 Electron 런타임 이름과 safeStorage 키를 정한다 (사이클 261019). release workflow의 upstream 변경은 손으로 옮긴다. `release-desktop.yml`은 upstream 호출부(`release.yml`)와 GOAT 호출부(`desktop-macos-preview-publish.yml`)가 넘기는 입력을 모두 받는다: upstream `verify_runner`, GOAT `ssh_runtime_bundle`·`mac_passkeys` (사이클 261021).

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
- 정책: upstream 로직을 받고 도구 이름은 `goat_*`, 서버 이름은 GOAT로 다시 쓴다. 새 `t3_*` 도구는 이름을 바꾸고 표시용 legacy alias를 둔다. 텔레메트리(`telemetry/ProviderDimensions.ts`, `McpHttpServer`의 HANDOFF_TOOLS)도 `goat_*` 이름으로 세고, 들어온 `t3_*`는 `goat_*`로 정규화한다 (사이클 261020). 새 Prometheus 메트릭도 `goat_*`(`goat_process_group_*`, 사이클 261021). 도구 설명은 toolkit 파일이 아니라 `packages/contracts/src/agentSurface/registry.ts`에 있으므로 upstream 설명 변경은 거기로 옮긴다.

### `no-t3-import` T3 불러오기 제거

- 커밋: `59d7fe1a6`
- 경로: `ProjectScriptsControl.tsx`, `settings/ProjectActionsSettings.tsx`, `chat/ThreadDetailsPanel.tsx`, `hooks/useT3ProjectFileScripts.ts`
- 정책: t3.json 액션 가져오기 메뉴("Import scripts", "From t3.json")는 다시 들이지 않는다. 같은 파일의 다른 upstream 변경은 받는다. upstream이 `ThreadDetailsPanel.test.tsx`를 고치면 삭제를 유지한다. t3.json 기본값, iconPath, 깨진 파일 경고, V1→V2 스레드 마이그레이션은 upstream 그대로다.

### `pdf-viewer` PDF.js 파일 뷰어

- 커밋: `3a13908a0`
- 경로: `apps/web/src/components/files/pdf`, `apps/web/src/components/files/BrowserDocumentFrame.tsx`, `third-party-licenses.config.json`의 PDF.js·Synara 항목
- 정책: 파일 미리보기의 PDF는 GOAT PDF.js 뷰어(페이지 이동, 확대, 검색)로 보인다. upstream이 브라우저 미리보기 PDF를 native `<embed>`로 보내는 변경(#21095)은 라우팅만 받고 `BrowserDocumentFrame`은 GOAT 뷰어를 유지한다. 어느 쪽으로 갈지는 #515에서 정한다.

### `remote-reports` 원격 보고와 원격 위임

- 커밋: #5 #10 #6
- 경로: `apps/server/src/remoteReports`, `apps/server/src/mcp/toolkits/{remoteReport,ssh}`, `apps/server/src/persistence/Migrations/*_{RemoteReports,RemoteDispatches}*`, `packages/contracts/src/remoteReports.ts`
- 정책: GOAT 전용. RemoteReports·RemoteDispatches 마이그레이션은 다시 실행해도 안전하게 써서(`IF NOT EXISTS`) upstream이 그 id를 가져가면 옮길 수 있다. upstream의 SSH·MCP 변경은 받고 출발지 보고, 원격 위임, 첨부 전달을 다시 얹는다.

### `repo-hygiene` 저장소 루트 정리

- 커밋: #661
- 경로: `.agents/skills/test-goat-{app,mobile}`, `goat.json`, `.cursor/` (삭제), `pr-assets/` (삭제), `scripts/lib/goat-rename/rules.ts`
- 정책: upstream의 `.agents/skills/test-t3-{app,mobile}`과 루트 `t3.json`은 `goat-rename --apply`의 경로 규칙이 `test-goat-*`, `goat.json`으로 옮기고, 본문의 스킬 이름도 바꾼다(테스트 픽스처의 샘플 이름은 upstream 그대로). upstream `.cursor/`는 drop 규칙이 지운다. upstream 체크아웃에 `--apply --root`를 먼저 돌리면 충돌이 없고, 원본을 바로 머지했다면 머지 뒤 `--apply`가 modify/delete 충돌을 같은 결과로 정리한다. `--check`는 되살아난 drop 경로를 잡는다. 결정과 이유: `devlog/_plan/261021_repo_hygiene.md`.

### `server-activity` 서버 activity와 마이그레이션 61

- 커밋: `c96310a1a` `d18f83e4e`
- 경로: `apps/server/src/persistence/Migrations*`, `ProjectionStore.ts`, `apps/server/src/http.ts`, `packages/contracts/src/environment*`
- 정책: 아래 마이그레이션 규칙.

### `ssh-runtime` SSH 런타임 공급과 원격 디스패치

- 커밋: `aa2eaf2ff` `480ed90da` `b32fe81d1` `b6a829960` `716f27dac`
- 경로: `packages/ssh/src/tunnel.ts`, `apps/server/src/sshRemote`, `apps/server/src/mcp/toolkits/ssh`, `apps/desktop/src/ssh`
- 정책: GOAT가 `tunnel.ts`를 크게 다시 썼다. upstream ssh 변경은 의도를 GOAT 코드에 손으로 옮긴다. 충돌 위험이 가장 높다. upstream의 설치 lock 수정(#20059, uutils mkdir)은 GOAT lock이 rename으로 게시해 해당 없으므로 받지 않았다 (사이클 261020).

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
- GOAT 마이그레이션은 upstream 마이그레이션 뒤에 둔다. upstream이 그 id를 가져가면 GOAT 항목을
  뒤로 밀고 파일 번호도 바꾼다. 이미 옛 id를 기록한 DB는 `reconcileGoatMigrationIds`가 migrator
  앞에서 고친다: 건너뛰게 된 upstream 마이그레이션을 실행하고 GOAT 기록을 새 id로 옮긴다. 새 GOAT
  마이그레이션은 이름을 `GOAT_MIGRATION_NAMES`에 더한다 (사이클 261013, 10.002). upstream의
  `assertV2MigrationsCanRun`은 옛 GOAT id를 건너뛴 upstream 마이그레이션으로 읽으므로 reconcile이 그보다
  먼저 돈다 (사이클 261014). Memory 마이그레이션도 같은 방식으로 옮긴다. `assertMemoryMigrationsCompatible`는 GOAT 행의 간격이 하나가 아니거나, Memory 앞의 GOAT 마이그레이션이 비었거나, 모르는 Memory 이름이 있을 때만 거부한다 (사이클 261019).
- upstream이 `migrationEntries` export를 지워도 GOAT 원장 테스트가 쓰므로 유지한다 (사이클 261021, 065-067 → GOAT 068-094).
- 사이클 스캔에서 id가 겹치면 위 방식으로 옮긴다. 옮길 수 없는 경우만 `⛔` 카드로 결정한다.

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
