/**
 * The `cua-lease-proxy` subcommand: real stdio, the driver child and the server's lease stream
 * around runLeaseProxy. Loaded by bin.ts before the full CLI, like the ACP bridge, because the
 * provider waits on it while starting its MCP servers.
 *
 * @module ComputerUseLeaseProxyCli
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";

import {
  CuaDriverMcpConfiguration,
  type ComputerUseLeaseReport,
  ComputerUseCallAdmission,
  type ComputerUseCallReservation,
  ComputerUseLeaseUpdate,
  ComputerUseLeaseThreadUpdate,
  type ComputerUsePrimitiveRequest,
  type AgentCursorLeaseUpdate,
  type ComputerUsePrimitiveReply,
  COMPUTER_USE_PRIMITIVE_REPLY_ROUTE,
  COMPUTER_USE_PRIMITIVE_CONTROL_READY_ROUTE,
  COMPUTER_USE_PRIMITIVE_CONTROL_CUTOFF_ROUTE,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { LEASE_PROXY_ENV } from "./ComputerUseAttachment.ts";
import { makeHelperInputFeed } from "./agentInputReports.ts";
import { makeAppGuide } from "./ComputerUseGuide.ts";
import { runLeaseProxy } from "./ComputerUseLeaseProxy.ts";
import { linuxScreenshotPolicy, proxyCaptureRoute } from "./ComputerUseLinuxScreenshots.ts";
import { parseLeaseProxyArguments } from "./ComputerUseLeaseProxyArguments.ts";
import { runThreadLeaseProxy } from "./ComputerUseLeaseProxyThread.ts";
import type { LeaseProxyOptions } from "./ComputerUseLeaseProxyOptions.ts";
import { type DriverWatchReport, makeDriverWatch } from "./ComputerUseDriverWatch.ts";
import { endDriversWithProxy, killDriverGroup, spawnDriverProcess } from "./driverProcess.ts";
import { overlayChannel } from "./overlayChannel.ts";
import { helperCursorListing } from "./ComputerUseCursorTools.ts";
import { makeX11WindowPlacement } from "./x11WindowPlacement.ts";

const decodeDriver = Schema.decodeUnknownOption(Schema.fromJsonString(CuaDriverMcpConfiguration));
const decodeAdmission = Schema.decodeUnknownOption(ComputerUseCallAdmission);
/** A window report waits this long at most; the call it rides on goes ahead either way. */
const TARGET_REPORT_TIMEOUT_MS = 2_000;
const decodeX11Display = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ DISPLAY: Schema.String, XAUTHORITY: Schema.optionalKey(Schema.String) }),
  ),
);

async function* responseLines(response: Response): AsyncGenerator<string> {
  if (!response.ok || response.body === null) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
  }
}

/**
 * Tells the lease route which window the control acts on, or that a person used the keyboard or
 * pointer; true when the server took it.
 */
async function report(
  url: string,
  authorization: string,
  body: ComputerUseLeaseReport,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TARGET_REPORT_TIMEOUT_MS),
    });
    return response.status === 204;
  } catch {
    return false;
  }
}

async function reserveCall(
  url: string,
  authorization: string,
  call: ComputerUseCallReservation,
): Promise<ComputerUseCallAdmission> {
  try {
    const response = await fetch(`${url}/calls`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(call),
      signal: AbortSignal.timeout(TARGET_REPORT_TIMEOUT_MS),
    });
    if (response.ok) {
      const decision = decodeAdmission(await response.json());
      if (Option.isSome(decision)) return decision.value;
    }
  } catch {
    // Lost admission or release acknowledgement grants no authority; server tickets stay held.
  }
  return { status: "refused", detail: "unauthorized" };
}

type DriverReport = {
  readonly kind: "ready" | "cutoff";
  readonly controlId: string;
  readonly connectionId: string;
  readonly driverGeneration: number;
};
type ReportIdentity = Omit<DriverReport, "kind" | "controlId">;
type PendingReports = { readonly cutoff?: ReportIdentity; readonly ready?: ReportIdentity };

export const postPrimitive = (url: string, authorization: string, token: string, body: object) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization, "x-goat-proxy-channel": token, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
    return response.status;
  }).pipe(Effect.orElseSucceed(() => 0));

export const makePrimitiveReporter = Effect.fn("ComputerUseLeaseProxyCli.reporter")(
  function* (input: {
    readonly url: string;
    readonly authorization: string;
    readonly token: string;
    readonly registration: Deferred.Deferred<string>;
  }) {
    const state = yield* Ref.make(new Map<string, PendingReports>());
    const wake = yield* Queue.sliding<void>(1);
    let failed = false;
    let overflowWarned = false;
    const enqueue = (report: DriverReport) =>
      Ref.update(state, (current) => {
        if (failed && (report.kind !== "cutoff" || !current.has(report.controlId))) return current;
        if (!current.has(report.controlId) && current.size >= 8) {
          failed = true;
          return current;
        }
        const next = new Map(current);
        const old = next.get(report.controlId) ?? {};
        const identity = {
          connectionId: report.connectionId,
          driverGeneration: report.driverGeneration,
        };
        if (report.kind === "cutoff") {
          const cutoff =
            old.cutoff !== undefined && old.cutoff.driverGeneration > identity.driverGeneration
              ? old.cutoff
              : identity;
          next.set(report.controlId, {
            cutoff,
            ...(old.ready !== undefined && old.ready.driverGeneration > cutoff.driverGeneration
              ? { ready: old.ready }
              : {}),
          });
        } else if (report.driverGeneration > (old.cutoff?.driverGeneration ?? -1)) {
          next.set(report.controlId, {
            ...old,
            ready:
              old.ready !== undefined && old.ready.driverGeneration > identity.driverGeneration
                ? old.ready
                : identity,
          });
        }
        return next;
      }).pipe(Effect.andThen(Effect.sync(() => void Queue.offerUnsafe(wake, undefined))));
    const run = Effect.gen(function* () {
      const registrationId = yield* Deferred.await(input.registration);
      if (registrationId.length === 0) {
        failed = true;
        yield* Effect.logWarning("computer use primitive registration unavailable");
        return;
      }
      let backoff = 250;
      for (;;) {
        if (failed && !overflowWarned) {
          overflowWarned = true;
          yield* Effect.logWarning("computer use primitive reporter exceeded eight controls");
        }
        const pending = yield* Ref.get(state);
        let next:
          | {
              readonly controlId: string;
              readonly kind: "cutoff" | "ready";
              readonly item: ReportIdentity;
            }
          | undefined;
        for (const [controlId, reports] of pending) {
          if (reports.cutoff !== undefined)
            next = { controlId, kind: "cutoff", item: reports.cutoff };
          else if (reports.ready !== undefined)
            next = { controlId, kind: "ready", item: reports.ready };
          if (next !== undefined) break;
        }
        if (next === undefined) {
          yield* Queue.take(wake);
          continue;
        }
        const route =
          next.kind === "cutoff"
            ? COMPUTER_USE_PRIMITIVE_CONTROL_CUTOFF_ROUTE
            : COMPUTER_USE_PRIMITIVE_CONTROL_READY_ROUTE;
        const status = yield* postPrimitive(
          new URL(route, input.url).toString(),
          input.authorization,
          input.token,
          { registrationId, controlId: next.controlId, ...next.item },
        );
        if (status === 401) {
          failed = true;
          yield* Effect.logWarning("computer use primitive report authorization ended");
          return;
        }
        if ((status >= 200 && status < 300) || status === 409) {
          yield* Ref.update(state, (current) => {
            const latest = current.get(next.controlId);
            if (latest === undefined) return current;
            const item = latest[next.kind];
            if (
              item?.driverGeneration !== next.item.driverGeneration ||
              item.connectionId !== next.item.connectionId
            )
              return current;
            const updated: PendingReports =
              next.kind === "cutoff"
                ? latest.ready === undefined
                  ? {}
                  : { ready: latest.ready }
                : latest.cutoff === undefined
                  ? {}
                  : { cutoff: latest.cutoff };
            const nextState = new Map(current);
            if (updated.cutoff === undefined && updated.ready === undefined)
              nextState.delete(next.controlId);
            else nextState.set(next.controlId, updated);
            return nextState;
          });
          backoff = 250;
        } else {
          yield* Effect.sleep(`${backoff} millis`);
          backoff = Math.min(5_000, backoff * 2);
        }
      }
    });
    return {
      enqueue,
      run,
      get failed() {
        return failed;
      },
    };
  },
);

export async function runLeaseProxyCli(args: ReadonlyArray<string>): Promise<void> {
  const platform = HostProcess.Platform.defaultValue();
  const drivers = new Set<NodeChildProcess.ChildProcess>();
  endDriversWithProxy(platform, () => drivers);
  const url = process.env[LEASE_PROXY_ENV.url];
  const authorization = process.env[LEASE_PROXY_ENV.authorization];
  const proxyChannelToken = process.env[LEASE_PROXY_ENV.proxyChannelToken];
  const driver = decodeDriver(process.env[LEASE_PROXY_ENV.driver] ?? "");
  const launch = parseLeaseProxyArguments(args);
  if (
    url === undefined ||
    authorization === undefined ||
    Option.isNone(driver) ||
    launch === undefined
  ) {
    process.stderr.write("cua-lease-proxy was started without a valid control/thread or driver.\n");
    process.exitCode = 2;
    return;
  }
  const descriptor = driver.value;
  // The skill's path and per-app notes ride on the driver's answers (ComputerUseGuide.ts).
  const guide = makeAppGuide(platform, process.env[LEASE_PROXY_ENV.skill]?.trim() || undefined);
  // The X display GOAT started the driver on; every window the driver names must be there (#1358).
  const x11Display = decodeX11Display(process.env[LEASE_PROXY_ENV.x11Display] ?? "");
  const placement = Option.isSome(x11Display)
    ? makeX11WindowPlacement(x11Display.value)
    : undefined;
  // The driver child never sees the thread's GOAT credential.
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of descriptor.environment) childEnvironment[variable.name] = variable.value;
  for (const name of Object.values(LEASE_PROXY_ENV)) delete childEnvironment[name];
  // On Linux the agent's screenshots follow the helper's capture route (#1677).
  const screenshots =
    platform === "linux"
      ? linuxScreenshotPolicy(
          proxyCaptureRoute({
            x11Display: Option.getOrUndefined(x11Display),
            driverEnvironment: childEnvironment,
          }),
        )
      : undefined;
  // The macOS helper in agent connection mode draws the cursor overlay from fd 3 (#1214).
  const drawsOverlay = platform === "darwin" && descriptor.args.includes("--mcp");
  // The app macOS asks for Automation consent: the helper, or GOAT's own in-process driver.
  const automationHolder: "helper" | "app" | undefined =
    platform === "darwin" ? (drawsOverlay ? "helper" : "app") : undefined;

  // A driver that reads its capability manifest from a path GOAT rewrites (the macOS helper's
  // --mcp mode, #1416) gets a fresh child when the file changes.
  const manifestFlag = descriptor.args.indexOf("--capability-manifest");
  const manifestPath = manifestFlag >= 0 ? descriptor.args[manifestFlag + 1] : undefined;

  const startDriver = (overlay: boolean) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawnDriverProcess(
          platform,
          descriptor.command,
          descriptor.args,
          childEnvironment,
          overlay,
        );
        drivers.add(child);
        const watch = makeDriverWatch();
        // Fire and forget: a lost report only delays the host's record, never this connection.
        // One at a time, so a working report still in flight cannot clear the crash after it.
        let reported = Promise.resolve();
        const send = (body: DriverWatchReport | undefined) => {
          if (body === undefined) return;
          reported = reported
            .then(() => report(url, authorization, body))
            .then(
              () => undefined,
              () => undefined,
            );
        };
        child.once("exit", (code) => {
          drivers.delete(child);
          send(watch.exited(code ?? undefined));
        });
        const lines = NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        // Keep early replies buffered for the proxy while the watch observes the same frames.
        const incoming = lines[Symbol.asyncIterator]();
        lines.on("line", (line) => send(watch.received(line)));
        return { child, watch, lines, incoming };
      }),
      ({ child, watch, lines }) =>
        Effect.sync(() => {
          watch.stopping();
          lines.close();
          killDriverGroup(platform, child, "SIGTERM");
        }),
    ).pipe(
      Effect.flatMap(({ child, watch, incoming }) =>
        Effect.gen(function* () {
          // Ownership is released only after both the process and its pipes close.
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          const exited = new Promise<number | undefined>((resolve) => {
            if (child.exitCode !== null) resolve(child.exitCode);
            else child.once("exit", (code) => resolve(code ?? undefined));
          });
          // The helper's input reports, every one of them: a person's may be among a burst.
          const seen = yield* makeHelperInputFeed();
          const channel = child.stdio[3];
          return {
            ...(overlay && channel instanceof NodeStream.Duplex
              ? {
                  // Dated the moment the line is read, on the clock the server compares with.
                  overlay: overlayChannel(channel, (input) =>
                    seen.offer({
                      source: input.source,
                      at: Date.now() - input.ageMs,
                    }),
                  ),
                  humanInput: seen.events,
                }
              : {}),
            send: (line: string) =>
              Effect.sync(() => {
                if (child.stdin.writable) {
                  watch.sent(line);
                  child.stdin.write(line + "\n");
                }
              }),
            lines: Stream.fromAsyncIterable(
              { [Symbol.asyncIterator]: () => incoming },
              () => undefined,
            ).pipe(Stream.catchCause(() => Stream.empty)),
            // Stdout closes just before the exit is reported; a child still running after a
            // moment is not one that refused its parent.
            exitCode: Effect.promise(() => exited).pipe(
              Effect.timeoutOption("1 second"),
              Effect.map(Option.getOrUndefined),
            ),
            kill: Effect.promise(() => {
              watch.stopping();
              child.stdin.end();
              killDriverGroup(platform, child, "SIGKILL");
              return closed;
            }),
          };
        }),
      ),
    );

  const leaseUrl = new URL(url);
  leaseUrl.searchParams.delete("control");
  leaseUrl.searchParams.delete("thread");
  leaseUrl.searchParams.set(
    launch.mode === "control" ? "control" : "thread",
    launch.mode === "control" ? launch.controlId : launch.threadId,
  );
  const abort = new AbortController();

  const reports = (controlId: string) => ({
    onTarget: (target: { readonly pid: number; readonly windowId: number }) =>
      Effect.promise(() =>
        report(url, authorization, { controlId, pid: target.pid, windowId: target.windowId }),
      ),
    onCursor: (cursor: Parameters<NonNullable<LeaseProxyOptions<never, never>["onCursor"]>>[0]) =>
      Effect.promise(() => report(url, authorization, { controlId, cursor })),
    onCursorReport: (
      cursorReport: Parameters<NonNullable<LeaseProxyOptions<never, never>["onCursorReport"]>>[0],
    ) => Effect.promise(() => report(url, authorization, { controlId, report: cursorReport })),
    onHumanInput: (
      events: Parameters<NonNullable<LeaseProxyOptions<never, never>["onHumanInput"]>>[0],
    ) => Effect.promise(() => report(url, authorization, { controlId, humanInput: [...events] })),
    onAgentInput: (
      agentInput: Parameters<NonNullable<LeaseProxyOptions<never, never>["onAgentInput"]>>[0],
    ) => Effect.promise(() => report(url, authorization, { controlId, agentInput })),
  });
  const program = Effect.gen(function* () {
    const registration = yield* Deferred.make<string>();
    const proxyInstanceId = NodeCrypto.randomUUID();
    if (proxyChannelToken !== undefined) {
      leaseUrl.searchParams.set("primitive", "1");
      leaseUrl.searchParams.set("instance", proxyInstanceId);
    }
    const reporter =
      proxyChannelToken === undefined
        ? undefined
        : yield* makePrimitiveReporter({
            url,
            authorization,
            token: proxyChannelToken,
            registration,
          });
    if (reporter !== undefined) yield* reporter.run.pipe(Effect.forkScoped);
    const updates = yield* Queue.unbounded<ComputerUseLeaseUpdate, Cause.Done>();
    const threadUpdates = yield* Queue.unbounded<ComputerUseLeaseThreadUpdate, Cause.Done>();
    const primitiveRequests = yield* Queue.dropping<ComputerUsePrimitiveRequest, Cause.Done>(16);
    const cursorEvents = yield* Queue.sliding<AgentCursorLeaseUpdate, Cause.Done>(1);
    const pendingPrimitives = new Set<string>();
    const cancelledPrimitives = new Set<string>();
    const earlyCancels = new Set<string>();
    const settledPrimitives = new Set<string>();
    const takeCancel = (requestId: string) => {
      if (settledPrimitives.has(requestId)) return;
      if (pendingPrimitives.has(requestId)) cancelledPrimitives.add(requestId);
      else {
        earlyCancels.add(requestId);
        if (earlyCancels.size > 64) {
          const oldest = earlyCancels.values().next().value;
          if (oldest !== undefined) earlyCancels.delete(oldest);
        }
      }
    };
    const decodeControl = Schema.decodeUnknownOption(Schema.fromJsonString(ComputerUseLeaseUpdate));
    const decodeThread = Schema.decodeUnknownOption(
      Schema.fromJsonString(ComputerUseLeaseThreadUpdate),
    );
    const lines = Stream.fromAsyncIterable(
      (async function* () {
        const response = await fetch(leaseUrl, {
          headers: {
            authorization,
            ...(proxyChannelToken === undefined
              ? {}
              : { "x-goat-proxy-channel": proxyChannelToken }),
          },
          signal: abort.signal,
        });
        const header = response.headers.get("x-goat-primitive-registration");
        if (proxyChannelToken !== undefined) {
          if (response.ok && header !== null && header.length > 0 && header.length <= 200)
            Deferred.doneUnsafe(registration, Exit.succeed(header));
          else Deferred.doneUnsafe(registration, Exit.succeed(""));
        }
        yield* responseLines(response);
      })(),
      () => new Error("Lease stream failed"),
    );
    yield* lines.pipe(
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          if (line.trim().length === 0) return;
          const offerPrimitive = Effect.fn("ComputerUseLeaseProxyCli.offerPrimitive")(function* (
            update: ComputerUsePrimitiveRequest,
          ) {
            if (reporter !== undefined && !reporter.failed) {
              pendingPrimitives.add(update.requestId);
              if (earlyCancels.delete(update.requestId)) cancelledPrimitives.add(update.requestId);
              if (yield* Queue.offer(primitiveRequests, update)) return;
              pendingPrimitives.delete(update.requestId);
            }
            const {
              requestId,
              registrationId,
              controlId,
              connectionGeneration,
              runId,
              turnId,
              callId,
            } = update;
            yield* postPrimitive(
              new URL(COMPUTER_USE_PRIMITIVE_REPLY_ROUTE, url).toString(),
              authorization,
              proxyChannelToken ?? "",
              {
                requestId,
                registrationId,
                controlId,
                connectionGeneration,
                runId,
                turnId,
                callId,
                status: "not_started",
              },
            );
            cancelledPrimitives.delete(update.requestId);
            earlyCancels.delete(update.requestId);
          });
          if (launch.mode === "control") {
            const decoded = decodeControl(line);
            if (Option.isNone(decoded)) return yield* Effect.die(new Error("Invalid lease stream"));
            if (decoded.value.state === "primitive-request") yield* offerPrimitive(decoded.value);
            else if (decoded.value.state === "primitive-cancel")
              takeCancel(decoded.value.requestId);
            else if (decoded.value.state === "cursor-state")
              yield* Queue.offer(cursorEvents, decoded.value);
            else yield* Queue.offer(updates, decoded.value);
          } else {
            const decoded = decodeThread(line);
            if (Option.isNone(decoded)) return yield* Effect.die(new Error("Invalid lease stream"));
            if (decoded.value.state === "primitive-request") yield* offerPrimitive(decoded.value);
            else if (decoded.value.state === "primitive-cancel")
              takeCancel(decoded.value.requestId);
            else if (decoded.value.state === "cursor-state")
              yield* Queue.offer(cursorEvents, decoded.value);
            else yield* Queue.offer(threadUpdates, decoded.value);
          }
        }),
      ),
      Effect.ignoreCause,
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Queue.end(updates);
          yield* Queue.end(threadUpdates);
          yield* Queue.end(primitiveRequests);
          yield* Queue.end(cursorEvents);
          if (!(yield* Deferred.isDone(registration))) yield* Deferred.succeed(registration, "");
        }),
      ),
      Effect.forkScoped,
    );
    const common = {
      primitiveCancelled: (requestId: string) => cancelledPrimitives.has(requestId),
      onPrimitiveSettled: (requestId: string) => {
        pendingPrimitives.delete(requestId);
        cancelledPrimitives.delete(requestId);
        earlyCancels.delete(requestId);
        settledPrimitives.add(requestId);
        if (settledPrimitives.size > 64) {
          const oldest = settledPrimitives.values().next().value;
          if (oldest !== undefined) settledPrimitives.delete(oldest);
        }
      },
      cursorEvents: Stream.fromQueue(cursorEvents),
      connectionId: proxyInstanceId,
      ...(reporter === undefined
        ? {}
        : {
            primitiveRequests: Stream.fromQueue(primitiveRequests),
            primitiveReply: (reply: ComputerUsePrimitiveReply) =>
              postPrimitive(
                new URL(COMPUTER_USE_PRIMITIVE_REPLY_ROUTE, url).toString(),
                authorization,
                proxyChannelToken ?? "",
                reply,
              ).pipe(Effect.asVoid),
          }),
      reservation: (call: ComputerUseCallReservation) =>
        Effect.promise(() => reserveCall(url, authorization, call)),
      bundleIds: platform === "darwin",
      input: Stream.fromAsyncIterable(
        NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }),
        () => undefined,
      ).pipe(Stream.catchCause(() => Stream.empty)),
      output: (line: string, context?: { readonly tool?: string | undefined }) =>
        Effect.sync(() => {
          const listed = drawsOverlay ? helperCursorListing(line) : line;
          process.stdout.write(guide(listed, context) + "\n");
        }),
      answersCursorTools: drawsOverlay,
      verifyInputByTreeDiff: platform === "darwin",
      ...(automationHolder === undefined ? {} : { automationHolder }),
      startDriver: startDriver(drawsOverlay),
      // A handshake child never draws or watches input (#1604): on macOS the helper starts its
      // overlay and input feed only when the proxy opens their channel.
      startHandshakeDriver: startDriver(false),
      ...(screenshots === undefined ? {} : { screenshots }),
      ...(placement === undefined
        ? {}
        : {
            placement: (
              windows: Parameters<NonNullable<LeaseProxyOptions<never, never>["placement"]>>[0],
            ) => Effect.promise(() => placement(windows)),
          }),
      ...(manifestPath === undefined
        ? {}
        : {
            manifestStamp: () => {
              try {
                const info = NodeFS.statSync(manifestPath);
                return info.ino + ":" + info.size + ":" + info.mtimeMs;
              } catch {
                return undefined;
              }
            },
          }),
      revokeSessions: (sessions: ReadonlyArray<string>) =>
        // A driver without a socket is a direct child of this connection; killing it ends its
        // sessions, and there is no daemon left to ask.
        descriptor.socketPath === undefined
          ? Effect.void
          : Effect.promise(() =>
              Promise.all(
                sessions.map(
                  (session) =>
                    new Promise<void>((resolve) => {
                      NodeChildProcess.execFile(
                        descriptor.command,
                        [
                          "revoke",
                          "--session",
                          session,
                          ...(descriptor.socketPath === undefined
                            ? []
                            : ["--socket", descriptor.socketPath]),
                        ],
                        { env: childEnvironment, timeout: 5_000, windowsHide: true },
                        () => resolve(),
                      );
                    }),
                ),
              ),
            ).pipe(Effect.asVoid),
    };
    return yield* launch.mode === "control"
      ? runLeaseProxy({
          ...common,
          ...reports(launch.controlId),
          controlId: launch.controlId,
          expiresAt: launch.expiresAt,
          leaseUpdates: Stream.fromQueue(updates),
          ...(reporter === undefined
            ? {}
            : {
                onDriverStarted: (current: {
                  readonly connectionId: string;
                  readonly generation: number;
                }) =>
                  reporter.enqueue({
                    kind: "ready",
                    controlId: launch.controlId,
                    connectionId: current.connectionId,
                    driverGeneration: current.generation,
                  }),
                onDriverCutoff: (current: {
                  readonly connectionId: string;
                  readonly generation: number;
                }) =>
                  reporter.enqueue({
                    kind: "cutoff",
                    controlId: launch.controlId,
                    connectionId: current.connectionId,
                    driverGeneration: current.generation,
                  }),
              }),
        })
      : runThreadLeaseProxy({
          ...common,
          reports,
          leaseUpdates: Stream.fromQueue(threadUpdates),
          ...(reporter === undefined
            ? {}
            : {
                onControlDriverStarted: (
                  controlId: string,
                  current: { readonly connectionId: string; readonly generation: number },
                ) =>
                  reporter.enqueue({
                    kind: "ready",
                    controlId,
                    connectionId: current.connectionId,
                    driverGeneration: current.generation,
                  }),
                onControlDriverCutoff: (
                  controlId: string,
                  current: { readonly connectionId: string; readonly generation: number },
                ) =>
                  reporter.enqueue({
                    kind: "cutoff",
                    controlId,
                    connectionId: current.connectionId,
                    driverGeneration: current.generation,
                  }),
              }),
        });
  });
  await Effect.runPromise(
    program.pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => abort.abort()))),
  );
  process.exit(0);
}
