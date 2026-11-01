# 001 — 조사: 한 기기에 GOAT 환경이 둘로 갈리는 이유

> 기준: origin/dev `390b9fd42`. 조사 레인 gpt-6.1-sol 5개(데스크톱 백엔드, SSH 런처, 영속화, 인증, 릴리스 브랜치)와 이 기기(Mac Studio)의 읽기 전용 실측.

## 실측 (2026-10-12, Mac Studio, 읽기 전용)

| 서버                                                                                                                        | 프로세스                     | 포트                        | 상태 디렉터리              | 스레드 / 프로젝트 / auth_sessions |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------- | -------------------------- | --------------------------------- |
| 데스크톱 `GOAT (Nightly).app`                                                                                               | Electron, `--bootstrap-fd 3` | 3773                        | `~/.goat/desktop/userdata` | 0 / 1 / 1                         |
| SSH 런타임 `~/.goat/runtime/goat/versions/0.0.45/goat serve --host 127.0.0.1 --port 3774 --base-dir ~/.goat` (부모 launchd) | 3774                         | `~/.goat/userdata` (230 MB) | 72 / 5 / 8                 |

두 `server-runtime.json`은 모두 `serverVersion 0.0.45`, `sshRuntimeProtocolVersion 1`, `orchestrationProtocolVersion 2`다. 이 기기에서 실제 작업은 SSH 런타임 DB에 쌓이고, 앞에 앉은 사람이 여는 데스크톱 DB는 거의 비어 있다. 이슈 #1의 juns-macbook-pro와 같은 모양이다.

## 원인: 집이 둘이다

1. 패키지 데스크톱의 기본 홈은 `~/.goat/desktop`이다. `apps/desktop/src/app/DesktopStatePaths.ts:22` — `input.joinPath(input.homeDirectory, ".goat", "desktop")`. 이 분리는 어제 `b79ff462c`(D9, `devlog/_fin/261011_goat-ssh-runtime-supply/000_plan.md:27` "SSH-host state stays ~/.goat")에서 upstream `~/.t3`와 충돌하지 않으려고 들어왔다. upstream과의 분리는 `~/.goat`만으로 이미 이뤄지고, `/desktop` 하위 폴더가 만든 것은 같은 기기 안의 두 번째 환경이다.
2. CLI와 SSH 런타임의 기본 홈은 `~/.goat`다. 원격 런처는 `packages/ssh/src/tunnel.ts:1104-1105` `DEFAULT_SERVER_HOME="$HOME/.goat"`, `:824`와 `:1598`에서 `$HOME/.goat/userdata/server-runtime.json`만 본다. 런타임은 `:1248` `serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME"`로 뜬다.
3. 그래서 데스크톱이 떠 있어도 런처는 그 서버를 찾지 못하고 `~/.goat`에 두 번째 서버를 띄운다. `goat_ssh_thread_launch`로 만든 스레드는 그 DB에만 생긴다.

## 같은 홈만으로는 부족한 이유

### 한 DB에 서버 둘은 안전하지 않다

- SQLite 설정은 여러 프로세스를 허용한다(`apps/server/src/persistence/Sqlite.ts:18-21` WAL, `busy_timeout = 5000`). CLI가 서버 실행 중에 auth 행을 쓰는 것은 의도된 사용이다.
- 하지만 서버 시작 시 복구가 다른 프로세스의 작업을 취소하거나 다시 돌린다. `apps/server/src/orchestration-v2/EffectOutbox.ts:503` `WHERE status IN ('pending', 'running')`, `:516` `WHERE status = 'running'`, 호출은 `apps/server/src/serverRuntimeStartup.ts:518`.
- 실시간 이벤트는 프로세스 안 PubSub이다(`apps/server/src/persistence/OrchestrationEventStore.ts:298`). 다른 서버가 쓴 이벤트는 화면에 오지 않는다.
- 수명 잠금이 없다. `apps/server/src/cli/config.ts:333-335` "Lifetime locking and supervisor handoff are separate; this preflight cannot arbitrate two starts", 사전 검사도 `mode === "web"`과 `rejectRunningServer`일 때만 돈다. `serve`는 이 검사를 켜지 않는다(`apps/server/src/cli/server.ts:65-68`).
- 종료할 때 `server-runtime.json`을 PID 확인 없이 지운다(`apps/server/src/serverRuntimeState.ts:102` `fs.remove(path, { force: true })`). 두 서버가 같은 파일을 쓰면 늦게 끝난 쪽이 살아 있는 쪽의 기록을 지운다.

결론: 홈을 합치려면 userdata당 서버 하나를 강제하는 잠금이 먼저 있어야 한다.

### 데스크톱은 외부 서버에 붙을 수 없다

- 데스크톱은 백엔드를 직접 띄우고(`apps/desktop/src/app/DesktopApp.ts:254` `primaryBackend.start`), fd 3으로 부트스트랩(홈, 회전 토큰 비밀), fd 4-7로 텔레메트리와 브라우저 채널을 넘긴다(`apps/desktop/src/backend/DesktopBackendConfiguration.ts:563-598`). 이 fd가 없으면 미리보기 브라우저와 앱 업데이트 연동이 꺼진다(`apps/server/src/preview/DesktopBrowserChannel.ts:83-85`, `apps/server/src/desktopUpdate/DesktopAppUpdate.ts:71`).
- 기존 서버에 붙는 모드는 없다. `localEnvironmentEnabled=false`로 원격 환경만 쓰는 모드가 있을 뿐이다(`DesktopApp.ts:193-198`).

결론: 데스크톱이 열릴 때 같은 홈에 SSH 런타임이 떠 있으면, 데스크톱이 붙는 것이 아니라 그 런타임을 (유휴일 때) 내리고 자기 백엔드를 띄워야 한다.

### 런처는 다른 릴리스의 살아 있는 서버를 재사용하지 못한다

- 프로브는 살아 있는 서버의 버전과 같은 런타임 바이너리가 `~/.goat/runtime/goat/versions/<v>`에 설치돼 있어야 그 서버를 호환으로 본다(`packages/ssh/src/tunnel.ts:1660-1661`, `:1756-1763` `probe.liveBinarySignals !== undefined`). 데스크톱 서버의 버전(예: `0.0.45-nightly.20261011.3`)은 보통 설치돼 있지 않다.
- 실행 스크립트의 `check_live_protocol`은 선택한 버전과 살아 있는 서버의 버전이 같아야 `LIVE_COMPATIBLE=1`이다(`tunnel.ts:741-743`). 버전이 다르고 SSH 소유가 아니면 "compatibility changed" 오류로 끝난다(`:1220-1221`).

결론: 외부(데스크톱) 서버는 프로토콜 정수 두 개가 같으면 버전과 설치 바이너리에 관계없이 재사용해야 한다. 이미 `REMOTE_MANAGED=external` 경로(`:1164-1169`)가 있어 수명은 건드리지 않는다.

### 인증은 서버가 읽는 DB와 키에 묶여 있다

- 세션 토큰은 `<userdata>/secrets/server-signing-key.bin`으로 서명하고 `auth_sessions` 행이 있어야 통과한다(`apps/server/src/auth/SessionStore.ts:431,498,809-811,842`). 다른 홈에서 발급한 토큰은 무효다.
- SSH 디스패치는 `goat pair`가 아니라 원격 CLI로 mcp-client 세션을 직접 발급한다(`tunnel.ts:1306` `auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject mcp-client ...`). 토큰은 로컬 메모리에만 12시간 캐시하고(`apps/server/src/sshRemote/SshRemoteDispatch.ts:182-184,322,417`), 401이면 버린다(`:459`).
- 브라우저 페어링도 원격 CLI `auth pairing create --base-dir`다(`tunnel.ts:1285`). 서버는 데스크톱 모드에서도 페어링 토큰을 받는다(`apps/server/src/auth/EnvironmentAuth.ts:830,875`).
- 원격 CLI는 `~/.goat/runtime`의 런타임 바이너리다. 붙은 서버가 데스크톱이면 다른 버전의 CLI가 그 서버의 DB를 연다. 더 새 CLI가 더 옛 서버의 DB에 마이그레이션을 걸 수 있다.

결론: 홈이 하나면 발급 위치(`--base-dir`)는 저절로 맞는다. 남는 것은 (1) 발급에 쓰는 CLI가 서버와 같은 버전이어야 한다는 점, (2) 서버가 바뀌면 로컬 캐시가 401로 한 번 갱신된다는 점이다. (2)는 이미 동작한다.

### 기존 데이터 병합

- 프로젝트와 스레드 id는 무작위다(`apps/server/src/mcp/toolkits/project/handlers.ts:92,296`, `packages/provider-core/src/server/IdAllocator.ts:243`). 두 DB 사이 id 충돌은 같은 스냅샷에서 복사된 경우에만 생긴다.
- 이벤트 로그 `orchestration_events`는 전역 `sequence`와 스트림별 `(aggregate_kind, stream_id, stream_version)` 유일성을 가진다(`apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts:9-10,27`). 병합은 이벤트를 새 전역 순번으로 붙이고 스트림 버전은 보존해야 한다.
- 작업공간 경로 유일성은 명령 처리에서만 강제된다(`apps/server/src/orchestration-v2/ProjectCommands.ts:137-139`). 같은 경로의 프로젝트가 양쪽에 있으면 하나로 매핑해야 한다.
- 명령 재생은 효과(provider 턴, 파일 작업)를 다시 일으킨다(`apps/server/src/orchestration-v2/EventSink.ts:558`). 병합은 이벤트 복사 + 프로젝션 재구성이어야 한다.
- 비슷한 도구였던 `import-desktop-home.ts`(`b79ff462c`)는 `59d7fe1a6`에서 지워졌다. `apps/server/scripts/migrate-dev-db.ts`는 대상 DB를 새로 만드는 필터 복제라서 병합에 그대로 쓸 수 없다.

## 릴리스 nightly 스레드와 겹치는 곳

`goat/release-nightly`(아직 dev 미병합)가 `tunnel.ts`의 같은 블록을 바꾼다: 공개 HTTPS 공급, 유휴 시 대기 교체(`"status":"pending"`), 원격 잠금 `$DEFAULT_SERVER_HOME/ssh-launch/replacement.lock`, 프로토콜 1001(`goat/release-nightly-protocol`). 050 문서 8절(D-8)은 "GOAT가 관리하지 않는 런타임은 바꾸지 않는다"고 정한다. 데스크톱 서버는 런처 입장에서 관리하지 않는 외부 서버이므로 이 규칙과 맞는다. 겹침 정리는 [000_plan.md](./000_plan.md)의 인터페이스 절에 있다.
