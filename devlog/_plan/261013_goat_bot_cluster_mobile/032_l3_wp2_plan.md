# 032 — L3 wp2 diff 계획: 가용성 이동 + 모바일 봇 홈

> wp1 결론(D, 2026-10-13): client-runtime 공유 모듈(`740d0a5d5`)과 모바일 봇 화면·모드(`9551f8a8f`)가 dev에 들어갔다. 모바일은 임시 규칙(저장된 봇 → 라벨 순 첫 지원 서버)으로 봇 환경을 고른다. 방향: L1의 웹 커밋(`637e0669d`, `7b8ea1dc7`)이 들어왔으므로 가용성을 옮기고 모바일을 클러스터 홈에 붙인다.

## 왜 모바일도 주장·복제를 하는가

홈 해석만 읽으면, 아직 주장이 없는 클러스터에서 모바일은 홈 없이 ensure를 하게 되고 서버는 미지정 상태라 받아들인다. 나중에 웹이 다른 서버를 홈으로 주장하면 봇이 둘이 된다. 그래서 모바일도 웹과 같은 상태기계(후보 주장, 연결된 쓰기 가능한 서버에 기록, 정본과 다른 서버에 재기록, 홈 서버 자신의 readback 뒤에만 ensure)를 돌린다. 이 상태기계는 지금 웹 `useGoatBotHome` 훅의 ref들 안에 있으므로 client-runtime 컨트롤러로 뺀다.

## A. 가용성 이동 (쓰기: `packages/client-runtime/src/goatBot/*`, `apps/web/src/components/goatBot/*`, `apps/web/src/components/settings/GoatBotSettings.tsx`)

- `apps/web/src/components/goatBot/goatBotAvailability.ts`(+ test) → `packages/client-runtime/src/goatBot/availability.ts`(+ test). 내용 그대로, 상대 import는 `.ts`.
- wp1의 임시 `types.ts` 삭제: `GoatBotRef`, `GoatBotEnsureState`는 `availability.ts` 하나가 정의하고 `ensure.ts`, `sendQueue.ts`, `index.ts`가 거기서 가져온다.
- 웹의 모든 `./goatBotAvailability` import를 `@t3tools/client-runtime/goatBot`으로.

## B. 홈 동기화 컨트롤러 (쓰기: `packages/client-runtime/src/goatBot/homeSync.ts`(+ test), `apps/web/src/components/goatBot/useGoatBotHome.ts`)

- `createGoatBotHomeSync({ now, randomId, onSettled })`: 지금 `useGoatBotHome`의 ref 상태(attempts, inFlight, observedMax, pendingClaim, previousClaimId, connected, awaitingReadback, snapshots)와 effect 본문을 그대로 옮긴 객체. `update({ targets, resolution, candidateId, writableIds, write }) → { nextWakeAt: number | null }`(write는 매번 최신), `setActive(boolean)`(감사 3). 쓰기가 끝나면 활성일 때만 `onSettled()`로 깨운다.
- 웹 `useGoatBotHome`은 컨트롤러를 한 번 만들고 effect에서 `setActive(true)`/정리에서 `setActive(false)`, `update`, `nextWakeAt` 타이머, `onSettled`로 `wake`. `useGoatBotHomeSettings`는 그대로. 동작 동일: 기존 `useGoatBotHome.test.tsx`가 바뀌지 않고 통과해야 한다.
- `homeSync.test.ts`: 미주장 + 쓰기 가능한 후보면 한 번 주장해 연결된 지원 서버에 쓴다, 후보가 쓰기 불가면 주장하지 않는다, 정본과 다른 서버에 재기록하고 실패는 백오프, readback 대기 중에는 다시 쓰지 않는다, 비활성 중 완료는 깨우지 않는다. 웹 훅 Strict Mode 테스트 하나(감사 3).

## C. 모바일 (쓰기: `apps/mobile/src/features/goat-bot/*`, `apps/mobile/src/features/settings/*` 새 화면, `apps/mobile/src/Stack.tsx`, `SettingsRouteScreen.tsx`)

1. `useMobileGoatBotEnvironments()`: 웹 `useGoatBotEnvironments`와 같은 `GoatBotEnvironmentInput[]`(primary는 항상 false, label은 서버 라벨 → 저장된 연결 라벨 → id, `settingsSnapshot`, `homeTarget`).
2. `useMobileGoatBotHome()`: `ThreadOutboxDrainWorker` 옆 null 렌더 워커로 한 번 마운트(감사 5). 컨트롤러에 모바일 `serverEnvironment.updateSettings`(`{ patch: { goatBotHome } }`)와 `AuthSettingsWriteScope` 기준 `writableIds`(감사 1)를 준다. UUID는 `uuidv4`. 홈 기능이 없는 클러스터(`supported=false`)면 아무것도 하지 않는다. 워커 마운트·정리를 다루는 집중 테스트 하나, 실제 포그라운드·내비게이션은 기기 확인으로 남긴다.
3. 세션: `pickMobileGoatBotEnvironment`를 client-runtime `pickGoatBotEnvironment` + `resolveGoatBotAvailability`로 바꾼다(botRef = 저장된 `goatBotRef`). ensure는 `!supported || goatBotHomeReadBack(home)`일 때만. 연결 세대 키에 홈 키(`environmentId:claimedAt:claimId` 또는 상태)를 넣는다. `not_home` 응답은 웹처럼 홈 키나 설정 스냅샷이 바뀔 때까지 다시 묻지 않는다. wp1의 늦은 응답 보호(`mobileGoatBotEnsure`)는 유지.
4. 화면: `home_offline` 배너 "GOAT Bot은 <기기>에서 돌아갑니다. 그 기기가 연결되면 이어집니다". 스위치 표시 조건에 "홈이 주장돼 있음"을 더한다.
5. 설정: Settings 목록에 "GOAT Bot" 항목 → 새 화면에서 지원 서버 목록과 현재 홈 표시, 다른 서버를 고르면 웹 `GoatBotSettings`처럼 `newGoatBotHomeClaim`(observedMax = 현재 정본)을 쓰기 가능한 연결 서버 모두에 쓴다. 홈 기능이 없으면 항목을 숨긴다.

## 검증

- client-runtime: `vp test run packages/client-runtime/src/goatBot`(availability, homeSync 포함), tsc.
- 웹: `vp test run src/components/goatBot src/components/settings`(apps/web), tsc. `useGoatBotHome.test.tsx`·`useGoatBotSession.test.tsx` 무수정 통과.
- 모바일: goat-bot 테스트(홈 환경 입력 구성, 세션 홈 키·not_home 대기 순수 도우미), tsc, `expo export --platform ios`.
- 변경 파일 lint/fmt. 독립 리뷰. 실기 확인은 이 세션에 T3 Device 도구가 없어 막힘으로 남긴다(조정자의 TestFlight 빌드에서 확인).

## 감사 반영 (2026-10-13, gpt-6.1-sol 1차 FAIL)

1. **쓰기 권한.** `serverUpdateSettings`는 `clientRpcPermissions.ts`에 범위가 없어 `permissionAtom`이 항상 true다. 모바일 `writableIds`는 웹과 같이 `useEnvironmentsWithScope(…, AuthSettingsWriteScope)`로 만들고, 쓰기 직전 `readEnvironmentScope(environmentId, AuthSettingsWriteScope)`를 다시 확인한다. 모바일에 같은 도우미가 없으면 모바일 세션 상태에서 같은 판정을 만든다.
2. **최신 write.** 컨트롤러는 생성 때 `write`를 고정하지 않는다. `update({ targets, resolution, candidateId, writableIds, write })`가 매번 최신 `write`를 받고, 시작한 쓰기는 그때의 `write`로 끝난다. 초기 빈 목록 → 로드, 재연결, 권한 회수 테스트.
3. **수명.** 종료형 `dispose()` 대신 웹의 `alive` ref와 같은 `setActive(boolean)`: effect 설정에서 true, 정리에서 false, 다시 설정되면 true. 비활성 중에 끝난 쓰기는 기록은 하되 깨우지 않는다(웹과 동일). React Strict Mode(설정-정리-설정)에서 지연된 쓰기로 중복 주장 없음, 늦은 완료 무시, 재시도 깨움, 타이머 정리를 테스트한다.
4. **세션 키 하나.** 모바일 세션의 연결 키 생성은 한 함수(`goatBotSessionKey({ environmentId, generation, homeKey })`)만 쓰고, 정착할 때 현재 홈 키와 연결 세대를 함께 확인한다(`not_home` 포함). 대기 중 승자가 바뀌는 경우, 수동 재시도 억제를 테스트한다.
5. **마운트·수명주기.** 홈 동기화는 `ThreadOutboxDrainWorker` 옆의 null 렌더 워커로 한 번만 마운트한다(루트 재렌더 없음). 백그라운드→포그라운드 재연결(`connection/platform.ts`) 뒤 백오프·진행 중 쓰기가 이어지는지, 설정에서 A→B→A 변경과 일부 실패를 순수 도우미 테스트로 확인한다.
