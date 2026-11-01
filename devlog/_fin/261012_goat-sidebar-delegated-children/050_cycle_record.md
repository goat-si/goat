# 050 — 사이클 기록

> 브랜치 `goat/sidebar-delegated-children` · 기준 `origin/dev` `07eb54c5a` · PR #33 · 이슈 #12

| wp  | 결과                                                                                                            | 커밋            | 빌더 → 리뷰                                                            | 검증                                                           |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| wp0 | 로드맵 000-040, 감사 3회(FAIL 7 → FAIL 2 → PASS)                                                                | dev `034041ce4` | Claude 계획, Sol 아키텍트·감사                                         | `vp fmt --check`                                               |
| wp1 | 사이드바 위임 자식 중첩, 4상태 접기, 열기/멈추기/보관                                                           | `becf9e30d`     | Sol 구현 → Claude 리뷰(토글 조건, 더보기 개수, 인덱스를 파생 atom으로) | logic+drag 224 tests, web tsc                                  |
| wp2 | `thread.promote`, 연쇄 Stop 가드, 세 진입점                                                                     | `a091a1db5`     | Claude 구현 → Sol 최종 리뷰                                            | 관련 11 suites 316 tests, 6 패키지 tsc, 가드 변이 시 실패 확인 |
| wp3 | `launchedBy` 설정(local/SSH/create_threads), SSH 스키마 확인, 웹 표시                                           | `b77877c34`     | 서버 Claude, 웹 Sol → 교차 리뷰                                        | 13 suites 212 tests, 6 패키지 tsc, 변이 시 실패 확인           |
| wp4 | Sol 최종 리뷰 GO-WITH-FIXES(Medium 2: SSH 목록 확인 무기한 대기, 승격 wake 미검증) → 수정 → 재리뷰 PASS, PR #33 | `cd05133cf`     | Claude 수정 → Sol 재리뷰                                               | SSH 41, 승격 6 tests, 변이 시 실패 확인                        |

## 계획과 달라진 것

- 020의 계약 기반을 wp2 앞부분으로 당겼다(000 수정). goalplan이 wp2를 먼저 열었고, 승격이 `launchedBy`를 쓴다.
- 사이드바 자식 인덱스는 컴포넌트 `useRef`/`useState` 캐시 대신 파생 atom(`sidebar/delegatedChildIndex.ts`)에
  둔다. 렌더 중 ref 접근과 state 변형이 lint 경고를 새로 만들었고, client-runtime의 `previous` 클로저 패턴이 이미 있다.
- 헤더 승격은 별도 버튼 대신 기존 스레드 액션 메뉴(`buildThreadActionMenuItems`)에 "Promote to thread" 항목으로 넣었다.
- client-runtime `promoteThread` 명령의 단독 테스트는 넣지 않았다. AGENTS.md가 배선만 확인하는 테스트를 금지하고,
  서버 통합 테스트가 `ThreadManagementService.dispatch` 경로를 지난다.

## 남은 위험

- 시각 확인 없음. 브라우저 검증은 사용자 동의가 필요하다(AGENTS.md). 레이아웃(들여쓰기, 드래그 중 높이)은 PR 리뷰에서 본다.
- SSH 원격이 이 변경 이전 GOAT면 launch는 계보 없이 간다(의도된 동작).
- 승격은 되돌리지 않는다. 숨기는 출구는 보관이다.
- 모바일은 승격과 계보를 표시하지 않는다(컴파일과 기존 동작만 확인).
