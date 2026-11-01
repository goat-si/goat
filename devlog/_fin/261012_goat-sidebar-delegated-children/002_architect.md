# 002 — 아키텍트 상담 기록

> 아키텍트: GPT-6.1-Sol (`delegate_task`, read-only, reasoning high). 제안 라운드 `i12-arch-1`.
> 같은 아키텍트의 반영 확인(reflection)은 `delegate_task` 새 라운드에 이전 제안 전문 요지를 넣어 보낸다
> (GOAT 위임 규칙: 리뷰 라운드마다 새 `delegate_task`).

## 제안 라운드 판정과 주 에이전트 처분

| ID          | 아키텍트                                                                                                                                                               | 처분                                                                                        | 반영 위치                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------- |
| D1 사이드바 | AMEND: `source.creationSource`로 읽기, (environmentId, parentThreadId) 키, working/queued/finished 구분과 사람 대기 우선, 열린 자식 중복 없이 고정, finished 정렬 명시 | 전부 수락. 열린 자식의 부모가 안 보이는 경우는 "표시 안 함(현재 동작)"으로 정함             | 010 규칙 표                |
| D2 승격     | AMEND 1: 자식을 가리키는 모든 app_owned 작업 처리                                                                                                                      | 수락                                                                                        | 030 의미 표, 핸들러 4      |
| D2          | AMEND 2: 승격 전 읽은 소유권으로 승격 뒤 멈추는 경쟁(task_cancel, 큐의 `delegated-tasks.stop`)                                                                         | 수락. 실행 시점 가드로 `thread.stop.delegatedFrom`을 두고 자식 잠금 아래서 계보를 다시 확인 | 030 계약 3, 연쇄 Stop 가드 |
| D2          | AMEND 3: client 관계 그래프가 승격된 작업 기록으로 간선을 다시 만듦                                                                                                    | 수락                                                                                        | 030 client-runtime         |
| D2          | AMEND 4: 원자적 커밋, 작업마다 pending events 반영, 커밋 뒤 delivery offer                                                                                             | 수락                                                                                        | 030 핸들러 4-5             |
| D2          | AMEND 5: "불변 계보" 주석을 "분리만 일어남"으로                                                                                                                        | 수락                                                                                        | 030 핸들러 3               |
| D3 계보     | AMEND: 두 shell builder와 launch input까지 전달, (environmentId, threadId)로 식별, watch 동치는 그 caller의 launch에 한정, 전부 서술용                                 | 전부 수락                                                                                   | 020 결정, 필드 체인        |
| 누락        | capability 감지, 권한, 재시도 no-op, 보관/삭제 자식                                                                                                                    | `threadPromotion` capability, operate 권한, 재시도는 no-op, 삭제 거부/보관 허용             | 030 의미 표, 계약 4        |
| 누락        | 모바일 표시                                                                                                                                                            | 이번 범위 밖으로 명시 (컴파일과 기존 동작만)                                                | 000                        |
| 누락        | `create_threads`도 계보                                                                                                                                                | 수락                                                                                        | 020 서버                   |
| 누락        | "Launched" 목록이 원격 shell 포함?                                                                                                                                     | 연결된 모든 환경 shell에서 찾는다. 연결 안 된 SSH 호스트는 `goat_thread_watch_list` 몫      | 020 웹                     |
| 누락        | 손자의 `rootThreadId`                                                                                                                                                  | 바꾸지 않고 역사적 조상으로 정의                                                            | 030 의미 표                |
| 함정        | `delegate_task` 설명의 "Children do not appear in the sidebar"                                                                                                         | 수정                                                                                        | 030 서버                   |

검증된 사실(아키텍트 근거): `thread.metadata-updated`는 ProjectionStore, AgentAwarenessRelay,
ThreadPullRequestService, ProjectionMaintenance, RestartContinuation 모두 현재 payload를 다시 읽어 계보 변경에
안전하다. wait 모드 `delegate_task`는 작업이 `cancelled`가 되면 `subagent.updated`로 깨어 반환하고 자식을
멈추지 않는다. optional 필드는 양방향 디코드가 되지만 구 서버는 새 명령을 모른다(그래서 capability).

## Reflection 라운드

`i12-arch-2` 판정: **MISALIGNED**, 간극 8개. 모두 문서에 접어 넣었다.

| #   | 간극                                                                  | 처분                                                                                                                   |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | 연쇄 Stop 재귀가 no-op 뒤에도 손자로 내려가 승격된 자식 아래를 멈춘다 | `thread.stop.stopCascadeFrom`(연쇄 시작 스레드)로 바꾸고 각 대상이 조상 사슬을 확인 (030 계약 3, 핸들러 6, 테스트 3-4) |
| 2   | `task_cancel`의 dispose가 승격 뒤 실행되면 승격 delivery를 지운다     | dispose 핸들러가 `promotedAt`이면 no-op (030 핸들러 7, 테스트 7)                                                       |
| 3   | `<li>` 안 중첩과 `content-visibility`, 정렬 전략 높이 추론            | containment를 행 표면으로 옮기고 `nestedKeys`로 높이 추론 분리, 드래그 중 숨기지 않음 (010 동작, drag 테스트)          |
| 4   | `source.launchedBy`를 쓰기로 해 놓고 헤더 지시는 `thread.launchedBy`  | `ChatView`가 `source`에서 읽어 넘김 (020 웹)                                                                           |
| 5   | queued 상태와 attention 넘침                                          | 네 상태로 나누고 attention은 제한 밖 (010 규칙 표)                                                                     |
| 6   | queued만 있는 자식의 Stop은 아무것도 안 함                            | Stop을 working/attention으로 제한 (010 동작)                                                                           |
| 7   | 승격 권한/capability를 모든 진입점에                                  | 공용 `canPromoteThread` + operate 권한 (030 웹)                                                                        |
| 8   | watch 동치 문구, 자리표시 검증 명령                                   | 문구 한정, 패키지별 명령 명시 (020, 030)                                                                               |

아키텍트가 확인한 것: child 잠금 아래의 계보 확인은 직계 자식에 충분하다(승격도 그 잠금을 잡는다). 그룹 단위
`onPointerDown` `stopPropagation`은 드래그 활성화를 막는다. 문서의 기존 검증 명령 중 없는 것은 없었다.
간극 1의 수정은 결정 D2의 실행 흐름을 바꾸므로, A 감사에서 이 부분을 다시 본다.

## A 감사 라운드 1 (`i12-audit-1`, Sol reviewer) — VERDICT: FAIL (High 2, Medium 5)

| #   | 지적                                                                           | 처분                                                                                         |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | 구 원격 서버는 선언 안 된 인자를 거부해 SSH launch가 실패                      | `tools/list`로 원격 스키마를 세션 단위로 확인하고 선언됐을 때만 전달 (020 SSH)               |
| 2   | 승격 명령 경로 누락(`dispatchOnce`, scenario 헬퍼, client 유니온, 팔레트 위치) | 모두 명시 (030 서버 1, client-runtime, 웹)                                                   |
| 3   | fork와 subagent 자식이 `launchedBy`를 물려받음                                 | 두 builder에서 제거 + 테스트 (020)                                                           |
| 4   | ServerEnvironment 의존 체인 미정                                               | `environmentId: null` = 같은 환경으로 정의해 의존을 SSH 핸들러 하나로 줄이고 체인 명시 (020) |
| 5   | `isSidebarThreadWorking`가 queued를 working으로 분류                           | runtime 상태로 직접 분류 (010 표시 상태)                                                     |
| 6   | 드래그 중 숨김 문구 모순, `nestedKeys` 호출부, drag 테스트                     | 숨김 제거, 호출부 명시, 검증 명령 추가 (010)                                                 |
| 7   | 원격 행 이동과 key, 공유 콜백                                                  | `ScopedThreadRef` 행, 별도 `onOpenScopedThread` (020 웹)                                     |

비차단 메모도 반영: dispose no-op은 row 재발행, 경쟁 테스트 9-10 추가(030).

## A 감사 라운드 2 (`i12-audit-2`) — VERDICT: FAIL (Medium 2), 라운드 1 지적 7개 모두 CLOSED

| #   | 지적                                                              | 처분                                                           |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | `a ?? b === c` 우선순위로 다른 환경 launch가 섞임                 | 괄호 + `isLaunchedFromThread` 순수 함수와 부정 테스트 (020 웹) |
| 2   | 외부 MCP 클라이언트(스레드 없음)의 SSH launch에서 `launcher` 가정 | caller 있을 때만 생성, 없는 경우 테스트 (020 SSH)              |

비차단: `SidebarChildInput`에 `pendingBackgroundTasks`, 실제 형태 fixture, client 명령 테스트 추가.
