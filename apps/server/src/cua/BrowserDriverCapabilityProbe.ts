// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- MCP stdio carries JSON-RPC frames.
import type { CuaDriverMcpConfiguration } from "@goat/contracts";
import { BoundedLines } from "@goat/shared/boundedLines";
import * as Effect from "effect/Effect";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { supportsBrowserClaims } from "./ComputerUseLeaseProxyBrowserClaims.ts";
import { killDriverGroup, spawnDriverProcess } from "./driverProcess.ts";

class BrowserCapabilityProbeError extends Schema.TaggedError<BrowserCapabilityProbeError>()(
  "BrowserCapabilityProbeError",
  { cause: Schema.Defect() },
) {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const makeBrowserDriverCapabilityProbe = Effect.fn("CuaDriver.makeBrowserCapabilityProbe")(
  function* () {
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    return (mcp: CuaDriverMcpConfiguration) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<unknown>((resolve, reject) => {
            const env = { ...environment };
            for (const variable of mcp.environment) env[variable.name] = variable.value;
            const child = spawnDriverProcess(platform, mcp.command, mcp.args, env);
            const lines = new BoundedLines(child.stdout, 8 * 1024 * 1024);
            let settled = false;
            const finish = (result: unknown, error?: Error) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", abort);
              lines.close();
              child.stdin.end();
              killDriverGroup(platform, child, "SIGTERM");
              if (error) reject(error);
              else resolve(result);
            };
            const abort = () => finish(undefined, new Error("Driver capability probe cancelled."));
            child.on("error", (error) => finish(undefined, error));
            child.stdin.on("error", (error) => finish(undefined, error));
            child.on("exit", () => finish(undefined, new Error("Driver capability probe exited.")));
            lines.on("limit", () =>
              finish(undefined, new Error("Driver capability reply exceeded its limit.")),
            );
            const send = (value: object) => child.stdin.write(JSON.stringify(value) + "\n");
            lines.on("line", (line: string) => {
              let message: unknown;
              try {
                message = JSON.parse(line);
              } catch {
                return;
              }
              if (!isRecord(message)) return;
              if (message.id === 1 && message.error === undefined) {
                send({ jsonrpc: "2.0", method: "notifications/initialized" });
                send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
              } else if (message.id === 1 || message.id === 2) {
                if (message.error !== undefined)
                  finish(undefined, new Error("Driver capability probe was refused."));
                else finish(message.result);
              }
            });
            if (signal.aborted) return abort();
            signal.addEventListener("abort", abort, { once: true });
            send({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "goat", version: "1" },
              },
            });
          }),
        catch: (cause) => new BrowserCapabilityProbeError({ cause }),
      }).pipe(
        Effect.timeoutOption("15 seconds"),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : Effect.logWarning("Browser driver capability probe timed out.").pipe(
                Effect.as(undefined),
              ),
        ),
        Effect.catch(() =>
          Effect.logWarning("Browser driver capability probe failed.").pipe(Effect.as(undefined)),
        ),
      );
  },
);

export const makeBrowserCapabilityLifecycle = Effect.fn("CuaDriver.makeBrowserCapabilityLifecycle")(
  function* (options: {
    readonly probeBrowserClaims?: (mcp: CuaDriverMcpConfiguration) => Effect.Effect<unknown>;
    readonly setDriverCapability?: (supported: boolean) => Effect.Effect<void>;
  }) {
    const lock = yield* Semaphore.make(1);
    return {
      fence: lock.withPermits(1)(options.setDriverCapability?.(false) ?? Effect.void),
      probe: (mcp: CuaDriverMcpConfiguration, current: () => boolean) => {
        const probe = options.probeBrowserClaims;
        const set = options.setDriverCapability;
        if (!probe || !set) return Effect.void;
        return probe(mcp).pipe(
          Effect.flatMap((result) =>
            lock.withPermits(1)(
              Effect.suspend(() => (current() ? set(supportsBrowserClaims(result)) : Effect.void)),
            ),
          ),
          Effect.forkDetach({ startImmediately: true }),
          Effect.asVoid,
        );
      },
    };
  },
);
