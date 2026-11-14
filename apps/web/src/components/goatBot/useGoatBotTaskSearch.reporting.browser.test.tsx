import { BotProfile } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  releases: new Map<string, () => void>(),
  completed: new Map<string, () => void>(),
  navigate: vi.fn(),
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { goatBotTaskLookupSearch: true } } }]]),
}));
vi.mock("~/state/channels", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const { createRuntimeCommand } = await import("@goat/client-runtime/state/runtime");
  const command = createRuntimeCommand(Atom.runtime(Layer.empty), {
    label: "environment-data:channel:search-bot-tasks",
    execute: ({ input }: { input: { query: string } }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            state.releases.set(input.query, resolve);
          }),
      ).pipe(Effect.andThen(Effect.die(new Error(`defect ${input.query}`)))),
  });
  return {
    channelEnvironment: {
      searchBotTasks: {
        ...command,
        permissionAtom: () => Atom.make(true),
        run: async (
          registry: Parameters<typeof command.run>[0],
          target: Parameters<typeof command.run>[1],
        ) => {
          const result = await command.run(registry, target);
          state.completed.get(target.input.query)?.();
          return result;
        },
      },
    },
  };
});
import { useGoatBotTaskSearch } from "./useGoatBotTaskSearch";
const decode = Schema.decodeSync(BotProfile);
const bot = decode({
  botId: "main",
  role: "main",
  name: "Goaty",
  avatar: null,
  purpose: "",
  defaultModelSelection: null,
  defaultProjectId: null,
  environmentId: "env",
  sessionThreadId: "thread",
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
});
function Search({ query, enabled = true }: { query: string; enabled?: boolean }) {
  const result = useGoatBotTaskSearch([bot], query, enabled, state.navigate);
  return <div role="status">{result.status}</div>;
}

it.each(["superseded", "closed", "current"] as const)(
  "reports only a current defect: %s",
  async (scenario) => {
    state.releases.clear();
    state.completed.clear();
    let done!: () => void;
    const completed = new Promise<void>((resolve) => {
      done = resolve;
    });
    state.completed.set("a", done);
    await using screen = await render(<Search query="" />);
    using _clock = fakeTimers();
    using errors = vi.spyOn(console, "error");
    await screen.rerender(<Search query="a" />);
    await act(() => vi.advanceTimersByTimeAsync(250));
    await vi.waitFor(() => expect(state.releases.has("a")).toBe(true));
    if (scenario === "superseded") await screen.rerender(<Search query="ab" />);
    if (scenario === "closed") await screen.rerender(<Search query="a" enabled={false} />);
    await act(async () => {
      state.releases.get("a")?.();
      await completed;
    });
    if (scenario === "current") {
      await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
      expect(errors.mock.calls[0]?.[0]).toBe(
        "[atom-command] environment-data:channel:search-bot-tasks defected",
      );
    } else {
      expect(errors).not.toHaveBeenCalled();
    }
  },
);
