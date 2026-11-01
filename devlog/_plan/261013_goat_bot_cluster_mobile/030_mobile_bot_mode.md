# 030 — L3 모바일 GOAT Bot 화면 + 스레드/봇 모드 전환

[000](000_plan.md) B6.

## 현재

- 웹 GOAT Bot: `apps/web/src/components/goatBot/*`(가용성, ensure 상태기계, 행 구성, 전송 큐, 읽기, 칩, 답 버튼), 모드 스토어 `apps/web/src/globalAgentStore.ts`(mode `bot`|`thread`), 스위치 `GoatBotModeButton.tsx`.
- client-runtime: `packages/client-runtime/src/state/channels.ts` `createChannelEnvironmentAtoms`(ensureBot/ingest/getInput/getTask/listTasks), `goatBotIngestInput`.
- 모바일에는 GOAT Bot도 글로벌 에이전트도 없다.

## 할 일

1. 웹 goatBot의 React·DOM 의존 없는 모듈(`goatBotRows`, `goatBotSendQueue`, `goatBotEnsure`, `goatBotReaders`, `goatBotAvailability`)을 `packages/client-runtime/src/goatBot/`로 옮기고 테스트도 함께 옮긴다. 웹은 import만 바꾼다. `goatBotAvailability`는 L1이 바꾸므로 마지막에 옮기고, L1이 dev에 있으면 rebase 후 옮긴다.
2. 모바일 `features/goat-bot`: 봇 대화 화면(말풍선, 칩, 답 버튼, 답장 중 표시, 연결 상태), 전송 큐, ensure. 모바일의 환경 연결·권한 훅을 채널 포트로 연결.
3. 모드: 모바일 영속 저장소에 `thread`|`bot`. 홈 헤더에 전환 버튼, 봇 모드면 홈 진입 시 GOAT Bot 화면, 스레드 모드면 기존 스레드 목록. 봇을 지원하는 서버가 없으면 스위치를 숨긴다.
4. 성능: 봇 타임라인은 가상 목록, 계속 도는 애니메이션 금지.

## 검증

client-runtime으로 옮긴 테스트 통과, 모드 영속 테스트, mobile·web·client-runtime typecheck, 변경 파일 lint. 가능하면 iOS 시뮬레이터에서 test-t3-mobile로 한 번 확인(격리 dev 상태).

## 감사 반영 (P2-6, P2-7)

- 순서: 먼저 `goatBotRows`, `goatBotSendQueue`, `goatBotEnsure`, `goatBotReaders`를 옮기고 모바일 화면을 만든다. `goatBotAvailability`는 L1이 origin/dev에 들어간 것을 확인한 뒤 옮기고, 모바일 가용성은 L1의 홈 해석 함수를 쓴다. L1이 아직이면 그 부분만 기다리며 다른 일을 한다.
- `packages/client-runtime/package.json` exports 추가 허용. 전송 큐의 웹 유틸(키 생성 등) 의존은 주입으로 바꾼다.
- 파일 소유는 000 B7. `App.tsx` 링크와 `app.config.ts`는 L2 소유라 필요한 최소 줄만 바꾼다.
