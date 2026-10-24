/**
 * The `cua-lease-proxy` subcommand: real stdio, the driver child and the server's lease stream
 * around runLeaseProxy. Loaded by bin.ts before the full CLI, like the ACP bridge, because the
 * provider waits on it while starting its MCP servers.
 *
 * @module ComputerUseLeaseProxyCli
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import { CuaDriverMcpConfiguration } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { LEASE_PROXY_ENV } from "./ComputerUseAttachment.ts";
import { leaseUpdateLines, runLeaseProxy } from "./ComputerUseLeaseProxy.ts";

const decodeDriver = Schema.decodeUnknownOption(Schema.fromJsonString(CuaDriverMcpConfiguration));

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

export async function runLeaseProxyCli(args: ReadonlyArray<string>): Promise<void> {
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
  // The driver child never sees the thread's GOAT credential.
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.values(LEASE_PROXY_ENV)) delete childEnvironment[name];
  for (const variable of descriptor.environment) childEnvironment[variable.name] = variable.value;

  const leaseUrl = new URL(url);
  leaseUrl.searchParams.set("control", controlId);
  const abort = new AbortController();

  await Effect.runPromise(
    runLeaseProxy({
      controlId,
      expiresAt: expiresAt.value,
      input: Stream.fromAsyncIterable(
        NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity }),
        () => undefined,
      ).pipe(Stream.catchCause(() => Stream.empty)),
      output: (line) => Effect.sync(() => void process.stdout.write(line + "\n")),
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
      startDriver: Effect.acquireRelease(
        Effect.sync(() => {
          const child = NodeChildProcess.spawn(descriptor.command, [...descriptor.args], {
            env: childEnvironment,
            stdio: ["pipe", "pipe", "inherit"],
            windowsHide: true,
          });
          child.on("error", () => undefined);
          child.stdin.on("error", () => undefined);
          return child;
        }),
        (child) => Effect.sync(() => void child.kill()),
      ).pipe(
        Effect.map((child) => ({
          send: (line: string) =>
            Effect.sync(() => {
              if (child.stdin.writable) child.stdin.write(line + "\n");
            }),
          lines: Stream.fromAsyncIterable(
            NodeReadline.createInterface({ input: child.stdout, crlfDelay: Infinity }),
            () => undefined,
          ).pipe(Stream.catchCause(() => Stream.empty)),
          kill: Effect.sync(() => {
            child.stdin.end();
            child.kill("SIGKILL");
          }),
        })),
      ),
      revokeSessions: (sessions) =>
        Effect.promise(() =>
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
