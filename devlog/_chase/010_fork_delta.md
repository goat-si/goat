# 010 — GOAT 의도적 분기 레지스트리

> 기준: fork point `de49d637d` 이후 GOAT dev `f4b6c14e5`의 44커밋 (devlog 제외 378파일)

upstream 머지에서 충돌이나 의미 회귀를 만드는 것은 아래 영역이다. 새 GOAT 기능이 upstream 파일을
바꾸면 이 표에 영역을 추가하거나 기존 행을 고친다. 충돌이 이 표의 정책으로 풀리지 않으면 카드를
만든다.

## 영역

| ID  | 영역                            | 대표 커밋                                                   | 주로 바뀐 경로                                                                                                                        | 충돌 정책                                                                                                                                                                                                                                                                               |
| --- | ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | 브랜드                          | `cc1ba0550` `8f36aefa3`                                     | `apps/web/src/components`, `apps/web/src/assets`, `apps/desktop/src/app`, `apps/desktop/src/window`, `assets/prod`                    | 보이는 이름, 마크, 아이콘은 GOAT 유지. 같은 컴포넌트의 upstream 로직 변경은 받는다.                                                                                                                                                                                                     |
| G2  | 글로벌 에이전트                 | `f391710d2` `0dc31be25` `83d1ebbd0` `6bebb0699`             | `apps/web/src/globalAgent*.ts`, `Sidebar.tsx`, `ChatView.tsx`, 헤더와 메뉴 컴포넌트                                                   | `globalAgent*` 파일은 GOAT 전용이다. 공유 컴포넌트는 upstream을 받고 글로벌 에이전트 분기를 다시 얹는다.                                                                                                                                                                                |
| G3  | MCP 이름 `goat_*`               | `e893682a4` `7a7a16584` `4dee8b21c`                         | `apps/server/src/mcp/toolkits/*/tools.ts`, `orchestration-v2`, `packages/provider-*/src/server`, `t3McpToolPresentation.ts`           | upstream 로직을 받고 도구 이름은 `goat_*`, 서버 이름은 GOAT로 다시 쓴다. 새 `t3_*` 도구는 이름을 바꾸고 표시용 legacy alias를 둔다.                                                                                                                                                     |
| G4  | CLI `goat`와 `~/.goat`          | `ddb93f2b5` `d85eb9aff`                                     | `apps/server/src/cli`, `apps/server/src/cloud`, `apps/desktop/src/wsl`, `scripts/install.sh`                                          | upstream 로직을 받고 실행 파일 `goat`, `runtime/goat/versions`, SSH 호스트 `~/.goat`를 유지한다.                                                                                                                                                                                        |
| G5  | 데스크톱 정체성                 | `b79ff462c`                                                 | `apps/desktop/src/app`, `scripts/build-desktop-artifact.ts`, `.github/workflows/release-desktop.yml`                                  | 앱 id, userData, 업데이트 피드는 GOAT 유지. release workflow의 upstream 변경은 손으로 옮긴다.                                                                                                                                                                                           |
| G6  | SSH 런타임 공급과 원격 디스패치 | `aa2eaf2ff` `480ed90da` `b32fe81d1` `b6a829960` `716f27dac` | `packages/ssh/src/tunnel.ts`, `apps/server/src/sshRemote`, `apps/server/src/mcp/toolkits/ssh`, `apps/desktop/src/ssh`                 | GOAT가 `tunnel.ts`를 크게 다시 썼다. upstream ssh 변경은 의도를 GOAT 코드에 손으로 옮긴다. 충돌 위험이 가장 높다.                                                                                                                                                                       |
| G7  | 서버 activity와 마이그레이션 61 | `c96310a1a` `d18f83e4e`                                     | `apps/server/src/persistence/Migrations*`, `ProjectionStore.ts`, `apps/server/src/http.ts`, `packages/contracts/src/environment*`     | 아래 마이그레이션 규칙.                                                                                                                                                                                                                                                                 |
| G8  | CI                              | `bfce4301d` `cc5003979` `095115376`                         | `.github/workflows/goat-ci.yml`, `.vite-hooks/`, `packages/ssh/src/tunnel.*.test.ts`                                                  | GOAT CI는 EPYC의 goat-ci 하나이고 upstream workflow는 goat-si/goat에서 모두 비활성이다. `tunnel.test.ts`는 여러 파일로 나뉘었다.                                                                                                                                                        |
| G9  | 컴포저 푸터                     | `bb13f89b5` `a122f433a` `f4b6c14e5`                         | `apps/web/src/components/chat`, `apps/web/src/index.css`                                                                              | 레이아웃은 GOAT, 컴포저 동작은 upstream.                                                                                                                                                                                                                                                |
| G10 | 링크로 시작한 스레드 최대화     | `ef4748eb7`                                                 | `apps/web/src/components`                                                                                                             | upstream 우선, GOAT 동작만 다시 얹는다.                                                                                                                                                                                                                                                 |
| G11 | devlog                          | `24d4ee846` `37073207d`                                     | `devlog/`                                                                                                                             | GOAT 전용, 충돌 없음.                                                                                                                                                                                                                                                                   |
| G12 | T3 불러오기 제거                | `195bad968`                                                 | `ProjectScriptsControl.tsx`, `settings/ProjectActionsSettings.tsx`, `chat/ThreadDetailsPanel.tsx`, `hooks/useT3ProjectFileScripts.ts` | t3.json 액션 가져오기 메뉴("Import scripts", "From t3.json")는 다시 들이지 않는다. 같은 파일의 다른 upstream 변경은 받는다. upstream이 `ThreadDetailsPanel.test.tsx`를 고치면 삭제를 유지한다. t3.json 기본값, iconPath, 깨진 파일 경고, V1→V2 스레드 마이그레이션은 upstream 그대로다. |

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

| 대상               | upstream               | GOAT                                    |
| ------------------ | ---------------------- | --------------------------------------- |
| MCP 도구           | `t3_*`                 | `goat_*` (`t3_*`는 표시용 legacy alias) |
| MCP 서버 표시 이름 | T3 Code                | GOAT                                    |
| provider 등록 키   | `t3-code`              | `t3-code` (그대로)                      |
| MCP env            | `T3_MCP_URL` 등        | 그대로                                  |
| CLI 실행 파일      | `t3`                   | `goat` (npm 패키지 `t3`, bin 둘)        |
| SSH 호스트 홈      | `~/.t3`                | `~/.goat`                               |
| 런타임 디렉터리    | `runtime/.../versions` | `runtime/goat/versions`                 |
