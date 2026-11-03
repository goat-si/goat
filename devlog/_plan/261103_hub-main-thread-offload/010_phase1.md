# 010 — wp1: opt-in 셸 구독자용 idle subagent를 디코드 전에 제외

## 문제
현재 web/desktop/mobile은 omitIdleSubagents(=shellThreadFamilies) opt-in으로 셸을 구독한다(packages/client-runtime/src/state/shell.ts:416-427). 서버는 활성 thread 전부를 디코드한 뒤(ProjectionStore.ts:7056-7098 decodeShellSnapshot, 실 데이터 2772개, 메인 CPU 105–209ms, heap +~100MB) ShellStream.ts:177 shellSnapshotForSubscriber에서 idle subagent를 버린다. 활성 thread의 84%(2328)가 subagent다. 같은 일이 HTTP 셸 스냅샷(http.ts:82-99)에서도 일어난다.

## 불변식 (테스트로 고정)
opt-in 구독자가 받는 결과 = 지금의 결과. 정확히: 새 경로의 `shellSnapshotForSubscriber` 출력(snapshot과 subagentThreadIds)이 같은 DB에서 전체 디코드 경로의 출력과 deep-equal. 줄이는 것은 서버 내부 디코드 집합뿐이다.

## 설계
1. 행 단계에서 결정 가능한 값만으로 "확실히 idle한 subagent"를 고른다(초집합 보존: 조금이라도 live일 수 있으면 디코드).
2. 그 행들은 Schema 디코드(shellThreadStateFromRow, decodeProviderThreadPayload, decodeTurnItemPayload)를 건너뛴다.
3. 버려진 행이 결과에 영향을 주는 세 가지를 가벼운 색인으로 보존한다: subagentThreadIds(ws 이벤트 필터), omitIdleSubagentShells의 parentIds, keepLocalLaunchers의 launcher 사슬.
4. 디코드된 부분집합에 기존 필터를 그대로 적용하되, parentIds와 subagent id는 색인(전체 행 기준)을 쓴다.

## 변경

### MODIFY apps/server/src/orchestration-v2/ProjectionShellThreadRows.ts
`ShellThreadRow`에 세 열 추가, `selectShellThreadRows` SELECT에 같은 열 추가(json_extract만, 조인 없음):
```diff
 export type ShellThreadRow = {
   readonly thread_id: string;
   readonly payload_json: string;
   readonly forked_from_run_source_thread_id: string | null;
+  readonly lineage_relationship: string | null;
+  readonly lineage_parent_thread_id: string | null;
+  /** launchedBy.threadId when kind='launch', via<>'delegate_task', environmentId IS NULL (goat/shellLaunchKeep.ts localLauncherId). */
+  readonly local_launcher_thread_id: string | null;
+  /** 1 when payload.pullRequests is a non-empty array (PR watch can make a settled thread live). */
+  readonly has_pull_requests: number;
@@ SELECT
               END AS forked_from_run_source_thread_id,
+              json_extract(t.payload_json, '$.lineage.relationshipToParent') AS lineage_relationship,
+              json_extract(t.payload_json, '$.lineage.parentThreadId') AS lineage_parent_thread_id,
+              CASE
+                WHEN json_extract(t.payload_json, '$.launchedBy.kind') = 'launch'
+                  AND json_extract(t.payload_json, '$.launchedBy.via') IS NOT 'delegate_task'
+                  AND json_extract(t.payload_json, '$.launchedBy.environmentId') IS NULL
+                  THEN json_extract(t.payload_json, '$.launchedBy.threadId')
+                ELSE NULL
+              END AS local_launcher_thread_id,
+              coalesce(json_array_length(t.payload_json, '$.pullRequests'), 0) > 0 AS has_pull_requests,
```
(감사 확인: 저장 launcher의 environmentId는 필수 nullable, via는 optional이라 위 CASE는 JS localLauncherId(goat/shellLaunchKeep.ts:6)와 같다; contracts orchestrationV2.ts:164.)

### MODIFY apps/server/src/orchestration-v2/ProjectionStore.ts
- `ShellSnapshotOptions`(456)에 `readonly omitIdleSubagents?: boolean;` 추가. 의미: "결과에서 확실히 idle한 subagent를 디코드하지 않고 뺀다. 대신 `shellIndex`를 채운다".
- 반환 타입: `OrchestrationV2ThreadShellSnapshot`은 계약 타입이라 건드리지 않는다. 서버 내부 타입을 추가한다:
```ts
export interface ShellSnapshotIndex {
  /** Every active row's subagent id, decoded or not. */
  readonly subagentThreadIds: ReadonlyArray<ThreadId>;
  /** Parents named by any subagent row, decoded or not. */
  readonly subagentParentIds: ReadonlySet<string>;
}
export type ShellSnapshotRead = OrchestrationV2ThreadShellSnapshot & { readonly shellIndex?: ShellSnapshotIndex };
```
  `readShellSnapshot`/`getShellSnapshot` 반환을 `ShellSnapshotRead`로 넓힌다(구조적 상위 타입이라 기존 호출자 그대로 컴파일). Orchestrator.ts:457, ThreadManagementService.ts:480-483의 타입도 같이 넓히고 ThreadManagementService의 `Pick<ShellSnapshotOptions, ...>`에 `"omitIdleSubagents"` 추가.
- `readShellSnapshotRows`(6981): 변경 없음(SQL은 worker에서 그대로, 보조 행도 전체 id로).
- `decodeShellSnapshot`(7056)에 `omitIdleSubagents` 인자 추가. true일 때:
```ts
// Row-level superset of isLiveSubagentShell: anything that could be live is decoded.
const possiblyLive = (row: ShellThreadRow) =>
  row.activity_run_status !== null ||
  row.active_run_id !== null ||
  (row.latest_run_status !== null && !TERMINAL_RUN_STATUSES.has(row.latest_run_status)) ||
  row.pending_request_payload_json !== null ||
  row.pending_secret_request_payload_json !== null ||
  row.has_pull_requests === 1 ||                  // PR watch tasks: orchestrationV2PendingBackgroundWork.ts:254-256, 299
  providerThreadIds.has(row.thread_id) ||      // from providerThreadRows (no decode)
  pendingTurnItemThreadIds.has(row.thread_id);  // from pendingTurnItemRows
```
  TERMINAL_RUN_STATUSES = completed, interrupted, failed, cancelled, rolled_back (shellStatusFromStoredRunStatus 2032-2048 기준, 알 수 없는 값은 "failed"로 매핑되므로 terminal). blocking 경로(6875-6896)는 status를 "failed"로만 바꾸므로 live를 만들지 않는다. 구현자는 isLiveSubagentShell(contracts orchestrationV2.ts:2275)·LIVE_SHELL_STATUSES(2262)·derivePendingBackgroundWork(packages/shared/src/orchestrationV2PendingBackgroundWork.ts:244-299)를 다시 읽고 초집합임을 확인한다.
  
  keep 집합 = 다음 seed에서 시작해 닫힘을 구한다. seed = (subagent 아닌 행) ∪ (possiblyLive subagent) ∪ (subagentParentIds에 든 행). 닫힘 규칙(가벼운 열만 사용, 고정점까지 반복): keep 행의 `forked_from_run_source_thread_id`(그 원본이 target 행이든 원본으로 추가된 행이든 상관없이; visibleItemCountForShell 2085-2125는 원본의 원본까지 재귀), keep 행의 `local_launcher_thread_id`, keep subagent 행의 `lineage_parent_thread_id`(shellLaunchKeep.ts:20-40와 같은 걸음). 원본으로만 추가된(target 아닌) 행은 지금처럼 결과 shells에는 들어가지 않는다(7086 필터).
  keep에 없는 행은 `shellThreadStateFromRow`를 부르지 않고, `pendingBackgroundDataByThreadId`에도 keep id의 행만 넘긴다(provider thread 2784행 디코드도 줄어든다).
  `shellIndex`: **target 행(targetThreadIds, 즉 지금 base.threads가 되는 활성 행)만**에서 `lineage_relationship = 'subagent'`인 id 목록과 그 `lineage_parent_thread_id` 집합. 원본으로만 추가된 fork 원본(archived 포함)은 visibleItemCount 계산용 상태로만 디코드하고 색인에는 넣지 않는다(지금 subagentShellState(base.threads)·omitIdleSubagentShells(base.threads)와 같은 입력, ProjectionStore.ts:7081-7086).
- `readOnReader` 래핑과 `layerMemory`(7469 이후 7688 readShellSnapshot) 구현: layerMemory는 옵션을 무시하고 전체를 돌려줘도 불변식이 유지되도록 `shellIndex`를 디코드 결과에서 계산해 채운다(테스트 레이어 호환).

### MODIFY apps/server/src/orchestration-v2/ShellStream.ts
- `omitIdleSubagentShells(threads, parentIds?)`: parentIds가 주어지면 그것을 쓰고, 없으면 지금처럼 계산.
- `activeShellRowsForSubscriber(threads, omitIdleSubagents, index?)`: index가 있으면 `subagentThreadIds`를 index에서, parentIds도 index에서.
- `shellSnapshotForSubscriber(base, options, index?)`: index를 activeShellRowsForSubscriber로 전달. `keepLocalLaunchers(base.threads, ...)`는 base가 이미 닫힘을 포함하므로 그대로.
- `loadShellSnapshotParts`: 반환에 `shellIndex: read.decodeThreads 결과의 shellIndex` 통과.

### MODIFY apps/server/src/ws.ts (1059-1072) / apps/server/src/orchestration-v2/http.ts (82-99)
```diff
-          readThreads: threadManagement.readShellSnapshot({ location: "active" }),
+          readThreads: threadManagement.readShellSnapshot({
+            location: "active",
+            ...(input.omitIdleSubagents === true ? { omitIdleSubagents: true } : {}),
+          }),
@@
-      subagents = subagentShellState(base.threads, base.snapshotSequence);
+      subagents = subagentShellState(parts.shellIndex?.subagentThreadIds ?? base.threads, base.snapshotSequence);
-      const forSubscriber = shellSnapshotForSubscriber(base, {...});
+      const forSubscriber = shellSnapshotForSubscriber(base, {...}, parts.shellIndex);
```
http.ts도 같은 방식(options.omitIdleSubagents).
subagentShellState는 string 배열을 받는다(ShellStream.ts:319-329). 주의: 현재 코드는 `subagentShellState(base.threads, …)`로 lineage 객체를 넘겨 `subagentThreadIdsOf`가 lineage 기반 id를 모은다 — 구현자는 subagentThreadIdsOf가 행 자기 id 외에 다른 id(예: parent)도 넣는지 확인하고 색인이 같은 집합을 만들게 한다.

## 테스트
이 변경은 버그 수정이 아니라 같은 결과를 더 싸게 내는 성능 변경이다. 테스트는 결과 동등성(관찰 가능한 계약)을 고정하고, 디코드 감소는 하네스 전후 측정으로 증명한다(docs/operations/testing.md:22,27: 내부 구현 형태를 고정하지 않는다). 내부 `shellIndex` 존재나 반환 행 수를 단언하지 않는다.
- 파일: 기존 ProjectionStore 셸 스냅샷 테스트 파일(구현자가 `rg -l "getShellSnapshot|readShellSnapshot" apps/server/src --glob '*.test.ts'`로 고른다; ws 경로를 이미 덮는 테스트가 있으면 그쪽).
- 계약 테스트, 이름: "opt-in shell subscribers get the same rows and subagent filter whether or not idle subagents are decoded". 각 사례는 SQLite ProjectionStore에 시드하고 전체 경로의 `shellSnapshotForSubscriber` 결과와 새 경로 결과(snapshot, subagentThreadIds)를 deep-equal로 비교:
  1. 중첩 idle subagent(idle parent가 idle child를 가짐 → parent 유지),
  2. live subagent(running run), pending runtime request subagent,
  3. run이 없거나 완료됐고 provider/pending item 없이 명시적 PR watch만 있는 subagent(B1),
  4. 활성 top-level B가 활성 idle subagent A의 run에서 fork(원본이 target 행, B2) + 2단 fork,
  5. idle subagent가 local launcher인 top-level thread, 그 launcher의 subagent parent 사슬,
  6. omitOlderSettled 함께 켬(older settled parent가 kept subagent의 ancestor),
  7. 활성 thread가 **archived** subagent에서 fork됐고 그 archived 원본의 parent가 활성 idle subagent(색인 오염 반례).
- 실패-우선 규칙의 적용(main 결정): AGENTS.md의 실패-우선은 버그 수정용이다("Proof for a bug fix depends on the bug"). 이 변경은 동작을 바꾸지 않는 성능 변경이라 현재 코드에서 실패하는 동작 테스트가 존재할 수 없다. 대신 (1) 동등성 테스트를 구현 전에 쓰고 현재 코드에서 통과(기준선 고정), (2) 순진한 가지치기로 3·4·7번이 실패함을 한 번 보여 테스트가 반례를 잡는 힘을 증명, (3) 성능은 같은 하네스의 전후 측정(디코드된 thread 수, 메인 CPU)으로 증명한다. 세 출력 모두 PR 본문에 첨부.
- TestClock 불필요(시간 의존 없음; now는 고정 DateTime).

## 측정 (같은 복사본, 같은 머신)
하네스에 `shellSub` op 추가: ws와 같은 순서(readShellSnapshot({location:"active", omitIdleSubagents:true}) → decode → shellSnapshotForSubscriber(…, index) → JSON.stringify(snapshot)). 전/후 메인 CPU, 최대 연속 차단, p99 간격, heap/RSS, 디코드된 thread 수, 결과 동등성(전체 경로와 deep-equal, 실 데이터) 출력. 실제 가지치기 비율은 provider row가 있는 subagent 수에 달려 측정 전에는 모른다; 측정 후 기대에 못 미치면 providerThreadIds 조건을 "활성 provider thread의 pendingBackgroundTasks가 비어 있지 않음"(SQL json_array_length, ProjectionStore.ts:5153 패턴)으로 좁히는 것을 같은 PR에서 검토한다(초집합 유지가 조건).

## 검증 명령
- `vp test run <변경 테스트 파일>`
- `vp run check:changed`
- 하네스 전후 출력(PR 본문)

## 범위 밖
omitOlderSettled 디코드 전 제외(top-level 443개뿐, YAGNI), 계약 변경, 클라이언트 변경.




## wp1 P 재검증 (2026-11-03)
- 직전 D: wp0 로드맵 잠금, worker 미도입, wp1부터 구현. base를 origin/dev 86c5dad7da로 fast-forward(브랜치 커밋 없음). 010 대상 파일(ProjectionStore.ts, ProjectionShellThreadRows.ts, ShellStream.ts, ws.ts, http.ts)은 55a3236c86..86c5dad7da 사이 변경 없음 → 줄 번호 유효.
