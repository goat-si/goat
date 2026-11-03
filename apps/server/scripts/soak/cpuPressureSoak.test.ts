// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { describe, expect, it } from "@effect/vitest";

describe("soak Codex fixture", () => {
  it("keeps concurrent threads and turn notifications distinct", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-codex-soak-"));
    const script = NodePath.join(dir, "script.json");
    const log = NodePath.join(dir, "lifecycle.ndjson");
    NodeFS.writeFileSync(script, JSON.stringify({ rootThreadId: "unused", notifications: [] }));
    const fixture = new URL(
      "../../src/provider/testFixtures/codexCollabMockPeer.mjs",
      import.meta.url,
    );
    const child = NodeChildProcess.spawn(process.execPath, [fixture.pathname], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        GOAT_CODEX_COLLAB_SCRIPT: script,
        GOAT_CODEX_MOCK_SOAK: "1",
        GOAT_CODEX_MOCK_LATENCIES_MS: "0",
        GOAT_CODEX_MOCK_TURN_MS: "0",
        GOAT_SOAK_PROVIDER_LIFECYCLE_LOG: log,
      },
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const lines = NodeReadline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const send = (id: number, method: string, params: object) =>
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    try {
      send(1, "thread/start", { cwd: "/tmp" });
      send(2, "thread/start", { cwd: "/tmp" });
      const first = JSON.parse((await lines.next()).value as string);
      const second = JSON.parse((await lines.next()).value as string);
      const ids = [first.result.thread.id, second.result.thread.id];
      expect(new Set(ids).size).toBe(2);
      send(3, "turn/start", { threadId: ids[0], input: [] });
      send(4, "turn/start", { threadId: ids[1], input: [] });
      const messages = [];
      while (messages.filter((message) => message.method === "turn/completed").length < 2) {
        messages.push(JSON.parse((await lines.next()).value as string));
      }
      expect(
        messages
          .filter((message) => message.method === "turn/completed")
          .map((message) => message.params.threadId)
          .sort(),
      ).toEqual(ids.sort());
      expect(
        new Set(
          messages
            .filter((message) => message.id === 3 || message.id === 4)
            .map((message) => message.result.turn.id),
        ).size,
      ).toBe(2);
      child.stdin.end();
      expect(await exited).toBe(0);
      const events = NodeFS.readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual(["start", "session", "session", "exit"]);
    } finally {
      if (child.exitCode === null) child.kill();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
