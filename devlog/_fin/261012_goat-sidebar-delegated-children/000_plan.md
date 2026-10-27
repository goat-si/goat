# 000 — #12 남은 부분: 사이드바 하위 작업, 승격, launch 계보

> 이슈: goat-si/goat#12 · 브랜치: `goat/sidebar-delegated-children` (base `origin/dev`)
> 안내문 부분은 dev `2c3a3634e`에 들어갔다. 완료 알림은 #15(dev `840e58797`, 010 G14)가 한다.

## 목표

1. 실행 중인 `delegate_task` 자식 스레드를 웹 사이드바에서 부모 행 아래에 중첩해 보여 준다. 보기, 열기,
   멈추기가 되고, 자식이 수십 개여도 사이드바가 넘치지 않게 접는다.
2. 자식을 기록을 유지한 채 최상위 스레드로 승격한다.
3. 에이전트가 `goat_thread_launch` / `goat_ssh_thread_launch`로 띄운 스레드에 launcher 계보(부모 스레드,
   호스트)를 남기고 웹에 보인다. launch watch(`launcherThreadId`)와 같은 id를 쓴다.

모바일(`apps/mobile`)은 컴파일과 기존 동작만 지킨다. 계약 필드는 모두 optional이라 구 클라이언트와 구
서버가 서로 디코드한다.

## 제약

- 마이그레이션 없음. 계보와 새 필드는 `orchestration_v2_projection_threads.payload_json`과
  subagent `payload_json` 안에 산다 (010 G7 규칙: GOAT 전용 마이그레이션 금지).
- 보이는 이름은 GOAT. 내부 식별자는 그대로.
- 라이브 GOAT 서버(127.0.0.1:3773)와 SSH 런타임 서버는 건드리지 않는다.

## 단계 지도 (의존 순서)

| wp  | 문서                                           | 내용                                    | 의존     |
| --- | ---------------------------------------------- | --------------------------------------- | -------- |
| wp0 | 000-003                                        | 조사, 아키텍트 결정, 로드맵             | -        |
| wp1 | [010](./010_wp1_sidebar_delegated_children.md) | 사이드바 중첩, 열기, 멈추기, 접기 규칙  | wp0      |
| wp3 | [020](./020_wp3_launch_lineage.md)             | `launchedBy` 계약, local/SSH 설정, 표시 | wp0      |
| wp2 | [030](./030_wp2_promote.md)                    | `thread.promote` 명령, 승격 UI          | wp1, wp3 |
| wp4 | [040](./040_wp4_review_pr.md)                  | 교차 리뷰, PR, 기록                     | wp2, wp3 |

goalplan의 id는 등록 순서라 wp2(승격)가 wp3(계보)보다 번호가 작지만, 승격이 `launchedBy`
(`kind: "promotion"`)를 쓰므로 실행은 wp3 → wp2 순서다. 문서 번호는 실행 순서를 따른다.

**수정 (wp1 종료 뒤):** goalplan이 wp1 다음으로 wp2를 열었다. 계보 id 순서를 바꾸지 않고 의존 순서를 지키도록
020의 계약 기반(`OrchestrationV2ThreadLauncher`, `launchedBy` 필드와 shell/생성 명령 전달, fork·subagent 상속 제거)을
wp2 사이클 앞부분에서 먼저 넣고, 020의 나머지(local/SSH/`create_threads` 설정 경로, 웹 표시)는 wp3에서 한다.

## 서브에이전트 운용

조사, 구현 조각, 리뷰는 GPT-6.1-Sol(`codex` / `gpt-6.1-sol`)에 `delegate_task`로 보낸다. 리뷰는
빌더와 다른 모델 계열이 한다. 주 에이전트(Claude Opus 5.5)가 짠 코드는 Sol이 리뷰하고, Sol이 짠 조각은
주 에이전트가 리뷰한다.

## 결과 기록

- 사이클 기록: `05N_cycleN_record.md`
- PR: 040에 URL 기록
