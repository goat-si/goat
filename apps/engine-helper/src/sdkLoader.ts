// Loads an engine's SDK package, or a fake when GOAT2_ENGINE_HELPER_SDK_<ENGINE> names one.
import * as NodeModule from "node:module";
import { pathToFileURL } from "node:url";

import type { EngineKind } from "./protocol.ts";

// createRequire keeps adjacent Webpack chunks and native modules resolvable (v1
// provider-cursor/src/server/sdk.ts:4-6).
const requireFromHelper = NodeModule.createRequire(import.meta.url);

export function fakeSdkPath(engine: EngineKind, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[`GOAT2_ENGINE_HELPER_SDK_${engine.toUpperCase()}`];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/** Import `specifier` (ESM first, CommonJS fallback), unless a fake module is configured. */
export async function loadSdk<T>(engine: EngineKind, specifier: string): Promise<T> {
  const fake = fakeSdkPath(engine);
  if (fake !== undefined) return (await import(pathToFileURL(fake).href)) as T;
  try {
    return (await import(specifier)) as T;
  } catch (error) {
    try {
      return requireFromHelper(specifier) as T;
    } catch {
      throw error;
    }
  }
}
