/**
 * The `cua-lease-proxy` subcommand: real stdio, the driver child and the server's lease stream
 * around runLeaseProxy. Loaded by bin.ts before the full CLI, like the ACP bridge, because the
 * provider waits on it while starting its MCP servers.
 *
 * @module ComputerUseLeaseProxyCli
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off globalDate:off
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
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { LEASE_PROXY_ENV } from "./ComputerUseAttachment.ts";
import { makeHelperInputFeed } from "./agentInputReports.ts";
import { runLeaseProxy } from "./ComputerUseLeaseProxy.ts";
import { leaseUpdateLines } from "./ComputerUseLeaseProtocol.ts";
import { linuxScreenshotPolicy, proxyCaptureRoute } from "./ComputerUseLinuxScreenshots.ts";
import { endDriversWithProxy, killDriverGroup, spawnDriverProcess } from "./driverProcess.ts";
import { overlayChannel } from "./overlayChannel.ts";
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

const argument = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

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

export async function runLeaseProxyCli(args: ReadonlyArray<string>): Promise<void> {
  const platform = HostProcess.Platform.defaultValue();
  const drivers = new Set<NodeChildProcess.ChildProcess>();
  endDriversWithProxy(platform, () => drivers);
  const url = process.env[LEASE_PROXY_ENV.url];
  const authorization = process.env[LEASE_PROXY_ENV.authorization];
  const driver = decodeDriver(process.env[LEASE_PROXY_ENV.driver] ?? "");
  const controlId = argument(args, "--control");
  const expiresAt = DateTime.make(argument(args, "--expires") ?? "");
  if (
    url === undefined ||
    authorization === undefined ||
    Option.isNone(driver) ||
    controlId === undefined ||
    Option.isNone(expiresAt)
  ) {
    process.stderr.write("cua-lease-proxy was started without its control or driver.\n");
    process.exitCode = 2;
    return;
  }
  const descriptor = driver.value;
  // The X display GOAT started the driver on; every window the driver names must be there (#1358).
  const x11Display = decodeX11Display(process.env[LEASE_PROXY_ENV.x11Display] ?? "");
  const placement = Option.isSome(x11Display)
    ? makeX11WindowPlacement(x11Display.value)
    : undefined;
  // The driver child never sees the thread's GOAT credential.
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.values(LEASE_PROXY_ENV)) delete childEnvironment[name];
  for (const variable of descriptor.environment) childEnvironment[variable.name] = variable.value;
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
        child.once("exit", () => drivers.delete(child));
        return child;
      }),
      (child) => Effect.sync(() => killDriverGroup(platform, child, "SIGTERM")),
    ).pipe(
      Effect.flatMap((child) =>
        Effect.gen(function* () {
          // Ownership is released only after both the process and its pipes close.
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
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
                if (child.stdin.writable) child.stdin.write(line + "\n");
              }),
            lines: Stream.fromAsyncIterable(
              NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity }),
              () => undefined,
            ).pipe(Stream.catchCause(() => Stream.empty)),
            kill: Effect.promise(() => {
              child.stdin.end();
              killDriverGroup(platform, child, "SIGKILL");
              return closed;
            }),
          };
        }),
      ),
    );

  const leaseUrl = new URL(url);
  leaseUrl.searchParams.set("control", controlId);
  const abort = new AbortController();

  await Effect.runPromise(
    runLeaseProxy({
      connectionId: NodeCrypto.randomUUID(),
      reservation: (call) => Effect.promise(() => reserveCall(url, authorization, call)),
      controlId,
      expiresAt: expiresAt.value,
      bundleIds: platform === "darwin",
      input: Stream.fromAsyncIterable(
        NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }),
        () => undefined,
      ).pipe(Stream.catchCause(() => Stream.empty)),
      output: (line) => Effect.sync(() => void process.stdout.write(line + "\n")),
      onTarget: (target) =>
        Effect.promise(() =>
          report(url, authorization, {
            controlId,
            pid: target.pid,
            windowId: target.windowId,
          }),
        ),
      onHumanInput: (events) =>
        Effect.promise(() => report(url, authorization, { controlId, humanInput: [...events] })),
      onAgentInput: (agentInput) =>
        Effect.promise(() => report(url, authorization, { controlId, agentInput })),
      leaseUpdates: leaseUpdateLines(
        Stream.fromAsyncIterable(
          (async function* () {
            const response = await fetch(leaseUrl, {
              headers: { authorization },
              signal: abort.signal,
            });
            yield* responseLines(response);
          })(),
          (cause) => cause,
        ),
      ),
      startDriver: startDriver(drawsOverlay),
      // A handshake child never draws or watches input (#1604): on macOS the helper starts its
      // overlay and input feed only when the proxy opens their channel.
      startHandshakeDriver: startDriver(false),
      ...(placement === undefined
        ? {}
        : { placement: (windows) => Effect.promise(() => placement(windows)) }),
      ...(screenshots === undefined ? {} : { screenshots }),
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
      revokeSessions: (sessions) =>
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
    }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(() => abort.abort()))),
  );
  process.exit(0);
}
