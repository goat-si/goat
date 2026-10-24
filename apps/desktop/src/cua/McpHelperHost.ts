// @effect-diagnostics globalTimers:off -- Child-process startup and shutdown deadlines run outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- Owns the macOS readiness helper's stdio process group.
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";
import type { EmbeddedDriverConnection } from "@trycua/cua-driver/embedded";

import { ComputerUseHelperError, type HelperHostOptions } from "./ComputerUseHelper.ts";
import { readBoundedLines } from "./boundedJsonLines.ts";
import { makeStdioMcpClient } from "./StdioMcpClient.ts";

type Options = Pick<
  HelperHostOptions,
  "bundle" | "driverVersion" | "capabilityManifestPath" | "environment"
>;
export interface McpHelperProcess {
  readonly stdin: NodeStream.Writable;
  readonly stdout: NodeStream.Readable;
  readonly stderr: NodeStream.Readable;
  readonly exited: Promise<unknown>;
  readonly kill: () => void;
}

const mcpCommand = (options: Options) => ({
  command: options.bundle.executable,
  args: ["--mcp", "--capability-manifest", options.capabilityManifestPath],
  environment: [...options.environment],
});

const spawnMcpHelper = (options: Options): McpHelperProcess => {
  const command = mcpCommand(options);
  const child = NodeChildProcess.spawn(command.command, command.args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: {
      ...process.env,
      ...Object.fromEntries(command.environment.map(({ name, value }) => [name, value])),
    },
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    kill: () => {
      if (child.pid === undefined) return;
      try {
        // Only the group captured at spawn belongs to this readiness check.
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
    },
  };
};

async function deadline<A>(promise: Promise<A>, ms: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ComputerUseHelperError("timeout", "The MCP helper did not answer.")),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The service greeting and the MCP peer belong to the same launcher and private stdio pipes. */
export function makeMcpHelperHost(options: Options, startProcess = spawnMcpHelper) {
  let current:
    | {
        process: McpHelperProcess;
        peer: ReturnType<typeof makeStdioMcpClient>;
        pid?: number;
        ended: boolean;
        detach: () => void;
      }
    | undefined;
  let connection: EmbeddedDriverConnection | undefined;
  let generation = 0;
  const stop = async () => {
    const session = current;
    current = undefined;
    connection = undefined;
    if (!session) return;
    session.detach();
    session.peer.close();
    try {
      await deadline(session.process.exited, 8_000);
    } catch {
      session.process.kill();
      await session.process.exited;
    }
  };
  return {
    servicePid: () => (current && !current.ended ? current.pid : undefined),
    readinessPeer: () => current?.peer,
    start: async (): Promise<EmbeddedDriverConnection> => {
      if (connection) return connection;
      const process = startProcess(options);
      const client = makeStdioMcpClient(process);
      const hello = Promise.withResolvers<number>();
      const session = {
        process,
        peer: client,
        ended: false,
        pid: undefined as number | undefined,
        detach: () => {},
      };
      current = session;
      const fail = (error: Error) => hello.reject(error);
      const eof = () =>
        fail(
          new ComputerUseHelperError("helper_exited", "The MCP helper exited before its greeting."),
        );
      session.detach = readBoundedLines(
        process.stderr,
        1024 * 1024,
        (line) => {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            return;
          } // Driver diagnostics also use stderr.
          if (typeof value !== "object" || value === null) return;
          const greeting = value as Record<string, unknown>;
          if (greeting.type !== "hello") return;
          if (
            greeting.protocol !== 1 ||
            greeting.bundleId !== options.bundle.bundleId ||
            typeof greeting.pid !== "number" ||
            !Number.isSafeInteger(greeting.pid) ||
            greeting.pid <= 1
          ) {
            throw new ComputerUseHelperError(
              "invalid_hello",
              "The MCP helper's service identity did not match.",
            );
          }
          hello.resolve(greeting.pid);
        },
        fail,
      );
      process.stderr.once("end", eof);
      process.stderr.once("error", fail);
      const detachLines = session.detach;
      session.detach = () => {
        detachLines();
        process.stderr.off("end", eof);
        process.stderr.off("error", fail);
      };
      void client.ended.then(() => {
        session.ended = true;
        eof();
      });
      try {
        session.pid = await deadline(hello.promise, 10_000);
        await client.initialize();
        if (session.ended)
          throw new ComputerUseHelperError("helper_exited", "The MCP helper exited.");
        connection = {
          socketPath: "",
          pid: session.pid,
          generation: String(++generation),
          driverVersion: options.driverVersion,
          contractVersion: "",
          mcpProtocolVersion: "2025-06-18",
          mcp: mcpCommand(options),
        };
        return connection;
      } catch (error) {
        await stop();
        throw error;
      }
    },
    stop,
    waitForExit: async (_generation: string, operation: { readonly signal: AbortSignal }) => {
      const session = current;
      if (!session) return;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new ComputerUseHelperError("aborted", "Stopped waiting."));
        if (operation.signal.aborted) return abort();
        operation.signal.addEventListener("abort", abort, { once: true });
        void session.peer.ended.then(() => {
          operation.signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    },
    uniffiDestroy: () => undefined,
  };
}
