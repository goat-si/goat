# 040 — wp4: 통합, 리뷰, 병합

- PR 3개를 dev로. 병합 순서 wp1 → wp3 → wp2 (wp2가 기본 보기를 바꾸므로 마지막).
- 각 PR: 독립 Sol 리뷰(읽기 전용, 최종 head SHA 기준), goat-ci 4개 잡(check/typecheck/test/build) exact-head 녹색, 그다음 병합.
- 앞 PR이 병합되면 다음 PR을 dev 위로 리베이스하고 충돌을 풀고 다시 리뷰/CI.
- 모든 병합 뒤 dev head에서 apps/web 타입체크 한 번.
- 기록: `050_cycle_record.md`에 PR URL, 머지 커밋, CI run id.
