import { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { createTerminalSession } from "./terminal.ts";
import { EMPTY_TERMINAL_BUFFER_STATE, type TerminalBufferState } from "./terminalSession.ts";

it("retries a failed resize once for the current attachment", async () => {
  const registry = AtomRegistry.make();
  const attachment = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const retried = Promise.withResolvers<void>();
  const calls: unknown[] = [];
  const resize = {
    label: "resize",
    run: async (_registry: AtomRegistry.AtomRegistry, value: { input: unknown }) => {
      calls.push(value.input);
      if (calls.length === 2) retried.resolve();
      return AsyncResult.failure(Cause.fail("resize failed"));
    },
  };
  const command = { label: "other", run: async () => AsyncResult.success(undefined) };
  const threadId = ThreadId.make("thread");
  const session = createTerminalSession(
    {
      attach: () => attachment,
      observe: () => attachment,
      open: command,
      resize,
      write: command,
      close: command,
    },
    {
      target: {
        environmentId: EnvironmentId.make("environment"),
        threadId,
        terminalId: "terminal",
      },
      gridSize: { cols: 80, rows: 24 },
      canOperate: () => true,
      onExit: () => {},
    },
  );
  const unmount = registry.mount(
    session.driver({ kind: "attached", input: { threadId, terminalId: "terminal", cwd: "/repo" } }),
  );
  registry.set(
    attachment,
    AsyncResult.success({
      ...EMPTY_TERMINAL_BUFFER_STATE,
      status: "running",
      version: 1,
      output: { ...EMPTY_TERMINAL_BUFFER_STATE.output, generation: 1 },
    }),
  );
  await retried.promise;
  expect(calls).toEqual([
    { threadId, terminalId: "terminal", cols: 80, rows: 24 },
    { threadId, terminalId: "terminal", cols: 80, rows: 24 },
  ]);
  unmount();
  registry.dispose();
});
