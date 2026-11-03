# 040 — wp4: 준비 완료(descriptor) 전에 도는 백그라운드 작업을 준비 완료 뒤로 미룬다

## 근거
- 사용자 제공(부모 스레드): .317 업데이트 직후 데스크톱 백엔드가 60초 준비 제한을 두 번 넘김(server-child.log 2026-11-02T23:10:30Z, 23:12:01Z: "Timed out after 60000ms waiting for desktop backend readiness at http://127.0.0.1:3773/.well-known/goat/environment"). 같은 시각 startup 샘플(event-loop-stalls.ndjson 66-67행): delayMax 1–9ms, ELU 0.39–0.42, 프로세스 CPU 30초 구간에 31.8–32초(user 20s + sys 12s) → 루프는 막히지 않았고, 여러 스레드(SQLite worker)가 계속 일했다.
- 준비 판정: 데스크톱은 descriptor GET이 200일 때 준비로 본다. descriptor는 command readiness 대기에서 빠져 있다(apps/server/src/commandReadiness.ts:15-31). 그 전에는 rejectRequestsUntilServing가 503을 준다(httpResponseErrorGuard.ts:28-50). 즉 **라우터 layer가 다 지어지는 시점**이 준비 시점이다.
- 재현(같은 머신, migrate-dev-db로 만든 4.2GB 복사본, 워크트리 dev:server, trace = .goat/userdata/logs/server.trace.ndjson, t0 = 첫 span): descriptor 첫 200은 t0+19.4s. 그 전 구간에서
  - MemoryWorker.catchUp이 t0+9.7s에 layer 생성 중 시작(MemoryApplicationLayers.ts:169-176 `worker.start()` → MemoryWorker.ts:969-994 즉시 wake → sweepDue) → reader에서 23.0s짜리 `WITH progress AS MATERIALIZED …` 쿼리(selectContinuationCandidates) 포함 33.3s.
  - ChannelRuntime.layerBackground(ChannelRuntime.ts:352-429)가 layer 생성 즉시 heartbeat(claimOwnership 쓰기)·passes·deadlines(expireOverdue 1.7s, deliverReceipts 0.9s)·runEvents를 fork.
  - startup fiber(serverRuntimeStartup.ts:557-720)가 layer 생성과 동시에 legacy-v1.import-shells(3.5s), recovery(0.6s), delegated-tasks.recover(0.3s), welcome.autobootstrap(1.6s)를 `http.wait`(706) 전에 실행.
  - 그 결과 준비 전 sqlite 시간 합계 writer 17.5s, reader 28.7s. 준비 경로의 layer 생성 쓰기(ServerSecretStore.getOrCreateRandom 3.4s, INSERT handoff_wake_epoch 2.6s, EventStoreV2.latestSequence 2.3s, Handoffs.stopComputerUseSessions 3.6s)가 writer 큐에서 기다렸다.
  실 데이터(12.8GB, 3배)에서는 같은 경합이 커져 60초를 넘을 수 있다.

## 변경
1. MODIFY apps/server/src/memory/MemoryApplicationLayers.ts:169-176 — `worker.start()`와 `reports.start()`를 `forkParked`(apps/server/src/serverActivation.ts:12-29)로 감싸 활성화(=준비 뒤 startup이 activate, serverRuntimeStartup.ts:745) 이후에 시작. ServerActivation이 없는 환경(테스트)은 지금처럼 바로 시작(forkParkedFiber 16-18).
2. MODIFY apps/server/src/channels/ChannelRuntime.ts:415-428 — 네 개의 forkScoped 루프와 hold 대기를 하나의 `forkParked(Effect.gen(...))` 안으로. `sessionEventStart`는 지금처럼 layer 생성 시점에 읽는다(재생 시작점 보존).
3. MODIFY apps/server/src/serverRuntimeStartup.ts:557-720 — `http.wait`과 `auxiliary-roots.parked`를 keybindings/settings 다음, legacy import·recovery 앞으로 옮긴다. command readiness·activate·ready 이벤트 순서는 그대로(모든 phase 뒤). descriptor 외 요청은 계속 command readiness를 기다리므로 import·recovery 전 상태가 노출되지 않는다.
   주의: awaitAuxiliaryParked의 routesReady는 라우터 layer 생성 완료이고, 라우터는 ServerRuntimeStartup 서비스(make가 즉시 반환)만 요구하므로 순환이 없다. 구현자는 runtimeStateParked/cloudLink/tailscale parked가 startup phase 결과에 의존하지 않음을 확인한다(server.ts:1188-1265).
4. 확인만(변경 후 재측정으로 판단): ComputerUseTurnEnd.ts:44-56의 layer 생성 중 await(disable/revalidate)는 명령 전에 끝나야 하는 정리라 그대로 둔다. 1–3 후에도 준비 경로를 잡으면 별도 판단.

## 테스트 (실패-우선, 결정적)
- serverRuntimeStartup.test.ts(기존 파일)에 it.effect: "the HTTP listener and routes are awaited before legacy import and recovery run". 기존 테스트 하네스의 가짜 서비스로 legacy import와 recovery가 Deferred에 진입을 기록하게 하고, httpListening/routes를 아직 열지 않은 상태에서 import가 시작되지 않았음(진입 Deferred 미완료, Fiber.poll)을 확인 → markHttpListening + auxiliary 열기 → import 진입 → 이후 command ready. 현재 코드는 import가 먼저 시작되어 실패.
- MemoryApplicationLayers/ChannelRuntime: ServerActivation을 제공한 layer에서 활성화 전에는 sweep/heartbeat가 실행되지 않고 활성화 후 실행됨을 Deferred로 관찰하는 테스트(각 파일의 기존 테스트 위치를 구현자가 rg로 찾음). 현재 코드에서 실패.
- sleep·폴링 금지, TestClock(ChannelRuntime의 Schedule.spaced는 TestClock.adjust).

## 측정 (같은 복사본, 같은 머신)
/Users/jun/.goat/desktop-nightly/worktrees/goat/perf-hub-main-thread-offload/.goat/startup-prof/driver.cjs: dev:server를 자기 프로세스 그룹으로 띄우고 descriptor 첫 503(listening)·첫 200(ready) 시각과 startup phase 길이를 기록, 25초 뒤 그 그룹만 종료. 변경 전 3회, 변경 후 3회. 보조 지표: 준비 전 sqlite writer/reader 합계(trace).

## 범위 밖
감독 정책(60초 제한, 차단기) — 스레드 3. 데스크톱 코드 변경 없음.

