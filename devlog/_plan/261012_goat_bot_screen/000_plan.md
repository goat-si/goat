# 000 — L3 GOAT 봇 화면 로드맵

기준: goat_initiative docs/070_goat_bot_gui.md, docs/040_roadmap.md L3 행. 브랜치 goat/goat-bot-chat(기존 3커밋, base 390b9fd). 서버 연결은 PR #32(L2b) API를 쓴다.

## 끝 조건 (040 L3 완료 판정)

- 봇만 메신저형이고 작업자 ChatView는 그대로다.
- 작업이 진행 중일 때 두 번째 전송, 칩 링크, 미지원 서버, 연결 끊김 상태를 테스트로 확인한다.
- 웹 typecheck와 build가 통과한다.
- dev로 PR, 머지 관리 스레드 보고. #32 머지 뒤 rebase하고 실제 연결을 확인한다.

## 작업 단위 (빌드 순서)

| wp  | 문서                         | 결과                                           | 검증                                                      |
| --- | ---------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| wp0 | 이 폴더                      | 로드맵(문서만)                                 | 문서 리뷰                                                 |
| wp1 | [010](010_rebase_sidebar.md) | 최신 dev 위 rebase, 두 사이드바 보기에 봇 항목 | web typecheck, goatBot/globalAgent/ThreadRouteView 테스트 |
| wp2 | [020](020_bot_screen.md)     | 070의 연결, 말풍선, 읽음, 칩, 상태             | 새 jsdom 테스트, web typecheck                            |
| wp3 | [030](030_gate_pr.md)        | 게이트, PR, 보고                               | fmt/lint, typecheck, test, build                          |
| wp4 | [040](040_live_after_l2b.md) | #32 머지 뒤 rebase, 실제 연결                  | 격리 dev 서버에서 ensure/ingest 왕복                      |

## L2b 확인 사항 (2026-10-12 L2b 스레드 답)

- client-runtime `createChannelEnvironmentAtoms`의 ensureBot/ingest/getInput/getTask/listTasks와 `goatBotIngestInput`은 #32 머지까지 유지. clientMessageId가 idempotencyKey라 재전송은 duplicate receipt.
- legacy global agent 실행 중이면 ensureBot이 `legacy_active`로 실패.
- user_message는 recordKey `input:<inputId>`로 기록되고, 읽기 시작 시 같은 항목이 `meta.readAt`과 함께 갱신된다.
- 접수 답은 assistant_message `kind: receipt|question`, `inReplyToInputId`. 접수 실패와 45초 시간 초과는 `kind: failure` + `inReplyToInputId`. 작업 실패/취소는 `failure` + `taskId`.
- 칩은 notification `ledgerTask`, recordKey `task-chip:<taskId>`, 버전마다 갱신.

## 범위 밖

모바일 봇 화면(070 "검증과 모바일"), Slack 설정 화면(L4), 서버 원장(L2b), 조립과 capability 활성화(L2c), 실제 웹/데스크톱 시연(R7 조정자).
