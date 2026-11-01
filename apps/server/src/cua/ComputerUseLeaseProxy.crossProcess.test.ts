// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetchInEffect:off preferSchemaOverJson:off -- Real child and HTTP transport are the proof.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { HttpRouter } from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as PrimitiveChannel from "./ComputerUsePrimitiveChannel.ts";
import * as LeaseRoute from "./ComputerUseLeaseRoute.ts";

const threadId = ThreadId.make("thread:process-proof");
const controlId = "control:process-proof";
const deadline = DateTime.makeUnsafe("2035-01-01T00:00:00.000Z");
const driverSource = `
import * as readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
const held = [];
const reply = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
  result: { content: [], structuredContent: { marker: 'fake-driver', name: message.params?.name,
    driverPid: process.pid,
    channelTokenSeen: process.env.GOAT_CUA_PROXY_CHANNEL_TOKEN !== undefined } } }) + '\\n');
for await (const line of input) {
  const message = JSON.parse(line);
  if (message.method === 'fixture/release') {
    for (const pending of held.splice(0)) reply(pending);
    continue;
  }
  if (message.id === undefined) continue;
  if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { tools: [{ name: 'click', description: 'driver click' }] } }) + '\\n');
    continue;
  }
  const name = message.params?.name;
  if (name === 'list_apps') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { structuredContent: { apps: [{ pid: 42, bundle_id: 'com.example.App', name: 'App' }] } } }) + '\\n');
    continue;
  }
  if (name === 'click' && message.params?.arguments?.hold === true) {
    held.push(message);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'fixture/received',
      params: { id: message.id } }) + '\\n');
    continue;
  }
  reply(message);
}
`;

describe("lease proxy cross-process primitive gate", () => {
  it.live(
    "server and provider clicks use the same proxy child, reservation and input report path",
    () =>
      Effect.gen(function* () {
        const signals = yield* PubSub.unbounded<void>();
        const credentialChanges = yield* PubSub.unbounded<void>();
        let controlState: "active" | "paused" = "active";
        let activeControlId = controlId;
        const calls: Array<string> = [];
        const reservationConnections: Array<string> = [];
        const agentReports: Array<string> = [];
        const leases = ComputerUseLeases.ComputerUseLeases.of({
          currentControl: () =>
            Effect.sync(() =>
              Option.some({ threadId, controlId: activeControlId, expiresAt: deadline }),
            ),
          controlState: (_thread: ThreadId, requestedControlId: string) =>
            Effect.sync(() =>
              requestedControlId !== activeControlId
                ? { _tag: "ended" as const, reason: "replaced" as const }
                : controlState === "paused"
                  ? { _tag: "paused" as const, reason: "takeover" as const }
                  : {
                      _tag: "active" as const,
                      expiresAt: deadline,
                      interruptions: { count: 0, last: "human_input" as const },
                      wakeAt: DateTime.toEpochMillis(deadline),
                    },
            ),
          subscribe: PubSub.subscribe(signals),
          callReservation: (
            _thread: ThreadId,
            call: { action: string; reservationId?: string; connectionId: string },
          ) =>
            Effect.sync(() => {
              calls.push(call.action);
              if (call.action === "reserve" || call.action === "validate")
                reservationConnections.push(call.connectionId);
              return call.action === "reserve"
                ? { status: "admitted" as const, reservationId: "ticket:fixture" }
                : call.action === "validate"
                  ? {
                      status: "admitted" as const,
                      reservationId: call.reservationId,
                      permissions: { validUntilMillis: DateTime.toEpochMillis(deadline) },
                    }
                  : { status: "released" as const };
            }),
          agentInput: (_thread: ThreadId, _control: string, report: { state: string }) =>
            Effect.sync(() => {
              agentReports.push(report.state);
              return true;
            }),
          setTarget: () => Effect.succeed(true),
          streamOpened: () => Effect.void,
          releaseApps: () => Effect.void,
        } as unknown as ComputerUseLeases.ComputerUseLeases["Service"]);
        const channel = yield* PrimitiveChannel.make.pipe(
          Effect.provideService(ComputerUseLeases.ComputerUseLeases, leases),
        );
        const authority = {
          threadId,
          attachmentGeneration: "attachment:process",
          proxyChannelToken: "channel:process-secret",
        };
        yield* channel.issue({ ...authority, expiresAt: DateTime.toEpochMillis(deadline) });
        const settingsContext = yield* Layer.build(
          ServerSettings.layerTest({ enableCua: true, cuaStrictInputGuards: true }),
        );
        const settings = Context.get(settingsContext, ServerSettings.ServerSettingsService);
        const registry = McpSessionRegistry.McpSessionRegistry.of({
          resolve: (token: string) =>
            Effect.succeed(token === "fixture" ? { thread: { threadId } } : undefined),
          inspect: (token: string) =>
            Effect.succeed(
              token === "fixture"
                ? { threadId, recheckAt: DateTime.toEpochMillis(deadline) }
                : undefined,
            ),
          subscribeChanges: PubSub.subscribe(credentialChanges),
        } as unknown as McpSessionRegistry.McpSessionRegistry["Service"]);
        const context = Context.make(ComputerUseLeases.ComputerUseLeases, leases).pipe(
          Context.add(PrimitiveChannel.ComputerUsePrimitiveChannel, channel),
          Context.add(McpSessionRegistry.McpSessionRegistry, registry),
          Context.add(ServerSettings.ServerSettingsService, settings),
        );
        const { handler, dispose } = HttpRouter.toWebHandler(LeaseRoute.layer, {
          disableLogger: true,
        });
        const readyReports = yield* Queue.unbounded<{
          readonly registrationId: string;
          readonly controlId: string;
          readonly connectionId: string;
          readonly driverGeneration: number;
        }>();
        const cutoffReports = yield* Queue.unbounded<{
          readonly registrationId: string;
          readonly controlId: string;
          readonly connectionId: string;
          readonly driverGeneration: number;
        }>();
        const server = NodeHttp.createServer(async (incoming, outgoing) => {
          try {
            const chunks: Array<Buffer> = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers))
              if (typeof value === "string") headers.set(name, value);
            const request = new Request(`http://127.0.0.1${incoming.url}`, {
              method: incoming.method ?? "GET",
              headers,
              ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
            });
            const response = await handler(request, context);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            if (response.status === 204 && incoming.url?.includes("primitive-control-ready"))
              Queue.offerUnsafe(readyReports, JSON.parse(Buffer.concat(chunks).toString()));
            if (
              (response.status === 204 || response.status === 409) &&
              incoming.url?.includes("primitive-control-cutoff")
            )
              Queue.offerUnsafe(cutoffReports, JSON.parse(Buffer.concat(chunks).toString()));
            if (response.body !== null)
              for await (const chunk of response.body) outgoing.write(Buffer.from(chunk));
            outgoing.end();
          } catch {
            outgoing.writeHead(500);
            outgoing.end();
          }
        });
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const address = server.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die(new Error("server has no TCP port"));
        const url = `http://127.0.0.1:${address.port}/api/computer-use/lease`;
        const descriptor = {
          command: process.execPath,
          args: ["--input-type=module", "-e", driverSource],
          environment: [{ name: "GOAT_CUA_PROXY_CHANNEL_TOKEN", value: "driver-cannot-override" }],
        };
        const proxy = NodeChildProcess.spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            NodePath.join(import.meta.dirname, "..", "bin.ts"),
            "cua-lease-proxy",
            "--thread",
            threadId,
          ],
          {
            cwd: NodePath.join(import.meta.dirname, "..", ".."),
            env: {
              ...process.env,
              GOAT_CUA_LEASE_URL: url,
              GOAT_CUA_LEASE_AUTHORIZATION: "Bearer fixture",
              GOAT_CUA_DRIVER_MCP: JSON.stringify(descriptor),
              GOAT_CUA_PROXY_CHANNEL_TOKEN: authority.proxyChannelToken,
              // A turn with goat_screen_run: the provider sees none of the driver's tools, and
              // server clicks still go through this proxy.
              GOAT_CUA_DRIVER_TOOLS: "hidden",
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stderr = "";
        proxy.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4096);
        });
        const childExit = new Promise<string>((resolve) => {
          proxy.once("error", (error) => resolve(`spawn error: ${error.message}`));
          proxy.once("close", (code, signal) =>
            resolve(`exit code ${String(code)}, signal ${String(signal)}`),
          );
        });
        const withLiveChild = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.raceFirst(
            effect,
            Effect.promise(() => childExit).pipe(
              Effect.flatMap((exit) => Effect.die(new Error(`proxy child ${exit}: ${stderr}`))),
            ),
          );
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            proxy.stdin.end();
            if (proxy.exitCode === null && proxy.signalCode === null) proxy.kill("SIGTERM");
            await childExit;
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await dispose();
          }),
        );
        const providerReplies = yield* Queue.unbounded<string>();
        let buffered = "";
        proxy.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
            Queue.offerUnsafe(providerReplies, buffered.slice(0, end));
            buffered = buffered.slice(end + 1);
          }
        });
        const firstReady = yield* withLiveChild(Queue.take(readyReports));
        assert.equal(firstReady.driverGeneration, 0);
        proxy.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 100,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "fixture", version: "1" },
            },
          }) + "\n",
        );
        assert.equal(
          (JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as { id: number }).id,
          100,
        );
        proxy.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
        );
        const serverCallFiber = yield* channel
          .request({
            threadId,
            runId: "run:one",
            turnId: "cell:one",
            callId: 0,
            deadlineMillis: DateTime.toEpochMillis(deadline),
            tool: "click",
            args: { pid: 42, window_id: 7, x: 1, y: 1, hold: true },
          })
          .pipe(Effect.forkChild);
        proxy.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "click", arguments: { pid: 42, window_id: 7, x: 1, y: 1, hold: true } },
          }) + "\n",
        );
        const firstReceived = JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as {
          method: string;
        };
        const secondReceived = JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as {
          method: string;
        };
        assert.equal(firstReceived.method, "fixture/received");
        assert.equal(secondReceived.method, "fixture/received");
        assert.deepEqual(calls.filter((call) => call === "reserve" || call === "validate").sort(), [
          "reserve",
          "reserve",
          "validate",
          "validate",
        ]);
        assert.deepEqual(
          agentReports.filter((state) => state === "start"),
          ["start", "start"],
        );
        assert.equal(new Set(reservationConnections).size, 1);
        proxy.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "fixture/release" }) + "\n");
        const serverCall = yield* withLiveChild(Fiber.join(serverCallFiber));
        assert.equal(serverCall.status, "settled", JSON.stringify(serverCall));
        const providerCall = JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as {
          id: number;
          result: {
            structuredContent: {
              driverPid: number;
              marker: string;
              name: string;
              channelTokenSeen: boolean;
            };
          };
        };
        assert.equal(providerCall.id, 1);
        const serverResult = serverCall.result as {
          structuredContent: {
            driverPid: number;
            marker: string;
            name: string;
            channelTokenSeen: boolean;
          };
        };
        assert.equal(
          serverResult.structuredContent.driverPid,
          providerCall.result.structuredContent.driverPid,
        );
        for (const result of [
          serverResult.structuredContent,
          providerCall.result.structuredContent,
        ]) {
          assert.equal(result.marker, "fake-driver");
          assert.equal(result.name, "click");
          assert.isFalse(result.channelTokenSeen);
        }
        const held = yield* channel
          .request({
            threadId,
            runId: "run:two",
            turnId: "cell:two",
            callId: 1,
            deadlineMillis: DateTime.toEpochMillis(deadline),
            tool: "click",
            args: { pid: 42, window_id: 7, x: 1, y: 1, hold: true },
          })
          .pipe(Effect.forkChild);
        const observed = JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as {
          method: string;
        };
        assert.equal(observed.method, "fixture/received");
        controlState = "paused";
        yield* PubSub.publish(signals, undefined);
        const cutoff = yield* withLiveChild(Queue.take(cutoffReports));
        assert.equal(cutoff.connectionId, firstReady.connectionId);
        const interrupted = yield* withLiveChild(Fiber.join(held));
        assert.equal(interrupted.status, "unknown_outcome");
        assert.equal(
          (yield* Effect.flip(
            channel.request({
              threadId,
              runId: "run:three",
              turnId: "cell:three",
              callId: 2,
              deadlineMillis: DateTime.toEpochMillis(deadline),
              tool: "click",
              args: {},
            }),
          )).reason,
          "desktop_not_ready",
        );
        proxy.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "click", arguments: { pid: 42, window_id: 7, x: 1, y: 1 } },
          }) + "\n",
        );
        const pausedProvider = JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as {
          id: number;
          result: { structuredContent: { detail: string } };
        };
        assert.equal(pausedProvider.id, 2);
        assert.equal(pausedProvider.result.structuredContent.detail, "waiting_for_human");
        controlState = "active";
        yield* PubSub.publish(signals, undefined);
        const secondReady = yield* withLiveChild(Queue.take(readyReports));
        assert.equal(secondReady.driverGeneration, 1);
        const late = yield* Effect.promise(() =>
          fetch(`${url}/primitive-replies`, {
            method: "POST",
            headers: {
              authorization: "Bearer fixture",
              "x-goat-proxy-channel": authority.proxyChannelToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              requestId: interrupted.requestId,
              registrationId: interrupted.registrationId,
              controlId,
              connectionGeneration: interrupted.connectionGeneration,
              runId: interrupted.runId,
              turnId: interrupted.turnId,
              callId: interrupted.callId,
              status: "settled",
            }),
          }),
        );
        assert.equal(late.status, 409);
        const afterRestart = yield* withLiveChild(
          channel.request({
            threadId,
            runId: "run:three",
            turnId: "cell:three",
            callId: 2,
            deadlineMillis: DateTime.toEpochMillis(deadline),
            tool: "click",
            args: { pid: 42, window_id: 7, x: 1, y: 1 },
          }),
        );
        assert.equal(afterRestart.status, "settled");
        proxy.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: 101, method: "tools/list", params: {} }) + "\n",
        );
        const listed = JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as {
          id: number;
          result: { tools: unknown[] };
        };
        assert.equal(listed.id, 101);
        assert.deepEqual(listed.result.tools, []);
        const heldOnA = yield* channel
          .request({
            threadId,
            runId: "run:four",
            turnId: "cell:four",
            callId: 3,
            deadlineMillis: DateTime.toEpochMillis(deadline),
            tool: "click",
            args: { pid: 42, window_id: 7, x: 1, y: 1, hold: true },
          })
          .pipe(Effect.forkChild);
        assert.equal(
          (JSON.parse(yield* withLiveChild(Queue.take(providerReplies))) as { method: string })
            .method,
          "fixture/received",
        );
        activeControlId = "control:replacement";
        yield* PubSub.publish(signals, undefined);
        const oldCutoff = yield* withLiveChild(Queue.take(cutoffReports));
        assert.equal(oldCutoff.controlId, controlId);
        const replacementReady = yield* withLiveChild(Queue.take(readyReports));
        assert.equal(replacementReady.controlId, activeControlId);
        assert.equal(replacementReady.driverGeneration, 0);
        const oldReply = yield* withLiveChild(Fiber.join(heldOnA));
        assert.equal(oldReply.status, "unknown_outcome");
        assert.equal(yield* Queue.size(providerReplies), 0);
        const lateOldControl = yield* Effect.promise(() =>
          fetch(`${url}/primitive-replies`, {
            method: "POST",
            headers: {
              authorization: "Bearer fixture",
              "x-goat-proxy-channel": authority.proxyChannelToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              requestId: oldReply.requestId,
              registrationId: oldReply.registrationId,
              controlId,
              connectionGeneration: oldReply.connectionGeneration,
              runId: oldReply.runId,
              turnId: oldReply.turnId,
              callId: oldReply.callId,
              status: "settled",
            }),
          }),
        );
        assert.equal(lateOldControl.status, 409);
        const onReplacement = yield* withLiveChild(
          channel.request({
            threadId,
            runId: "run:five",
            turnId: "cell:five",
            callId: 4,
            deadlineMillis: DateTime.toEpochMillis(deadline),
            tool: "click",
            args: { pid: 42, window_id: 7, x: 1, y: 1 },
          }),
        );
        assert.equal(onReplacement.status, "settled");
        const previousResult = afterRestart.result as { structuredContent: { driverPid: number } };
        const replacementResult = onReplacement.result as {
          structuredContent: { driverPid: number };
        };
        assert.notEqual(
          replacementResult.structuredContent.driverPid,
          previousResult.structuredContent.driverPid,
        );
        proxy.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "click", arguments: { pid: 42, window_id: 7, x: 1, y: 1 } },
          }) + "\n",
        );
        const replacementProvider = JSON.parse(
          yield* withLiveChild(Queue.take(providerReplies)),
        ) as {
          id: number;
          result: { structuredContent: { driverPid: number } };
        };
        assert.equal(replacementProvider.id, 3);
        assert.equal(
          replacementProvider.result.structuredContent.driverPid,
          replacementResult.structuredContent.driverPid,
        );
      }).pipe(Effect.scoped),
  );
});
