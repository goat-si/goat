import { EnvironmentId, ThreadId } from "@goat/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { createTerminalSession } from "./terminal.ts";
import { EMPTY_TERMINAL_BUFFER_STATE, type TerminalBufferState } from "./terminalSession.ts";

it("writes initial input once after a running attachment accepts its measured resize, including reattach", async () => {
  const registry = AtomRegistry.make();
  const attachment = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const resizeDone = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  const calls: string[] = [];
  const command = (name: string) => ({
    label: name,
    run: async () => {
      calls.push(name);
      if (name === "resize") await resizeDone.promise;
      if (name === "write") written.resolve();
      return AsyncResult.success(undefined);
    },
  });
  const threadId = ThreadId.make("thread");
  const session = createTerminalSession(
    {
      attach: () => attachment,
      observe: () => attachment,
      open: command("open"),
      resize: command("resize"),
      write: command("write"),
      close: command("close"),
    },
    {
      target: {
        environmentId: EnvironmentId.make("environment"),
        threadId,
        terminalId: "terminal",
      },
      gridSize: { cols: 80, rows: 24 },
      initialInput: "stty size\r",
      canOperate: () => true,
      onExit: () => {},
    },
  );
  const mount = registry.mount(
    session.driver({ kind: "attached", input: { threadId, terminalId: "terminal", cwd: "/repo" } }),
  );
  const emit = (status: TerminalBufferState["status"], version: number, generation = 1) =>
    registry.set(
      attachment,
      AsyncResult.success({
        ...EMPTY_TERMINAL_BUFFER_STATE,
        status,
        version,
        output: { ...EMPTY_TERMINAL_BUFFER_STATE.output, generation },
      }),
    );
  session.reportGridSize({ cols: 100, rows: 30 });
  emit("starting", 1);
  expect(calls).not.toContain("write");
  emit("running", 2);
  expect(calls).toEqual(["resize"]);
  resizeDone.resolve();
  await written.promise;
  expect(calls).toEqual(["resize", "write"]);
  emit("running", 3);
  emit("running", 0, 2);
  emit("running", 1, 2);
  expect(calls.filter((call) => call === "write")).toHaveLength(1);
  mount();
  registry.dispose();
});
