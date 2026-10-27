# 040 — wp4: 교차 리뷰, PR, 기록

> 의존: 010, 020, 030

## 리뷰

- 빌더와 다른 계열이 리뷰한다. 주 에이전트(Claude) 코드 → GPT-6.1-Sol 리뷰 레인. Sol 구현 조각(010) →
  주 에이전트 리뷰 후 최종 통합 diff 전체를 Sol 리뷰 레인이 한 번 더 본다.
- 리뷰 패킷: 원래 브리프(000), 결정(002), diff 범위(`git diff origin/dev...HEAD`), 루브릭(정확성, 경쟁/잠금,
  wire 호환, 성능 — 사이드바 memo와 렌더 비용, 접근성, GOAT 이름 규칙). 마지막 줄
  `VERDICT: PASS | GO-WITH-FIXES (blockers=N) | FAIL`.
- FAIL은 고치고 새 `delegate_task` 라운드로 재리뷰(이전 지적과 응답 포함).

## PR

- 브랜치 `goat/sidebar-delegated-children`을 최신 `origin/dev`로 rebase, push.
- `gh pr create -R goat-si/goat --base dev`, 제목 `feat: nest delegated tasks in the sidebar, promote them, and record launch lineage`.
- 본문: 문제와 동작(사이드바 중첩/접기 규칙, 승격 의미, launchedBy), 검증, 시각 증거가 없는 이유(브라우저 검증은
  사용자 동의 필요, AGENTS.md), "Fixes #12", 마지막 줄에 모델과 하네스.
- `link_pull_request`로 이 스레드에 등록. 머지하지 않는다.

## 기록

- `devlog/_chase/010_fork_delta.md`에 G15 행: 사이드바 위임 자식, `thread.promote`, `launchedBy` (GOAT 전용 계약 필드와
  명령, upstream 머지 시 다시 얹을 경로).
- 사이클 기록 `05N_cycleN_record.md`, PR URL.
- #12에 PR 링크 댓글은 PR 본문 `Fixes #12`로 충분하다(메시지 발송 금지 규칙).

## 결과

- PR: https://github.com/goat-si/goat/pull/33 (`Fixes #12`, 머지는 dev 머지 관리 스레드 몫)
- 리뷰: 최종 리뷰 `i12-final-review-1` GO-WITH-FIXES → 수정 `cd05133cf` → `i12-final-review-2` PASS
- 010 레지스트리: `delegated-tasks` 영역
