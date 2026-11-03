// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  AuthWebSocketTicketResult,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { PrimaryConnectionTarget } from "../../../../packages/client-runtime/src/connection/model.ts";
import { make as makeRpcSession } from "../../../../packages/client-runtime/src/rpc/session.ts";
// oxlint-disable-next-line goat/no-rpc-permission-bypass -- The soak measures the session transport itself.
import { drainNodeIo } from "../../../../packages/client-runtime/src/rpc/protocol.ts";
import { Observations, providerRestarts } from "./observations.ts";

const id = () => NodeCrypto.randomUUID();
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult));
const decodeLifecycle = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

async function authenticate(origin: string, credential: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  if (!response.ok) throw new Error(`authentication failed: ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("authentication did not return a cookie");
  return cookie;
}

async function getTicket(origin: string, cookie: string): Promise<string> {
  const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { cookie },
  });
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`);
  return Redacted.value(decodeTicket(await response.json()).ticket);
}

function protocol(origin: string, ticket: string, observe?: (socket: WebSocket) => void) {
  const url = `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}&${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`;
  const socket = Socket.layerWebSocket(url).pipe(
    Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor, (url) => {
        const ws = new WebSocket(url);
        observe?.(ws);
        return ws;
      }),
    ),
  );
  return RpcClient.layerProtocolSocket({
    retryTransientErrors: false,
    retryPolicy: Schedule.recurs(0),
  }).pipe(Layer.provide(socket), Layer.provide(RpcSerialization.layerJson));
}

export interface WorkloadInput {
  origin: string;
  credential: string;
  checkout: string;
  artifactPrefix: string;
  lifecyclePath: string;
  projectId?: string;
  replayThreads: number;
  codexThreads: number;
  headlessClients: number;
  durationMs: number;
  selfCheck: {
    enabled: boolean;
    clientDisconnect: { observed: number; passed: boolean };
    providerRestart: { observed: number; passed: boolean };
    nativeIds: string[];
    pids: number[];
  };
  observations: Observations;
  recordDetail: (value: unknown) => void;
  signal: AbortSignal;
  onWindowStart: () => void;
  onWindowEnd: () => Promise<void>;
}

export async function runWorkload(input: WorkloadInput): Promise<{
  replayStarted: number;
  codexStarted: number;
  headlessOpened: number;
  sessionOpened: number;
}> {
  const cookie = await authenticate(input.origin, input.credential);
  const tickets = await Promise.all(
    Array.from({ length: input.headlessClients + 1 + (input.selfCheck.enabled ? 1 : 0) }, () =>
      getTicket(input.origin, cookie),
    ),
  );
  const script = `${input.artifactPrefix}.codex-script.json`;
  NodeFS.writeFileSync(script, JSON.stringify({ rootThreadId: "soak", notifications: [] }), {
    flag: "wx",
    mode: 0o600,
  });
  let teardown = false;
  let windowOpen = false;
  let headlessOpened = 0;
  let sessionOpened = 0;
  let replayStarted = 0;
  let codexStarted = 0;
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    const config = yield* client["server.getConfig"]({});
    const shell = yield* client["orchestration.subscribeShell"]({}).pipe(
      Stream.filter((item) => item.kind === "snapshot"),
      Stream.runHead,
    );
    if (Option.isNone(shell) || shell.value.kind !== "snapshot")
      return yield* Effect.die(new Error("no shell snapshot"));
    let projectId: ProjectId;
    if (input.projectId) {
      projectId = ProjectId.make(input.projectId);
      const project = shell.value.snapshot.projects.find((entry) => entry.id === projectId);
      if (
        !project ||
        !NodeFS.existsSync(project.workspaceRoot) ||
        NodeFS.realpathSync(project.workspaceRoot) !== input.checkout
      )
        return yield* Effect.die(new Error("requested project is not the isolated checkout"));
    } else {
      const existing = shell.value.snapshot.projects.find(
        (project) => project.workspaceRoot === input.checkout,
      );
      if (existing) projectId = existing.id;
      else {
        projectId = ProjectId.make(id());
        yield* client["projects.mutate"]({
          type: "project.create",
          commandId: CommandId.make(id()),
          projectId,
          title: "CPU pressure soak",
          workspaceRoot: input.checkout,
        });
      }
    }
    const codexInstance = ProviderInstanceId.make(`soak-${id()}`);
    yield* client["server.updateSettings"]({
      patch: {},
      providerInstanceMutation: {
        operation: "create",
        instanceId: codexInstance,
        instance: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          displayName: "Soak Codex",
          config: {
            binaryPath: NodePath.join(
              input.checkout,
              "apps/server/src/provider/testFixtures/codexCollabMockPeer.sh",
            ),
          },
          environment: [
            { name: "GOAT_CODEX_COLLAB_SCRIPT", value: script, sensitive: false },
            { name: "GOAT_CODEX_MOCK_SOAK", value: "1", sensitive: false },
            { name: "GOAT_SOAK_PROVIDER_INSTANCE", value: codexInstance, sensitive: false },
            {
              name: "GOAT_SOAK_PROVIDER_LIFECYCLE_LOG",
              value: input.lifecyclePath,
              sensitive: false,
            },
          ],
        },
      },
    });
    const headlessTickets = tickets.slice(1, input.headlessClients + 1);
    const opened = yield* Effect.forEach(headlessTickets, () => Deferred.make<void, Error>(), {
      concurrency: "unbounded",
    });
    for (const [index, ticket] of headlessTickets.entries()) {
      const realSession = index < Math.ceil(input.headlessClients / 2);
      let previousConnection: string | undefined;
      let connectionNumber = 0;
      const observeSocket = (socket: WebSocket) => {
        if (previousConnection) {
          input.observations.recordSocket(previousConnection, teardown);
          input.recordDetail({
            type: "socket.replaced",
            connectionId: previousConnection,
            at: new Date().toISOString(),
            requested: teardown,
          });
        }
        const connectionId = `${realSession ? "session" : "bare"}-${index}-${connectionNumber++}`;
        previousConnection = connectionId;
        socket.addEventListener("error", () => {
          input.observations.recordSocket(connectionId, teardown);
          input.recordDetail({
            type: "socket.error",
            connectionId,
            at: new Date().toISOString(),
            requested: teardown,
          });
        });
        socket.addEventListener("close", (event) => {
          input.observations.recordSocket(connectionId, teardown);
          input.recordDetail({
            type: "socket.close",
            connectionId,
            at: new Date().toISOString(),
            code: event.code,
            requested: teardown,
          });
        });
      };
      const ready = opened[index];
      if (!ready) return yield* Effect.die(new Error("missing client readiness"));
      yield* Effect.gen(function* () {
        if (realSession) {
          const target = new PrimaryConnectionTarget({
            environmentId: config.environment.environmentId,
            label: `Soak session ${index}`,
            httpBaseUrl: input.origin,
            wsBaseUrl: input.origin.replace(/^http/, "ws"),
          });
          const factory = yield* makeRpcSession({ drainIo: drainNodeIo }).pipe(
            Effect.provideService(Socket.WebSocketConstructor, (url) => {
              const socket = new WebSocket(url);
              observeSocket(socket);
              return socket;
            }),
          );
          const session = yield* factory.connect({
            environmentId: target.environmentId,
            label: target.label,
            httpBaseUrl: target.httpBaseUrl,
            socketUrl: `${target.wsBaseUrl}/ws?wsTicket=${encodeURIComponent(ticket)}&${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
            httpAuthorization: null,
            target,
          });
          yield* session.ready;
          sessionOpened++;
          yield* session.closed.pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                if (previousConnection)
                  input.observations.recordSocket(previousConnection, teardown);
                input.recordDetail({
                  type: "session.closed",
                  connectionId: previousConnection,
                  at: DateTime.formatIso(yield* DateTime.now),
                  cause: String(cause),
                  requested: teardown,
                });
              }),
            ),
            Effect.forkScoped,
          );
        } else {
          return yield* Effect.gen(function* () {
            const peer = yield* RpcClient.make(WsRpcGroup);
            yield* peer["server.getConfig"]({});
            headlessOpened++;
            yield* Deferred.succeed(ready, undefined);
            return yield* Effect.never;
          }).pipe(Effect.provide(protocol(input.origin, ticket, observeSocket)));
        }
        headlessOpened++;
        yield* Deferred.succeed(ready, undefined);
        return yield* Effect.never;
      }).pipe(
        Effect.catchCause((cause) =>
          Deferred.fail(ready, new Error(`headless client failed: ${String(cause)}`)).pipe(
            Effect.asVoid,
          ),
        ),
        Effect.forkScoped,
      );
    }
    yield* Effect.forEach(opened, Deferred.await, { concurrency: "unbounded" });
    if (input.selfCheck.enabled) {
      const selfTicket = tickets[input.headlessClients + 1];
      if (!selfTicket) return yield* Effect.die(new Error("missing self-check ticket"));
      const selfSocket = new Observations();
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const url = `${input.origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(selfTicket)}&${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`;
            const socket = new WebSocket(url);
            socket.addEventListener("open", () => socket.close());
            socket.addEventListener("error", () => {
              selfSocket.recordSocket("self", false);
              reject(new Error("self-check socket error"));
            });
            socket.addEventListener("close", () => {
              selfSocket.recordSocket("self", false);
              resolve();
            });
          }),
      );
      input.selfCheck.clientDisconnect.observed = selfSocket.report(
        [],
        { value: 0, observed: 0, coverage: "complete", reasons: [], evidence: [] },
        { value: 0, observed: 0, coverage: "complete", reasons: [], evidence: [] },
      ).counters.clientDisconnects.observed;
      input.selfCheck.clientDisconnect.passed = input.selfCheck.clientDisconnect.observed === 1;
      const selfThread = ThreadId.make(id());
      const selfStart = DateTime.formatIso(yield* DateTime.now);
      const selfObserved = new Observations();
      const finished = yield* Deferred.make<void>();
      yield* client["orchestration.launchThread"]({
        commandId: CommandId.make(id()),
        threadId: selfThread,
        projectId,
        title: "Soak self-check",
        generateTitle: false,
        modelSelection: { instanceId: ProviderInstanceId.make("devReplay"), model: "todo-list" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(id()),
          text: "GOAT_SOAK_EXIT",
          attachments: [],
        },
      });
      const selfRun = (run: OrchestrationV2Run) => {
        if (run.terminationCause?.kind === "provider_process_exit")
          selfObserved.providerDeath(
            run.id,
            selfThread,
            run.providerInstanceId,
            DateTime.formatIso(run.completedAt ?? run.requestedAt),
          );
        return ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
          run.status,
        )
          ? Deferred.succeed(finished, undefined).pipe(Effect.asVoid)
          : Effect.void;
      };
      yield* client["orchestration.subscribeThread"]({ threadId: selfThread }).pipe(
        Stream.runForEach((item) => {
          if (item.kind === "snapshot") {
            for (const thread of item.projection.providerThreads)
              if (thread.nativeThreadRef?.nativeId)
                selfObserved.joinProvider(thread.nativeThreadRef.nativeId, selfThread);
            return Effect.forEach(item.projection.runs, selfRun, { discard: true });
          }
          if (
            item.kind === "event" &&
            item.event.type === "provider-thread.updated" &&
            item.event.payload.nativeThreadRef?.nativeId
          )
            selfObserved.joinProvider(item.event.payload.nativeThreadRef.nativeId, selfThread);
          if (
            item.kind === "event" &&
            (item.event.type === "run.created" || item.event.type === "run.updated")
          )
            return selfRun(item.event.payload);
          if (item.kind === "unknown-event")
            selfObserved.streamGap(`unknown event ${item.eventType}`);
          return Effect.void;
        }),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            selfObserved.streamGap(String(cause));
          }).pipe(Effect.andThen(Deferred.succeed(finished, undefined)), Effect.asVoid),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(finished);
      const lines = NodeFS.readFileSync(input.lifecyclePath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) selfObserved.consumeLifecycle(yield* decodeLifecycle(line));
      const nativeIds = [...selfObserved.joins.keys()];
      const pids = selfObserved.lifecycle
        .filter(
          (line) => line.event === "session" && line.thread && nativeIds.includes(line.thread),
        )
        .map((line) => line.pid);
      input.selfCheck.nativeIds.push(...nativeIds);
      input.selfCheck.pids.push(...pids);
      const selfLines = selfObserved.lifecycle.filter((line) => pids.includes(line.pid));
      const disappeared = pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      });
      const selfProvider = providerRestarts(
        selfLines,
        selfObserved.joins,
        [],
        selfObserved.deaths,
        selfObserved.streamGaps,
        { start: selfStart, end: DateTime.formatIso(yield* DateTime.now), disappeared },
      );
      input.selfCheck.providerRestart.observed = selfProvider.counter.observed;
      input.selfCheck.providerRestart.passed =
        pids.length === 1 && selfProvider.counter.value === 1;
    }
    const drains: Array<Deferred.Deferred<void>> = [];
    const total = input.replayThreads + input.codexThreads;
    const windowEnded = yield* Deferred.make<void>();
    windowOpen = true;
    input.onWindowStart();
    yield* Effect.sleep(`${input.durationMs} millis`).pipe(
      Effect.andThen(
        Effect.sync(() => {
          windowOpen = false;
        }),
      ),
      Effect.andThen(Effect.promise(input.onWindowEnd)),
      Effect.andThen(Deferred.succeed(windowEnded, undefined)),
      Effect.forkScoped,
    );
    for (let index = 0; index < total; index++) {
      if (!windowOpen) break;
      const replay = index < input.replayThreads;
      const threadId = ThreadId.make(id());
      const modelSelection = {
        instanceId: replay ? ProviderInstanceId.make("devReplay") : codexInstance,
        model: replay ? "todo-list" : "gpt-5.6-sol",
      };
      const drained = yield* Deferred.make<void>();
      drains.push(drained);
      let pending = true;
      const terminal = new Set<string>();
      let lastSequence: number | undefined;
      input.observations.requestRun();
      yield* client["orchestration.launchThread"]({
        commandId: CommandId.make(id()),
        threadId,
        projectId,
        title: `Soak ${threadId}`,
        generateTitle: false,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(id()),
          text: "Replay the next recorded turn",
          attachments: [],
        },
      });
      if (replay) replayStarted++;
      else codexStarted++;
      const observe = Effect.fn("Soak.observeRun")(function* (run: OrchestrationV2Run) {
        input.recordDetail({ type: "run", threadId, runId: run.id, status: run.status });
        input.observations.issueRun(run.id);
        if (run.terminationCause?.kind === "provider_process_exit") {
          input.observations.providerDeath(
            run.id,
            threadId,
            run.providerInstanceId,
            DateTime.formatIso(run.completedAt ?? run.requestedAt),
          );
        }
        if (
          !["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
            run.status,
          ) ||
          terminal.has(run.id)
        )
          return;
        terminal.add(run.id);
        input.observations.recordRun(
          run.id,
          run.status === "completed"
            ? "completed"
            : run.status === "failed"
              ? "failed"
              : "interrupted",
        );
        pending = false;
        if (!windowOpen) {
          yield* Deferred.succeed(drained, undefined);
          return;
        }
        pending = true;
        input.observations.requestRun();
        yield* client["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(id()),
          threadId,
          messageId: MessageId.make(id()),
          text: "Replay the next recorded turn",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      });
      yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.runForEach((item) => {
          if (item.kind === "snapshot") {
            lastSequence = item.snapshotSequence;
            for (const thread of item.projection.providerThreads) {
              if (thread.nativeThreadRef?.nativeId)
                input.observations.joinProvider(thread.nativeThreadRef.nativeId, threadId);
            }
            return Effect.forEach(item.projection.runs, observe, { discard: true });
          }
          if (item.kind === "event" || item.kind === "unknown-event") {
            if (lastSequence === undefined || item.sequence <= lastSequence)
              input.observations.streamGap(
                `thread ${threadId} stream sequence regressed or lacked snapshot`,
              );
            lastSequence = item.sequence;
          }
          if (
            item.kind === "event" &&
            item.event.type === "provider-thread.updated" &&
            item.event.payload.nativeThreadRef?.nativeId
          )
            input.observations.joinProvider(item.event.payload.nativeThreadRef.nativeId, threadId);
          if (
            item.kind === "event" &&
            item.event.type === "provider-session.updated" &&
            (item.event.payload.status === "stopped" || item.event.payload.status === "error")
          )
            input.observations.releaseProvider(
              threadId,
              DateTime.formatIso(item.event.occurredAt),
              item.event.payload.status,
            );
          if (
            item.kind === "event" &&
            (item.event.type === "run.created" || item.event.type === "run.updated")
          )
            return observe(item.event.payload);
          if (item.kind === "unknown-event")
            input.observations.streamGap(`unknown event ${item.eventType}`);
          return Effect.void;
        }),
        Effect.tap(() =>
          Effect.sync(() => {
            if (!teardown) input.observations.streamGap(`thread ${threadId} stream ended`);
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (!teardown) input.observations.streamGap(`thread stream ended: ${String(cause)}`);
            yield* Deferred.succeed(drained, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      // A terminal launch snapshot must not leave the drain waiting.
      if (!pending) yield* Deferred.succeed(drained, undefined);
    }
    yield* Deferred.await(windowEnded);
    yield* Effect.forEach(drains, Deferred.await, { concurrency: "unbounded" });
    teardown = true;
  });
  try {
    await Effect.runPromise(
      Effect.scoped(program.pipe(Effect.provide(protocol(input.origin, tickets[0] ?? "")))),
      { signal: input.signal },
    );
  } finally {
    teardown = true;
  }
  return { replayStarted, codexStarted, headlessOpened, sessionOpened };
}
