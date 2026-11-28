// Engine modules load lazily so one engine's SDK never loads into another engine's helper.
import type { EngineLoaders } from "./server.ts";

export const engineLoaders: EngineLoaders = {
  fake: async () => (await import("./engines/fake.ts")).fakeEngine,
  cursor: async () => {
    throw new Error("the cursor engine is not built yet");
  },
  opencode: async () => (await import("./engines/opencode/index.ts")).opencodeEngine,
  muse: async () => (await import("./engines/muse/index.ts")).museEngine,
};
