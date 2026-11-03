// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off
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
} from "@goat/contracts";
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
import type { Observations } from "./observations.ts";

const id = () => NodeCrypto.randomUUID();
const decodeTicket = Schema.decodeUnknownSync(Schema.toCodecJson(AuthWebSocketTicketResult));

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
  observations: Observations;
  recordDetail: (value: unknown) => void;
  signal: AbortSignal;
  onWindowStart: () => void;
  onWindowEnd: () => Promise<void>;
}

export async function runWorkload(
  input: WorkloadInput,
): Promise<{ replayStarted: number; codexStarted: number; headlessOpened: number }> {
  const cookie = await authenticate(input.origin, input.credential);
  const tickets = await Promise.all(
    Array.from({ length: input.headlessClients + 1 }, () => getTicket(input.origin, cookie)),
  );
  const script = `${input.artifactPrefix}.codex-script.json`;
  NodeFS.writeFileSync(script, JSON.stringify({ rootThreadId: "soak", notifications: [] }), {
    flag: "wx",
    mode: 0o600,
  });
  let teardown = false;
  let windowOpen = false;
  let headlessOpened = 0;
  let replayStarted = 0;
  let codexStarted = 0;
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    yield* client["server.getConfig"]({});
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
      if (!project || !NodeFS.existsSync(project.workspaceRoot))
        return yield* Effect.die(new Error("requested project unavailable"));
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
    const opened = yield* Effect.forEach(tickets.slice(1), () => Deferred.make<void, Error>(), {
      concurrency: "unbounded",
    });
    for (const [index, ticket] of tickets.slice(1).entries()) {
      const connectionId = `bare-${index}`;
      const layer = protocol(input.origin, ticket, (socket) => {
        socket.addEventListener("error", () => {
          input.observations.recordSocket(connectionId, teardown);
          input.recordDetail({ type: "socket.error", connectionId, requested: teardown });
        });
        socket.addEventListener("close", (event) => {
          input.observations.recordSocket(connectionId, teardown);
          input.recordDetail({
            type: "socket.close",
            connectionId,
            code: event.code,
            requested: teardown,
          });
        });
      });
      const ready = opened[index];
      if (!ready) return yield* Effect.die(new Error("missing client readiness"));
      yield* Effect.gen(function* () {
        const peer = yield* RpcClient.make(WsRpcGroup);
        yield* peer["server.getConfig"]({});
        headlessOpened++;
        yield* Deferred.succeed(ready, undefined);
        return yield* Effect.never;
      }).pipe(
        Effect.provide(layer),
        Effect.catchCause((cause) =>
          Deferred.fail(ready, new Error(`headless client failed: ${String(cause)}`)).pipe(
            Effect.asVoid,
          ),
        ),
        Effect.forkScoped,
      );
    }
    yield* Effect.forEach(opened, Deferred.await, { concurrency: "unbounded" });
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
      const launch = yield* client["orchestration.launchThread"]({
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
      const observe = Effect.fn("Soak.observeRun")(function* (run: { id: string; status: string }) {
        input.recordDetail({ type: "run", threadId, runId: run.id, status: run.status });
        input.observations.issueRun(run.id);
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
      for (const run of launch.projection.runs) yield* observe(run);
      yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.runForEach((item) => {
          if (item.kind === "snapshot")
            return Effect.forEach(item.projection.runs, observe, { discard: true });
          if (
            item.kind === "event" &&
            (item.event.type === "run.created" || item.event.type === "run.updated")
          )
            return observe(item.event.payload);
          if (item.kind === "unknown-event")
            input.observations.gap(`unknown event ${item.eventType}`);
          return Effect.void;
        }),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            input.observations.gap(`thread stream ended: ${String(cause)}`);
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
  return { replayStarted, codexStarted, headlessOpened };
}
