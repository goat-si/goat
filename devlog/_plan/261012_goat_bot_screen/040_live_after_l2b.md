# 040 — L2b 머지 뒤 실제 연결 (wp4)

- #32가 dev에 머지되면 rebase. #32의 `channelEnvironment` atoms와 `goatBotIngestInput`으로 `GoatBotChannelPort`를 만들어 앱 루트에서 제공한다.
- 격리 dev 서버(`vp run dev`, 워크트리 .t3, 실행 중인 :3773/:3774는 건드리지 않음)에서 ensureBot → ingest → 사용자 말풍선과 접수 답 또는 실패 말풍선을 확인한다. 접수 provider가 없으면 failure 말풍선 경로로 확인한다.
- #32가 머지되지 않았으면 이 단계는 "L2b 대기"로 보고한다.
- 교체와 rebase 뒤 030의 fmt/lint, typecheck, 관련 테스트, build, 독립 리뷰를 다시 돌리고 PR을 갱신한다(--force-with-lease). 머지 관리 스레드에 다시 보고한다.
