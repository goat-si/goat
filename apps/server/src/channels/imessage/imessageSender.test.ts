// @effect-diagnostics nodeBuiltinImport:off -- fake child streams never start osascript.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeTimers from "node:timers";
import type * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  IMESSAGE_SCRIPT,
  makeImessageTransport,
  makeOsascriptImessageSender,
} from "./imessageSender.ts";

describe("iMessage sender", () => {
  it("marks spawn failure unsent and a timed-out child ambiguous", async () => {
    const failedSpawn = (() => {
      throw new Error("fixture");
    }) as unknown as typeof NodeChildProcess.spawn;
    expect(
      await makeOsascriptImessageSender({ spawnProcess: failedSpawn }).sendText({
        chatGuid: "guid",
        text: "hello",
      }),
    ).toEqual({ outcome: "not_sent", code: "unknown" });
    const child = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
      stdin: NodeStream.PassThrough;
      stdout: NodeStream.PassThrough;
      stderr: NodeStream.PassThrough;
      kill: () => boolean;
    };
    child.stdin = new NodeStream.PassThrough();
    child.stdout = new NodeStream.PassThrough();
    child.stderr = new NodeStream.PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const timedSpawn = (() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof NodeChildProcess.spawn;
    expect(
      await makeOsascriptImessageSender({ spawnProcess: timedSpawn, timeoutMs: 1 }).sendText({
        chatGuid: "guid",
        text: "hello",
      }),
    ).toEqual({ outcome: "unknown", code: "timeout" });
  });
  it("distinguishes proven pre-send failures from uncertain exits", async () => {
    const outcome = async (stderr: string, exitCode: number) => {
      const child = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
        stdin: NodeStream.PassThrough;
        stdout: NodeStream.PassThrough;
        stderr: NodeStream.PassThrough;
        kill: () => boolean;
      };
      child.stdin = new NodeStream.PassThrough();
      child.stdout = new NodeStream.PassThrough();
      child.stderr = new NodeStream.PassThrough();
      child.kill = () => true;
      const fake = (() => {
        queueMicrotask(() => {
          child.emit("spawn");
          child.stderr.emit("data", Buffer.from(stderr));
          child.emit("close", exitCode);
        });
        return child;
      }) as unknown as typeof NodeChildProcess.spawn;
      return makeOsascriptImessageSender({ spawnProcess: fake }).sendText({
        chatGuid: "guid",
        text: "hello",
      });
    };
    expect(await outcome("execution error (-1743)", 1)).toEqual({
      outcome: "not_sent",
      code: "automation_denied",
    });
    expect(await outcome("execution error (-1728)", 1)).toEqual({
      outcome: "not_sent",
      code: "chat_not_found",
    });
    expect(await outcome("unclassified", 1)).toEqual({ outcome: "unknown", code: "unknown" });
  });
  it("settles an ambiguous timeout even if the captured child never closes", async () => {
    const child = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
      stdin: NodeStream.PassThrough;
      stdout: NodeStream.PassThrough;
      stderr: NodeStream.PassThrough;
      kill: () => boolean;
    };
    child.stdin = new NodeStream.PassThrough();
    child.stdout = new NodeStream.PassThrough();
    child.stderr = new NodeStream.PassThrough();
    let kills = 0;
    child.kill = () => {
      kills += 1;
      return false;
    };
    const spawnProcess = (() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof NodeChildProcess.spawn;
    const sender = makeOsascriptImessageSender({ spawnProcess, timeoutMs: 1 });
    const send = sender.sendText({ chatGuid: "guid", text: "hello" });
    let watchdog: NodeJS.Timeout;
    const result = await Promise.race([
      send,
      new Promise<"deadline missed">((resolve) => {
        // @effect-diagnostics-next-line globalTimers:off -- the watchdog makes a missing timeout settlement fail promptly.
        watchdog = NodeTimers.setTimeout(() => resolve("deadline missed"), 100);
      }),
    ]);
    NodeTimers.clearTimeout(watchdog!);
    expect(result).toEqual({ outcome: "unknown", code: "timeout" });
    expect(kills).toBe(1);
    child.emit("close", 0);
    expect(await send).toEqual({ outcome: "unknown", code: "timeout" });
  });
  it("passes user data as argv and a fixed script on stdin", async () => {
    const child = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
      stdin: NodeStream.PassThrough;
      stdout: NodeStream.PassThrough;
      stderr: NodeStream.PassThrough;
      kill: () => boolean;
    };
    child.stdin = new NodeStream.PassThrough();
    child.stdout = new NodeStream.PassThrough();
    child.stderr = new NodeStream.PassThrough();
    child.kill = () => true;
    let script = "";
    child.stdin.on("data", (chunk: Buffer) => {
      script += chunk.toString("utf8");
    });
    let called: { path: string; args: ReadonlyArray<string>; shell: unknown } | undefined;
    const fake = ((path: string, args: ReadonlyArray<string>, options: { shell?: boolean }) => {
      called = { path, args, shell: options.shell };
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof NodeChildProcess.spawn;
    const sender = makeOsascriptImessageSender({ spawnProcess: fake });
    const result = await sender.sendText({
      chatGuid: "iMessage;-;+15550000000",
      text: 'hello "quoted"',
    });
    expect(called).toEqual({
      path: "/usr/bin/osascript",
      args: ["-l", "AppleScript", "-", "iMessage;-;+15550000000", 'hello "quoted"'],
      shell: false,
    });
    expect(script).toBe(IMESSAGE_SCRIPT);
    expect("acceptedAt" in result).toBe(true);
  });
  it.effect("rejects inactive or wrong destinations before sending", () =>
    Effect.gen(function* () {
      let sent = 0;
      const transport = makeImessageTransport({
        connectionId: "imessage-000000000001",
        sender: {
          sendText: async () => {
            sent += 1;
            return { acceptedAt: "2026-10-19T00:00:00.000Z" };
          },
        },
        isActive: () => Effect.succeed(false),
      });
      const message = {
        deliveryId: "d" as never,
        kind: "receipt" as const,
        text: "hello",
        destination: {
          kind: "imessage" as const,
          connectionId: "imessage-000000000001",
          chatGuid: "guid",
        },
      };
      expect((yield* Effect.result(transport.send(message)))._tag).toBe("Failure");
      expect(sent).toBe(0);
      const wrong = { ...message, destination: { ...message.destination, connectionId: "wrong" } };
      expect((yield* Effect.result(transport.send(wrong)))._tag).toBe("Failure");
    }),
  );
});
