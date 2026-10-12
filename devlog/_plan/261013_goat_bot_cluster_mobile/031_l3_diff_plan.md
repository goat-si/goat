# 031 — L3 diff 계획: GOAT Bot 순수 로직 이동 + 모바일 봇 화면·모드

> [030](030_mobile_bot_mode.md)의 사이클 1(wp1) 실행 계획. 레인 세션 `01a130d2`, 브랜치 `goat/mobile-bot-mode`, 기준 `8e1642dee`.

## A. client-runtime으로 이동 (쓰기: `packages/client-runtime/src/goatBot/*`, `packages/client-runtime/package.json`, `apps/web/src/components/goatBot/*`)

| 새 파일                              | 출처                                                          | 바뀌는 점                                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goatBot/types.ts`                   | `goatBotAvailability.ts`의 `GoatBotRef`, `GoatBotEnsureState` | 같은 모양으로 새로 정의. 웹 `goatBotAvailability.ts`(L1 소유)는 이번 사이클에 손대지 않는다. 구조 타입이라 서로 호환된다. wp2에서 가용성을 옮길 때 하나로 합친다. |
| `goatBot/rows.ts` (+ `rows.test.ts`) | `goatBotRows.ts`                                              | 내용 그대로.                                                                                                                                                      |
| `goatBot/readers.ts` (+ test)        | `goatBotReaders.ts`                                           | import 경로만.                                                                                                                                                    |
| `goatBot/ensure.ts` (+ test)         | `goatBotEnsure.ts`                                            | 타입을 `./types.ts`에서.                                                                                                                                          |
| `goatBot/sendQueue.ts` (+ test)      | `goatBotSendQueue.ts`                                         | `~/lib/utils` `randomUUID` 의존 제거: `makeKey`가 필수 옵션. 웹은 `randomUUID`를 넘긴다.                                                                          |
| `goatBot/index.ts`                   | —                                                             | 위 모듈 재내보내기. `package.json` exports에 `"./goatBot"` 추가.                                                                                                  |

웹은 옮긴 네 파일과 테스트를 지우고 `useGoatBotSession.ts`, `GoatBotTaskChip.tsx`, `GoatBotChatView.tsx`, `GoatBotTimeline.tsx`의 import를 `@t3tools/client-runtime/goatBot`으로 바꾼다. 동작 변화 없음.

## B. 모바일 (쓰기: `apps/mobile/src/features/goat-bot/*`, `apps/mobile/src/state/channels.ts`, `apps/mobile/src/persistence/mobile-preferences.ts`, 홈 헤더·홈 라우트)

1. `state/channels.ts`: `createChannelEnvironmentAtoms(connectionAtomRuntime)` — 웹과 같은 명령 집합.
2. 환경설정: `mobile-preferences.ts`의 `Preferences`에 `homeMode?: "thread" | "bot"`, `goatBotRef?: { environmentId, projectId, threadId }`(서버가 확인한 봇 캐시). 정리 함수는 허용 값만 남긴다. 기본은 `thread`.
3. `features/goat-bot/goatBotHomeMode.ts`(순수): `effectiveHomeMode(preference, botSupported)` — 봇을 지원하는 연결 서버가 없으면 항상 `thread`, 스위치도 숨김. `pickMobileGoatBotEnvironment(environments, botRef)` — 알려진 봇의 환경, 아니면 채널을 지원하는 연결된 첫 환경(라벨 순, 결정적). wp2에서 L1의 홈 해석으로 바꾼다. 테스트 `goatBotHomeMode.test.ts`.
4. `features/goat-bot/useMobileGoatBotSession.ts`: 환경별 세션 저장소(모듈 상태 + `useSyncExternalStore`)에 client-runtime의 ensure 상태기계와 전송 큐. 연결 세대가 바뀌면 `syncGoatBotEnsure`, 화면이 보이고 연결·권한이 있을 때 `ensureBot` 한 번(레거시 글로벌 에이전트가 없으니 `candidateThreadId` 없음), 결과 봇을 `goatBotRef`로 저장. 전송은 `runAtomCommand(appAtomRegistry, channelEnvironment.ingest, …)` + `goatBotIngestInput`, 키는 `expo-crypto`/`crypto.randomUUID` 중 모바일에 있는 것. 권한은 `channelEnvironment.ingest.permissionAtom(environmentId)`. 턴 항목은 `useThreadVisibleTurnItems`(화면이 보일 때만 ref 전달, 숨으면 null) → `buildGoatBotTimeline`, `goatBotReplyingSince`, 큐 `acknowledge`.
5. `features/goat-bot/GoatBotScreen.tsx`: `LegendList`(키보드 대응 변형)로 행 렌더. 사용자 말풍선(오른쪽, 전송 상태·실패 시 다시 보내기), 봇 말풍선(왼쪽, 마크다운은 `SelectableMarkdownText` 또는 일반 텍스트), 질문 답 버튼(누르면 그 답을 전송), 작업 카드(상태·요약, 누르면 `Thread` 라우트로), 날짜 구분, 답장 중 표시(정적 점 세 개, 반복 애니메이션 없음). 가용성 배너: 미지원/오프라인/연결 중/legacy_active/오류(다시 시도). 아래 작성란은 높이가 늘어나는 `TextInput` + 보내기 버튼, 보낼 수 없으면 비활성.
6. 홈: `HomeRouteScreen`이 실효 모드가 `bot`이면 스레드 목록 대신 `GoatBotScreen`을 그리고 헤더 제목을 GOAT Bot으로. 모드 버튼은 iOS `HomeHeader.tsx`의 오른쪽 항목 두 분기와 Android `MaterialThreadListToolbar`에 하나씩, 봇 지원이 있을 때만. 누르면 `homeMode`를 저장.

## 검증

- `vp test run packages/client-runtime/src/goatBot` (옮긴 테스트 4개), `vp test run apps/mobile/src/features/goat-bot`, 웹 goatBot 남은 테스트(`goatBotAvailability.test.ts`, `useGoatBotSession.test.tsx`, `GoatBotComposer.test.tsx`).
- typecheck: client-runtime(`tsc --noEmit`), web, mobile. 변경 파일 `vp lint`, `vp fmt --check`.
- iOS 시뮬레이터 실기 확인 필수(감사 7).

## 범위 밖 / 다음 사이클

- wp2: `goatBotAvailability` 이동과 L1 홈 해석 연결(L1이 origin/dev에 들어간 뒤).
- 모바일 위젯·알림에 봇 메시지 노출, 봇 스레드 삭제·보관 복구 흐름(웹의 removal probe)은 이번 범위가 아니다. 봇 스레드가 사라지면 다시 ensure하는 정도만.

## 감사 반영 (2026-10-13, gpt-6.1-sol 1차 FAIL)

1. **배치(분할 화면).** 좁은 화면: 봇 모드면 Home 내용이 `GoatBotScreen`. 분할 화면(네이티브 iPad 주 열, 비네이티브 `AdaptiveWorkspaceLayout`): 주 열은 스레드 목록 그대로, 아무 스레드도 열리지 않은 상세 영역(`HomeRouteScreen`의 빈 상세, `WorkspaceEmptyDetail` 자리)이 봇 모드면 `GoatBotScreen`. 분할 화면에서 스레드를 연 상태로 봇 버튼을 누르면 상세를 비워(홈으로 돌아가) 봇이 보이게 한다. 구독은 실제로 보이는 열 기준. 태블릿 시뮬레이터 확인을 검증에 넣는다.
2. **모드와 연결 상태 분리.** 스위치 표시 조건은 "봇을 아는가": 저장된 `goatBotRef`가 있거나 어떤 환경의 `serverConfig`가 `channelLedger`를 알린 적 있음. 연결이 끊겨도 봇 모드는 유지되고 화면이 오프라인·연결 중 배너를 보인다. 캐시된 봇 환경이 오프라인이면 다른 연결 서버로 옮기지 않는다. 최종 홈 해석은 wp2에서 L1 함수로.
3. **import 확장자.** client-runtime은 NodeNext: 옮긴 모듈·테스트·index의 상대 import에 `.ts`.
4. **명령 결과.** `runAtomCommand`의 `Success | Failure`를 풀어 값만 쓰고, 실패는 ensure `failed`(서버 `legacy_active`는 그대로) 또는 큐 실패로, ingest `rejected` 영수증은 거절 사유로. 보내기 가능 여부는 ensure·ingest 권한 둘 다.
5. **봇 참조 타입.** 저장·ingest에는 `ChannelBotRef`(environmentId, projectId, threadId) 전체를 쓰고, 표시용 `GoatBotRef`와 분리한다.
6. **가시성·성능.** `useThreadVisibleTurnItems`에 숨김 시 `{ environmentId: null, threadId: null }`. 봇 모드(좁은 화면)에서는 Home의 스레드 목록 구독을 끈다. 타임라인은 `useMemo`(턴 항목·대기 입력 스냅샷 기준), 행 컴포넌트는 `memo`, 외부 저장소 스냅샷은 바뀔 때만 새 객체.
7. **영속·실기 검증.** 환경설정 저장→다시 읽기, 잘못된 `goatBotRef`(필드 누락·타입 오류) 정리 테스트. UUID는 모바일 `lib/uuid.ts` `uuidv4`. 목록은 `KeyboardAwareLegendList`. 헤더는 `HomeHeader.types.ts` 속성 추가와 Android 전달. 작업 카드 이동은 `home-thread-navigation.ts`의 선택 도우미 재사용. 실기 확인(test-t3-mobile, iPhone + iPad 시뮬레이터, 격리 상태)은 필수.
8. **네이티브 iPad 경로(2차 감사).** 네이티브 iOS 분할 화면의 빈 상세는 `features/layout/createWorkspaceStackNavigator.ios.tsx`의 `workspace-empty` 화면과 `WorkspaceEmptyDetail`이다(쓰기 범위에 포함). 봇 모드면 이 화면이 `GoatBotScreen`을 그린다. 구독 활성 조건은 `layout.usesSplitView && !activeDetailKey`와 실제 열 가시성. 봇 버튼으로 상세 스택을 비우는 동작도 이 경로에서 확인한다.
