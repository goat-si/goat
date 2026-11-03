# 020 — wp2: 멈춤 기록이 "메인 스레드 계산"과 "막힘/굶음"을 구분하게 한다

## 문제
000 R1: 8.3초 멈춤 창에서 프로세스 전체 CPU가 1.0초였다. 지금 기록(EventLoopMonitor.ts:213-227 attributes)은 프로세스 전체 CPU만 남기고 메인 스레드 CPU, 창 길이(elapsedMs, readings에는 있음 :106), load average(readings :108, noticeable stall에만 :205)를 남기지 않아 다음 멈춤의 원인을 가를 수 없다. 이 lane의 offload 결정은 "메인 스레드가 계산했는가"에 달려 있다.

## 변경

### MODIFY apps/server/src/observability/EventLoopMonitor.ts
- `EventLoopReadings`(51-71)에 `readonly mainThreadCpuMs: number | undefined;` 추가 (user+system, ms).
- `makeNodeSampler`(73-117): `process.threadCpuUsage`가 함수일 때만 델타를 잰다.
```diff
   let usage = process.resourceUsage();
+  // Node 23.9+; undefined elsewhere so a record never claims a value it did not measure.
+  const readThreadCpu =
+    typeof process.threadCpuUsage === "function" ? () => process.threadCpuUsage() : undefined;
+  let threadCpu = readThreadCpu?.();
@@
     const nextUsage = process.resourceUsage();
+    const nextThreadCpu = readThreadCpu?.();
@@
       elapsedMs: nextSampledAt - sampledAt,
+      mainThreadCpuMs:
+        nextThreadCpu === undefined || threadCpu === undefined
+          ? undefined
+          : Math.round(
+              (nextThreadCpu.user - threadCpu.user + nextThreadCpu.system - threadCpu.system) / 1000,
+            ),
@@
     usage = nextUsage;
+    threadCpu = nextThreadCpu;
```
- tick의 attributes(213-227)에 세 값 추가:
```diff
           utilization: Math.round(utilization * 100) / 100,
+          windowMs: Math.round(readings.elapsedMs),
+          ...(readings.mainThreadCpuMs === undefined ? {} : { mainThreadCpuMs: readings.mainThreadCpuMs }),
+          ...(loadAverage === undefined ? {} : { loadAverage: Math.round(loadAverage * 10) / 10 }),
+          cpuCount,
           cpuUserMs: ...
```
- 테스트용 sampler(테스트가 `layerWith(sample, …)`로 주입하는 readings)는 새 필드를 넣어야 컴파일된다: EventLoopMonitor.test.ts의 readings 생성 helper에 `mainThreadCpuMs` 추가.

## 테스트 (실패-우선)
apps/server/src/observability/EventLoopMonitor.test.ts에 it.effect 하나: "stall records carry main-thread CPU, window length and load so a blocked loop is distinguishable from a busy one". 주입 sampler가 `delayMaxNs` 6s, `activeMs` 30s, `elapsedMs` 38_600, `mainThreadCpuMs` 700, `loadAverage` 14.2, `cpuCount` 18을 돌려주고 writeOverride로 받은 줄을 decode해 `windowMs: 38600, mainThreadCpuMs: 700, loadAverage: 14.2, cpuCount: 18`을 확인. 기존 테스트의 TestClock 진행 방식(30초 SAMPLE_INTERVAL을 TestClock.adjust)을 그대로 따른다. 현재 코드에서 필드가 없어 실패.

## 비용
샘플마다(30초 타이머와 클라이언트 연결 시 latestNoticeableStall, EventLoopMonitor.ts:263) syscall 한 번(threadCpuUsage). 메시지 경로 비용 0. 연결 시 샘플도 기준을 초기화하므로 windowMs는 "직전 샘플 이후"다.

## 검증
`vp test run apps/server/src/observability/EventLoopMonitor.test.ts`, `vp run check:changed`. 런타임 전후 측정 대상 아님(관측 필드 추가); PR 본문에 새 줄 예시를 단위 테스트 출력으로 첨부.

## 범위 밖
멈춤 원인 자동 분류, UI 노출, 계약(ServerEventLoopStall) 변경.


