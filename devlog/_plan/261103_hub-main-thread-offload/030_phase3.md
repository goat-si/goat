# 030 — wp3: 동시 셸 스냅샷 로드를 하나로 합친다 + 버퍼 감사 잔여

## 문제
셸 스냅샷 하나가 서버 heap을 ~100MB 일시 점유하고(000 R2, opt-in 아닌 경우 9MB JSON까지), ws 구독(ws.ts:1059)과 HTTP(http.ts:82)가 요청마다 따로 만든다. 서버 재시작·네트워크 복구 직후 모든 탭·기기가 동시에 재구독하면 N배가 된다(설계 원칙 6: 서버가 쥐는 버퍼). 스트림 송신은 ACK로 묶이지만(RpcServer.ts:442) 첫 chunk인 스냅샷은 그 전에 메모리에 다 만들어진다.

## 설계
같은 옵션(location=active, omitIdleSubagents)으로 진행 중인 `loadShellSnapshotParts`가 있으면 새 요청은 그 결과를 기다린다. 완료되면 항목을 지운다(결과를 보관하지 않음 → 상주 메모리 0). 결과는 rows·projects·snapshotSequence가 한 트랜잭션에서 나온 일관된 묶음(ShellStream.ts:218-243)이고, 합류한 구독자는 그 snapshotSequence 이후를 재생하므로 놓치는 이벤트가 없다. 구독자별 가공(shellSnapshotForSubscriber, enrichProjectShells)은 각자 한다. 공유 로드는 첫 요청자의 중단과 분리되어야 한다(서비스 scope에 fork, 대기자는 Deferred).

## 변경
### NEW apps/server/src/orchestration-v2/ShellSnapshotLoads.ts (~70줄)
```ts
export class ShellSnapshotLoads extends Context.Service<ShellSnapshotLoads, {
  /** Joins an in-flight load with the same key; nothing is kept after it settles. */
  readonly shared: <A, E>(key: string, load: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}>()("goat/orchestration-v2/ShellSnapshotLoads") {}

export const layer = Layer.effect(ShellSnapshotLoads, Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const inFlight = new Map<string, Deferred.Deferred<unknown, unknown>>();
  let closed = false;
  // Closing and registering are each one synchronous step, so a key is never added after the
  // finalizer took its list, and every key it took is interrupted even if its child never ran.
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
      const pending = [...inFlight.values()];
      inFlight.clear();
      return pending;
    }).pipe(Effect.flatMap((pending) =>
      Effect.forEach(pending, (done) => Deferred.interrupt(done), { discard: true }))),
  );
  const join = (key, load) => Effect.uninterruptibleMask((restore) =>
    Effect.sync(() => {
      if (closed) return { kind: "closed" } as const;
      const existing = inFlight.get(key);
      if (existing !== undefined) return { kind: "joined", done: existing } as const;
      const done = Deferred.makeUnsafe();   // synchronous constructor; no yield between check and set
      inFlight.set(key, done);
      return { kind: "owner", done } as const;
    }).pipe(Effect.flatMap((slot) => {
      if (slot.kind === "closed") return Effect.interrupt;
      const fork = slot.kind === "owner"
        ? load.pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => { if (inFlight.get(key) === slot.done) inFlight.delete(key); })
                .pipe(Effect.andThen(Deferred.done(slot.done, exit)))),
            Effect.forkIn(scope),
            Effect.asVoid,
          )
        : Effect.void;
      return fork.pipe(Effect.andThen(restore(Deferred.await(slot.done))));
    })),
  );
  return ShellSnapshotLoads.of({ shared: Effect.fn("ShellSnapshotLoads.shared")(join) });
}));
```
의미: 키 제거가 Deferred 완료보다 먼저라 완료 직후 들어온 요청은 새 로드를 시작한다(결과 보관 없음). 대기자가 모두 떠나도 load는 끝까지 돈다(비용은 한 번분으로 묶임). 서비스 scope가 닫히면 load fiber가 중단되고 onExit가 중단 exit로 대기자를 끝낸다. 타입은 구현자가 `any`/캐스트 없이 맞춘다(Deferred<A,E>를 키별로 보관하려면 `shared`를 키→결과 타입이 고정된 좁은 API, 예: `sharedShellParts(key: "active:true"|"active:false", load)`로 두는 편이 캐스트를 피한다). Effect 4의 Context.Service/Deferred/forkIn API는 .repos/effect-smol 패턴을 따른다.

### MODIFY apps/server/src/ws.ts (1059-1065), apps/server/src/orchestration-v2/http.ts (82-92)
`loadShellSnapshotParts({...})`를 `loads.shared(\`active:\${omitIdleSubagents}\`, loadShellSnapshotParts({...}))`로 감싼다. archive/family/worktree/threadIds 읽기는 감싸지 않는다(작고 키가 다양함).
### MODIFY 서버 layer 조립 (server.ts 또는 ws/http layer를 provide하는 곳; 구현자가 `rg -n "ProjectEnrichmentService.layer|ws.layer|OrchestrationHttp" apps/server/src/server.ts`로 찾음)
`ShellSnapshotLoads.layer`를 한 번만 제공해 ws와 http가 같은 인스턴스를 쓴다.

## 테스트 (결정적, sleep·폴링 없음)
apps/server/src/orchestration-v2/ShellSnapshotLoads.test.ts (동시성 불변식은 경계 load 실행 횟수로 직접 관찰 가능; docs/operations/testing.md의 "concurrency invariant"):
1. "concurrent loads with the same key run once and all receive the result": load가 gate Deferred를 기다리고 카운터 증가; 두 fiber가 shared → gate 열기 → 카운터 1, 두 결과 동일. 다른 키(active:true / active:false)는 따로 실행(카운터 2).
2. "a caller interrupted right after joining does not strand later callers": 첫 fiber가 load 진입(entered Deferred)한 뒤 interrupt → 두 번째 호출이 같은 결과를 받음. 첫 fiber를 등록 직후(load 진입 전) interrupt하는 경우도 Fiber.interrupt 후 다음 호출이 완료됨을 확인.
3. "nothing is retained after a load settles": settle 후 같은 키 호출이 load를 다시 실행(카운터 2).
4. "a failed load fails every waiter and the next call starts fresh".
5. "closing the service ends waiters": (a) load 진행 중 Scope.close → 대기 fiber가 interrupt exit로 끝나고 Map이 비어 있음(다음 관찰: 새 scope의 서비스 호출이 load를 새로 실행), (b) Scope.close 뒤 shared 호출 → 즉시 interrupt, (c) fork 직후(load 진입 전) Scope.close → 대기자가 영구 대기하지 않음, (d) 등록 직전과 scope 종료가 교차하는 순서(종료 finalizer가 먼저 → 새 호출 즉시 interrupt; 등록이 먼저 → finalizer가 그 Deferred를 interrupt). 순서는 Deferred gate와 Fiber.join으로 고정.

통합(ws 또는 http 경로, B4): 기존 ws 셸 구독 테스트 하네스가 있으면(구현자가 `rg -l "subscribeShell" apps/server/src --glob '*.test.ts'`) 거기서: load의 readThreads가 **SQLite 읽기 트랜잭션 안에서 첫 SELECT를 끝낸 뒤**(read snapshot 확정 후) gate로 멈춘 상태에서 두 번째 구독을 합류시키고, gate를 열기 전에 thread 이벤트 하나를 커밋 → 두 구독 모두 snapshot(sequence S) 뒤에 그 이벤트를 live로 받는지 확인. 하네스가 없으면 http.ts 경로 하나와 `loadShellSnapshotParts` 수준에서 같은 시나리오(합류자가 받은 snapshotSequence < 커밋된 이벤트 sequence, 이후 `streamStoredEventsFrom({afterSequence})`가 그 이벤트를 돌려줌)를 검증. ws와 http가 같은 인스턴스를 쓰는지는 layer 조립 테스트(같은 키로 ws 한 번 + http 한 번 동시 → load 1회)로 확인.

## 측정
하네스 `shellBurst` op: 동시 5개 구독 로드(같은 경로, ShellSnapshotLoads 있음/없음). 메인 CPU 합, 최대 연속 차단, 최대 heap, 결과 동등성.

## 버퍼 감사 결과 (terra 2회, 읽기 전용)
| 판정 | path:line | 내용 | 이번 lane 처리 |
|---|---|---|---|
| 실위험, 이번 적용 | ws.ts:1059, http.ts:82, ProjectionStore.ts:6981 | 셸 스냅샷 요청마다 전체 로드·디코드, 동시 N배 | wp1(크기) + wp3(동시성) |
| 일부 묶임, 보류 | effect socket/Socket.ts:1150, rpc/RpcServer.ts:123, 442, RpcClient.ts:460, wsIdleTimeout.ts:19 | ws.send가 bufferedAmount를 안 본다. stream은 chunk ACK로 요청별 진행이 묶이지만, 단발 응답·동시 요청(RPC 동시성 기본 unbounded)·많은 구독의 첫 chunk는 연결별 바이트 상한 없이 socket에 들어간다. 수신 idle 120초 종료는 계속 요청하는 peer를 막지 않는다 | 연결별 송신 대기 바이트 상한 + 초과 시 종료가 권장 수정. effect 소켓 계층(upstream 의존성) 훅이 필요해 이 lane에서 보류, 보고 |
| 실위험, 보류 | ProviderSessionManager.ts:2053 (소비자 RunExecutionService.ts:1159, 1602) | provider 이벤트 구독자별 Queue.unbounded, DB 쓰기 지연 시 누적 | 스레드 4(Codex 재시작 생존)와 같은 파일, bounded 전환 시 producer 전체 정지·교착 미확정. 별도 이슈로 넘김 |
| 실위험, 보류 | EventSink.ts:260 (소비자 Orchestrator.ts:13768, ChannelRuntime.ts:398, HandoffWakeReactor.ts:307 등 12곳) | 내부 reactor용 unbounded PubSub | 단순 dropping은 handoff·종료 이벤트 유실. 소비자별 sequence 재생 설계 필요, 별도 이슈 |
| 실위험, 보류 | ClaudeAdapterV2.ts:7844, 7878, 8188 | active turn 없을 때 wake 메시지 배열 | provider adapter 파일(대형, upstream 공유 영역). 별도 이슈 |
| 구형 클라이언트만 | ws.ts:905 (client-runtime threads.ts:183, 996) | acceptBoundedSnapshot 없는 클라이언트는 전체 thread snapshot | 현행 web/desktop/mobile은 bounded. 지원 정책 결정 필요(NEEDS_HUMAN 아님, 보고만) |
| 다른 프로세스 | ComputerUseLeaseProxyCli.ts:72, 578; ComputerUseLeaseProxy.ts:379 | proxy CLI의 줄·응답 버퍼 | 서버 메모리 아님(원칙 4 헬퍼), 보고만 |
| 이미 상한 | LiveStreamBudget.ts:18, 360; ThreadStream.ts:18; OrchestrationEventStore.ts:522, 683; ClaudeTaskOutputTail.ts:21; hubProxy/relay.ts:116 | 1000개/8MiB, 128개/1MiB, 4096 LRU, 500행 페이지, 256KiB tail, bufferedAmount 8MiB | — |

## 검증 명령
`vp test run apps/server/src/orchestration-v2/ShellSnapshotLoads.test.ts`, `vp run check:changed`, 하네스 전후.




