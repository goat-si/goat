import { vi } from "vite-plus/test";

vi.mock("../state/memory", async () => {
  const { Atom } = await import("effect/reactivity");
  const unavailable = Atom.make(false);
  return { memoryEnvironment: { canInspectTurnMemory: () => unavailable } };
});
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    searchEntries: (input: unknown) => input,
    fileMetadata: (input: unknown) => input,
  },
}));
vi.mock("../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: () => true,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://example.com" } }),
  environmentSession: { preparedConnectionValueAtom: () => null },
}));
