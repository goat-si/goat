/**
 * Import first in a standalone script or config: adopts legacy T3 env names before any
 * other module reads the environment. See `adoptLegacyEnv` in legacyT3Names.ts.
 */
import { adoptLegacyEnv } from "./legacyT3Names.ts";

// contracts has no Node types; only this Node-side entry needs the environment.
declare const process: { readonly env: Record<string, string | undefined> };

adoptLegacyEnv(process.env);
