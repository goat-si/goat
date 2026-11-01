# 010 — L1 bot-home: 클러스터당 GOAT Bot 하나

[000](000_plan.md) B1-B3. 레인 스레드가 P 단계에서 이 문서를 diff 수준 계획으로 확장한다.

## 현재

- 서버마다 owner별 봇이 하나다(`ChannelBotRegistry.ensure`, ledger `getBot`). 클러스터 개념이 없어 서버 셋이면 봇 셋.
- 웹은 클라이언트마다 `pickGoatBotEnvironment`(알려진 봇 → primary → 첫 지원 서버)로 고른다(`apps/web/src/components/goatBot/goatBotAvailability.ts`). 모바일·다른 데스크톱은 다른 서버를 고를 수 있다.
- Slack 런타임은 서버마다 `ChannelLayers`에서 뜬다. 같은 Slack 앱을 두 서버에 연결하면 소켓이 둘.
- 공유 설정: `packages/client-runtime/src/state/sharedSettings.ts` `SHARED_SERVER_SETTING_KEYS`, 계약은 `packages/contracts/src/settings.ts`.

## 할 일

1. 계약: `ServerSettings.goatBotHome: { environmentId, claimedAt, claimId } | null`(기본 null)와 patch 키. 서버 설정 저장은 이 키에 단조 병합을 적용한다(더 작은 `(claimedAt, claimId)` 쓰기는 무시). 공유 키 목록에 추가. `ChannelGatewayError.reason`에 `not_home`(+ `homeEnvironmentId`) 추가.
2. 서버: 홈 판정 서비스 메서드 하나(설정 홈 vs 자기 environmentId). `ensureBot`과 `kind: "goat"` 인입은 홈이 아니면 `not_home`. Slack 런타임은 홈이 아니면 연결하지 않고, 설정 변경 시 열고 닫는다(설정 스트림 구독). 미지정이면 지금과 같다.
3. client-runtime: 순수 함수 `resolveGoatBotHome({environments, sharedHome, knownBot})` → 환경 또는 "claim 필요". 웹(나중에 모바일)이 쓴다.
4. 웹: 가용성이 홈을 따른다. 미지정이면 고른 환경을 모든 동기화 대상에 기록(한 번). `not_home` 응답이면 홈으로 다시 해석. 설정(Integrations 또는 GOAT Bot 섹션)에 "GOAT Bot이 사는 곳" 선택과 현재 값. 바꾸기만 있고 해제는 없다. 홈 서버가 오프라인이면 "홈 오프라인" 상태(다른 서버로 몰래 옮기지 않음).
5. 문서: `docs/internals/channels.md`에 홈 규칙 한 절, `docs/user`에 설정 경로.

## 검증

- 서버: ChannelScenarios/ChannelAssembly에 홈 아님 거절, 미지정 하위 호환, 홈 변경 후 ensure 성공 테스트. Slack 런타임 홈 게이트 테스트.
- client-runtime: `resolveGoatBotHome`, 공유 키 분리 테스트.
- 웹: goatBotAvailability 테스트 갱신. web·server·contracts·client-runtime typecheck, 변경 파일 lint.

## 표면 점검(AGENTS.md)

진입점(사이드바, 로고, 설정, 커맨드 팔레트), 클라이언트(웹·데스크톱·모바일은 L3가 같은 함수 사용), 연결 모드(로컬·SSH·relay), 되돌리기(홈 변경·이전 홈으로 다시 변경), 에이전트(MCP channel_* 경로는 홈 판정을 우회하지 않음).

## 감사 반영 (000 B1-B3)

- 설정 값은 `{ environmentId, claimedAt, claimId }`이고 정본은 연결된 지원 서버들 중 `(claimedAt, claimId)` 최대. 같은 시각 주장, 순서가 뒤바뀐 쓰기(오래된 재동기화가 나중에 도착) 테스트 필수. 클라이언트는 연결·재연결마다 다른 값의 서버에 정본을 다시 쓴다. primary가 없는 호스티드·모바일 클라이언트도 같은 규칙.
- 서버 capability `goatBotHome: true`를 알리고, 미지원 서버에는 키를 쓰지 않는다. 미지원 서버는 홈 후보가 될 수 없다.
- 로드 전 상태는 unknown이다. claim 쓰기가 홈 서버에 반영되고 다시 읽은 정본이 같을 때만 ensure.
- 서버 게이트는 GOAT 인입과 MCP `channel_*` 프런트 데스크 인입 모두. 워커 보고·`channel_input_get`은 그대로. 오류 매핑(MCP 도구 결과, WS 오류) 테스트 포함.
- Slack 런타임은 설정 스트림을 구독해 홈이 되면 열고 홈이 아니게 되면 닫는다. 테스트로 확인.
- 보장 범위를 문서에 적는다: 연결된 서버들 사이에서 수렴, 오프라인 서버는 돌아오면 수렴.

## L1 diff 계획 (레인 세션 01a130d2, 기준 8e1642dee)

### wp1 — 계약, 서버 관문, 단조 병합

- `packages/contracts/src/settings.ts`: `GoatBotHomeClaim = Struct({ environmentId: EnvironmentId, claimedAt: NonNegativeInt(epoch ms), claimId: TrimmedNonEmptyString(max 64) })`. `ServerSettings.goatBotHome: NullOr(GoatBotHomeClaim)` 기본 null. `ServerSettingsPatch.goatBotHome: optionalKey(GoatBotHomeClaim)`(null 없음 = 해제 없음). 순수 도우미 `compareGoatBotHomeClaims(a, b)`(claimedAt, 그다음 claimId 사전순)와 `goatBotHomeClaimSupersedes(next, current)`.
- `packages/contracts/src/environment.ts`: `capabilities.goatBotHome: optionalKey(Boolean)`.
- `packages/contracts/src/channelGateway.ts`: 사유 `not_home`("GOAT Bot runs on another machine in this cluster."), 필드 `homeEnvironmentId: optionalKey(EnvironmentId)`.
- `packages/shared/src/serverSettings.ts` `applyServerSettingsPatch`: `goatBotHome`을 deepMerge에서 빼고, `goatBotHomeClaimSupersedes`일 때만 교체. 테스트: 큰 값 수용, 작은 값 무시, 같은 시각은 claimId로, 순서가 바뀐 두 쓰기의 결과가 같음.
- `apps/server/src/channels/ChannelBotHome.ts`(새 서비스): `requireHome: Effect<void, ChannelGatewayError>`(설정 홈이 null이거나 자기 environmentId면 통과, 아니면 `not_home` + homeEnvironmentId)와 순수 함수 `isGoatBotHome(home, environmentId)`. `ChannelLayers` 서비스 묶음에 제공.
- `ChannelBotRegistry.ensure`: 첫 줄에서 `requireHome`. `ChannelGateway.ingest`: `kind`가 goat 또는 mcp면 `checkCaller` 전에 `requireHome`. 워커 보고·`getInput`·Slack 인입은 그대로(Slack은 아래 런타임 관문으로 막힘).
- 오류 전달: WS ensure/ingest는 `ChannelRpcError`로 그대로 나간다. 봇 스레드 `message.dispatch`는 `OrchestrationV2DispatchCommandError`로 감싸므로 메시지에 홈 안내가 남는지만 확인. MCP `channel_ingest`의 `failureFor`는 `not_home`이면 code `not_home`과 홈 id를 메시지에 담는다.
- Slack: `slack/SlackChannelSettings.live.ts`의 런타임 적용을 홈일 때만(미지정 포함) 하고, 홈이 아니면 `stopRuntime`. 저장된 enabled는 바꾸지 않는다. 시작할 때 `subscribeChanges`를 먼저 잡고 스냅샷을 읽은 뒤, 홈 여부가 바뀔 때만 기존 설정 잠금 아래에서 연결을 다시 맞춘다.
- `ServerEnvironment` capability `goatBotHome: true`.
- 테스트: ChannelScenarios — 홈 null/자기/남 세 경우에 ensure, goat 인입, mcp 인입; 거절 때 입력이 생기지 않고 보고·읽기는 됨. Slack 관문 — 변경을 내보내는 설정 스텁으로 홈 이동 시 소켓 닫힘/다시 열림. 서버 typecheck, 변경 파일 lint/fmt.

### wp2 — client-runtime 해석기, 웹

- `packages/client-runtime/src/goatBot/home.ts`(+ package.json export): `resolveGoatBotHome({ targets: [{ environmentId, supportsHome, connected, settingsLoaded, home }] })` → `unknown` | `unclaimed` | `claimed`(claim, homeConnected, staleTargets). `newGoatBotHomeClaim(environmentId, now, random)`. 테스트: 로딩 중 unknown, 최대값 선택, 같은 시각, 미지원 대상 무시, stale 목록.
- `sharedSettings.ts`: `goatBotHome`을 공유 키에 넣고 `filterSharedServerPatch`가 `capabilities.goatBotHome` 없는 대상에서는 뺀다. 테스트.
- 웹 `goatBotHooks.ts`: 환경 입력에 `supportsHome`과 원시 홈 스냅샷(기본값 대체 금지). `goatBotAvailability.ts`: 정본 홈을 먼저 따르고, 홈이 오프라인이면 새 상태 `home_offline`, unknown이면 `connecting`. 정본이 없으면 기존 규칙으로 후보를 고른다.
- 웹 `useGoatBotSession.ts`: 정본 없음 → 후보로 claim을 모든 지원 대상에 쓰고, 다시 읽은 정본이 자기 claim일 때만 ensure. stale 대상이 있으면 정본을 다시 쓴다(연결마다 한 번). ensure가 `not_home`이면 실패 대신 재해석.
- 설정: Integrations에 "GOAT Bot" 섹션, "Runs on" 선택(지원하는 연결된 환경), 바꾸면 새 claim을 모든 대상에 쓴다. settingsSearch 항목.
- 문서: `docs/internals/channels.md` 홈 절(수렴 규칙, 일시적 이중 동작, Slack 관문), `docs/user` 설정 경로.
- 테스트: home.ts, sharedSettings, goatBotAvailability; web typecheck, 변경 파일 lint/fmt.

### L1 감사 1차 반영 (gpt-6.1-sol, FAIL)

- A1 파일 재적재(반박): `settings.json`을 손으로 고치거나 되돌리는 것은 관리자의 의도적 변경이고 디스크 값이 정본이다. 단조 병합은 RPC 쓰기(클라이언트 claim·재동기화)끼리의 경쟁만 막는다. 홈이 지워지면 클라이언트가 다시 claim하므로 결과는 다시 한 곳으로 수렴한다. 이 규칙을 channels.md에 적는다.
- A2 이미 저장된 입력: `ChannelReceptionService`가 입력의 접수를 시작할 때(184행 근처) 홈 여부를 다시 확인하고, 홈이 아니면 접수를 시작하지 않고 기존 실패 답(`kind: failure`, `inReplyToInputId`)으로 "GOAT Bot이 다른 기기로 옮겨졌다, 거기서 다시 보내라"를 남겨 입력을 닫는다. 이미 시작된 작업은 시작한 곳에서 끝나고 결과는 그 서버의 봇 타임라인에 기록된다(옛 봇 전달은 막지 않는다; 그 서버에 연결하면 보인다). 워커 보고·읽기는 그대로.
- A3 재동기화: client-runtime에 순수 계획 함수 `planGoatBotHomeSync({ resolution, inFlight, attempts, now })` → 쓸 대상 목록. 키는 (정본 claimId, 대상 environmentId); 같은 키의 진행 중 쓰기는 다시 내지 않고, 실패는 지수 대기(2s, 8s, 30s, 이후 60s 간격)로 재시도. 연결 세대와 무관하게 정본·대상 값이 바뀔 때마다 다시 계획한다. ensure가 `not_home`이면 즉시 재시도하지 않고 정본이 바뀌거나 해당 서버 설정 스냅샷이 갱신될 때까지 기다린다. 테스트: 두 클라이언트 동시 claim, 늦게 도착한 승자, 부분 실패, 바뀌지 않은 스냅샷에서의 not_home.
- A4 시계 차이: `newGoatBotHomeClaim`은 `claimedAt = max(now, 관측된 최대 claimedAt + 1)`(안전 정수 범위 안). 테스트: 빠른 시계 클라이언트 뒤 느린 시계의 변경, 시계 역행.
- Slack: 시작·configure·홈 재조정이 같은 잠금을 쓰고, 재조정은 잠금 안에서 현재 홈을 다시 읽어 바뀐 경우에만 적용한다(낡은 스냅샷 재생으로 소켓을 불필요하게 다시 열지 않음).

### L1 감사 2차 반영

- `goatBotHome`은 일반 공유 설정 키 목록(`SHARED_SERVER_SETTING_KEYS`)에 넣지 않는다. 일반 동기화가 기본값 null을 패치로 만들 수 있기 때문이다. 홈 값은 `planGoatBotHomeSync`가 null이 아닌 claim만 지원 대상에 직접 쓴다(`capabilities.goatBotHome`과 settings 쓰기 권한 확인).
- 재시도는 설정 변경이 없어도 예약된 깨움으로 돈다. 정본이 바뀌면 낡은 재시도를 취소하고, 재연결 때 중복 제거 기록을 지운다.
- 홈이 아닌 서버의 대기 입력은 원장의 접수 펜스 트랜잭션(`ChannelLedger` reception 경로)으로 실패와 전달을 한 번에 기록해 닫는다.
- channels.md에 적는다: 단조성은 RPC 쓰기에만 적용되고, 디스크 되돌리기는 다른 서버를 잠시 다시 홈으로 만들 수 있다.

### L1 결과 (2026-10-13)

- origin/dev: `0cc0df604` 계약·단조 병합, `ab6ea9cc7` client-runtime `goatBot/home`·문서, `c30d73632` 서버 관문·Slack·capability, `637e0669d` 웹 홈 해석·claim·설정, `7b8ea1dc7` Slack 부분 적용·홈 자체 readback 수정, `8f0a48423` configure 경쟁 수정.
- 위 wp2 계획의 "공유 키 추가"와 "연결마다 한 번 재동기화" 항목은 감사 반영 절로 대체됐다: 홈 값은 일반 공유 키가 아니고, 재동기화는 `planGoatBotHomeSync`의 대상별 백오프로 돈다.
- ensure는 정본이 정해지고 홈 서버 자신이 그 claim을 읽어 돌려줄 때만 부른다(`goatBotHomeReadBack`).
- L3가 쓸 진입점: `@t3tools/client-runtime/goatBot/home`의 `resolveGoatBotHome`, `pickGoatBotHomeCandidate`, `newGoatBotHomeClaim`, `planGoatBotHomeSync`, `reduceGoatBotHomeAttempts`. 웹 `goatBotHomeReadBack`은 아직 웹에 있다.
- 받아들인 한계: 수렴 보장(일시적 이중 동작 가능), 디스크 되돌리기는 단조성 밖, 이동 전에 시작한 작업은 시작한 서버의 봇 타임라인에 보고.
- 레인에서 하지 않은 것: 실제 클라이언트 통합 확인(AGENTS.md상 통합 뒤 조정자가 한 번).
