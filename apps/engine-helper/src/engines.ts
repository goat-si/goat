// Engine modules load lazily so one engine's SDK never loads into another engine's helper.
import type { EngineLoaders } from "./server.ts";

export const engineLoaders: EngineLoaders = {
  fake: async () => (await import("./engines/fake.ts")).fakeEngine,
  cursor: async () => {
    throw new Error("the cursor engine is not built yet");
  },
  opencode: async () => {
    throw new Error("the opencode engine is not built yet");
  },
  muse: async () => {
    throw new Error("the muse engine is not built yet");
  },
};
