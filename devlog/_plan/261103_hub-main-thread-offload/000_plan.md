# 000 — hub-main-thread-offload: 조사 결론과 로드맵

워크트리 /Users/jun/.goat/desktop-nightly/worktrees/goat/perf-hub-main-thread-offload, 브랜치 perf/hub-main-thread-offload, base origin/dev 55a3236c86. 설계 원칙 3·6 (/Users/jun/Developer/goat/devlog/_plan/261103_goat-hub-isolation-design/000_design.md).

## 조사 결론 (wp0 증거)

### R1. 기록된 최장 멈춤은 메인 스레드 JS 계산이 아니었다
event-loop-stalls.ndjson(읽기만)에서 runtime 기록별 프로세스 전체 CPU(모든 스레드 합)를 비교했다. 측정 코드는 apps/server/src/observability/EventLoopMonitor.ts:84-115 (직전 샘플 이후 resourceUsage 델타, ELU 델타). 샘플은 30초 타이머와 클라이언트 연결 시(latestNoticeableStall, :263)에 일어나고 정상 샘플은 기록되지 않으므로, 아래 "창 길이"는 직전 기록 시각에서 **추정**한 값이다(최소 길이는 delayMax 자체).

| 시각(UTC) | delayMax | ELU | 프로세스 CPU(user+sys) | 창 길이 |
|---|---|---|---|---|
| 10-30 01:01:25 | 8303ms | 1.00 | 1024ms | 38.6s (01:00:47→01:01:25) |
| 10-30 00:58:46 | 5015ms | 1.00 | 2667ms | ~30s+ |
| 10-30 00:59:16 | 4767ms | 1.00 | 6661ms | ~30s |
| 10-30 13:20:30 | 3840ms | 0.98 | 3150ms | ~30s |
| 10-28 04:52:59 | 6411ms | 0.79 | 24615ms | ~30s |

8.3초 멈춤이 든 샘플 구간에서 ELU 1(루프가 poll에서 쉬지 않음)인데 프로세스 전체 CPU는 1.0초다. 창 길이가 얼마든 8.3초 이상이고, 메인 스레드가 JS를 8초 계산했다면 그 구간 CPU가 최소 8초여야 하므로 양립하지 않는다. 따라서 그 멈춤은 메인 스레드가 CPU 밖에서 막혔거나(동기 syscall·잠금 대기) 스케줄링을 못 받은 상태(머신 경합·QoS 억제)로 **추정**한다. 같은 구간 reader SQL nativeMs 14387ms(평소 66–300ms)는 같은 방향의 정황이지만 확증은 아니다. 이 유형은 worker로 JS를 옮겨도 없어지지 않는다. 지금 기록 형식으로는 메인 스레드 CPU, 창 길이, load average가 없어 "막힘"과 "굶음"을 가를 수 없다 → wp2. 10-27/28 기록(CPU 9–25초/구간)은 계산이 섞였을 수 있으나 recentSql이 없는 옛 형식이라 원인을 특정할 수 없다.

### R2. 실 데이터 복사본 프로파일: 메인 스레드 JS 비용
복사본: sqlite3 `VACUUM INTO`로 ~/.goat/desktop-nightly/userdata/statev2.sqlite(읽기 전용)를 /Users/jun/.goat/desktop-nightly/worktrees/goat/perf-hub-main-thread-offload/.goat/profile/statev2.sqlite(12.8GB)로 복사. 하네스 apps/server/scripts/profile-harness.local.ts(커밋 안 함)는 서버와 같은 Sqlite.layerFromPath(reader/writer/checkpoint worker)와 ProjectionStore.layer로 실제 경로를 호출하고 process.threadCpuUsage(메인 스레드만), 1ms 타이머 간격 최대값(연속 차단 최대), RSS/heap을 잰다. 같은 머신, 3–5회 반복.

| 경로 | 벽시계 | 메인 CPU | 최대 연속 차단 | 비고 |
|---|---|---|---|---|
| readShellSnapshot rows (reader worker) | 215–434ms | 15–50ms | 6–11ms | SQL은 worker |
| decodeShellSnapshot (메인) | 113–231ms | 105–209ms | 17–41ms | 2772 threads, Effect가 중간 양보 |
| getShellSnapshot 합계 | 449–694ms | 160–251ms | 11–34ms | heap 일시 +~100MB |
| encode+JSON.stringify 전체(9MB) | 113–187ms | 109–169ms | 167–182ms | 한 덩어리 |
| 구독자 opt-in 적용 후 결과 | — | 3ms | 3ms | 62 threads, 0.68MB |
| getSettlementCandidates | 74–112ms | 32–51ms | 7–11ms | 712 rows |

CPU 프로파일(--cpu-prof): decode 시간은 SchemaAST/SchemaGetter의 payload_json 디코드와 shellFromState가 대부분이다(행 디코드). SQL 대기는 worker에 있다.

라이브 trace(server.trace.ndjson.*, 2026-11-02 14:29–22:44 UTC, 207k spans): ProjectionStore.decodeShellSnapshot p50 112ms / max 564ms, readShellSnapshotRows p50 262 / max 694ms, MemoryWorker.catchUp p50 4ms, ThreadSettlementServiceV2.sweep p50 2ms(최대 36.9s는 git/PR 조회 대기 포함 벽시계). 수 초짜리 메인 스레드 JS 경로는 없다.

데이터 분포: 활성 2772 threads 중 subagent 2328(84%), top-level 443. web/desktop/mobile 현재 클라이언트는 shellThreadFamilies+shellOlderSettled opt-in으로 62개만 받는데(packages/client-runtime/src/state/shell.ts:416-427), 서버는 2772개 전부를 디코드한 뒤 버린다(apps/server/src/ws.ts:1059-1072, apps/server/src/orchestration-v2/http.ts:82-99, ShellStream.ts:177-215).

### R3. worker 경계 비용
측정: 디코드된 스냅샷의 v8.serialize 크기 8.8MB, 메인 쪽 v8.deserialize(= worker가 postMessage로 돌려줄 때 메인이 내는 비용) 13–17ms(3회). 즉 worker decode는 메인 CPU를 ~160ms → ~15ms로 줄일 수 있다. 그러나 decode는 Effect·Schema·contracts·ProjectionStore 코드를 worker에 올려야 하고(빈 worker 8.3MB와 달리 이 모듈 그래프 상주 heap이 붙는다, 미측정), opt-in 구독자에게는 결과의 2%(62/2772)만 필요하다. 디코드 전 가지치기(wp1)는 추가 메모리 0으로 메인 decode를 남는 thread 분량(top-level 443 + live/필수 subagent)으로 줄인다. 결정: **이번 범위에서 worker는 추가하지 않는다.** wp1 후 하네스로 남은 메인 비용을 재고, 남은 연속 차단이 100ms를 넘거나 opt-in 없는 클라이언트 경로가 실사용에서 중요하다는 증거가 나오면 decode worker를 다시 평가한다(그때 worker 상주 heap을 먼저 잰다).

### R4. 버퍼 감사 (terra 감사 2회, path:line은 030 문서)
- WS 송신: Effect socket writer는 ws.send 후 bufferedAmount를 보지 않는다(apps/server/node_modules/effect/src/socket/Socket.ts:1150). 다만 streaming RPC는 chunk마다 클라이언트 ACK를 기다리고(RpcServer.ts:442, RpcClient.ts:460) 수신 120초 idle 종료가 있어(apps/server/src/wsIdleTimeout.ts:19) stream별 진행은 묶이지만, 단발 응답·동시 요청·많은 구독의 첫 chunk는 연결별 바이트 상한 없이 socket에 쌓일 수 있다(030 표). 첫 chunk 중 가장 큰 것이 셸 스냅샷이다.
- 셸 스냅샷: 구독/HTTP 요청마다 전체 디코드, heap 일시 +~100MB. 재연결 폭주(서버 재시작 후 모든 탭·기기)에서 N배. → wp1(크기), wp3(동시 N개를 1개로).
- 나머지 실위험 후보(이번 lane에서 구현하지 않음, 이유 포함 030): ProviderSessionManager 구독자별 Queue.unbounded(ProviderSessionManager.ts:2053; 스레드 4와 겹침, bounded 전환 교착 미확정), EventSink unbounded domain-event 구독(EventSink.ts:260; 소비자별 재생 설계 필요), ClaudeAdapterV2 wake buffer(ClaudeAdapterV2.ts:7844), 구형 클라이언트 전체 thread snapshot(ws.ts:905; 현행 세 클라이언트는 bounded), CUA proxy CLI 버퍼(별도 프로세스), WS 연결별 송신 바이트(단발 응답·동시 요청은 ACK 밖).

### 범위 결정 (A 감사 B5에 대한 main 결정)
버퍼 상한은 **측정으로 크기가 확인된 서버 버퍼**(셸 스냅샷: 요청당 heap +~100MB, 동시 N배)에 적용한다(wp1, wp3). 위 보류 항목은 상한을 넣으면 run 실패·이벤트 유실·provider 전체 정지라는 동작 변화가 생기는데, 현재 증거는 코드상 성장 가능성뿐이고 실측 크기가 없다. 이 lane에서 그 동작 변화를 들이지 않고 path:line·위험 조건·권장 수정과 함께 최종 보고에 미완료 항목으로 넘긴다(origin.report). 이것은 원 과제 3번의 축소이며 보고에 그렇게 적는다.

## Loop-spec
- 아키타입: verifier-defined. 각 phase는 실패-우선 테스트 + 같은 하네스 전후 측정.
- 쓰기 범위: apps/server/src/orchestration-v2/{ProjectionStore.ts,ProjectionShellThreadRows.ts,ShellStream.ts,http.ts,ThreadManagementService.ts(옵션 Pick 한 줄)}, apps/server/src/ws.ts, apps/server/src/observability/EventLoopMonitor.ts, 해당 테스트 파일. 범위 밖: worker 추가, 계약(packages/contracts) 변경, 클라이언트, 릴리스, 실 DB 쓰기.
- 도구·권한: dev 대상 PR, push, PR link/watch, exact-head goat-ci SUCCESS + 독립 리뷰 PASS 후 node scripts/merge-pr.ts. gh는 기본 repo가 upstream(pingdotgg/t3code)으로 잡히므로 항상 -R goat-si/goat.
- 한도: 사용자 명시 없음, 호스트 한도.

## Work-phase map (phase당 PABCD 한 사이클, PR 하나)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | 셸 스냅샷: opt-in 구독자용으로 idle subagent를 디코드 전에 제외 (ws + HTTP) | — |
| wp2 | 020_phase2.md | 멈춤 기록에 메인 스레드 CPU·창 길이·load average 추가 | — |
| wp3 | 030_phase3.md | 동시 셸 스냅샷 로드 single-flight + 감사 잔여 목록 | wp1 |

## Accept criteria
- c-1: 위 R1–R3 (이 문서) + 하네스 출력.
- c-2: wp1–wp3 PR 머지, 전후 측정(메인 CPU, 최대 연속 차단, p99 간격, RSS/heap)을 PR 본문에 첨부.
- c-3: 감사 표(030) + wp3 상한 적용.
- c-4: origin.report.



## 상태
- 2026-11-03: A 감사 4회차 PASS(terra Kepler, 같은 모델 계열 재사용이라 가족 독립성은 미확보). 로드맵 잠금. 구현 순서 wp1 → wp2 → wp3, phase마다 PR 하나.
