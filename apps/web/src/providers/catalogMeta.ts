// What the provider screens say about each driver kind (boards 1PBB-2, 1QAN-2, 2LET-2). Kinds and cloud counterparts
// come from v1 providerDriverMeta.ts (goat 916b5ccc1b2); presets are v1's local presets, read from the lifted file.
import { ACP_LOCAL_PRESETS } from "../v1/packages/provider-acp-registry/src/localPresets.ts";

export interface DriverMeta { label: string; blurb: string; cloud?: string }

/** The local kinds GOAT 2 lists (v1 providerDriverMeta.ts order) with the catalog line and the cloud counterpart. */
export const DRIVERS: Readonly<Record<string, DriverMeta>> = {
  codex: { label: "Codex", blurb: "OpenAI's coding agent. Uses your ChatGPT sign-in." },
  claudeAgent: { label: "Claude", blurb: "Anthropic's coding agent. Uses your Claude sign-in.", cloud: "claudeCloud" },
  grok: { label: "Grok", blurb: "xAI\u2019s coding agent. Uses your Grok sign-in." },
  fx: { label: "fx", blurb: "Runs in your terminal setup." },
  antigravity: { label: "Antigravity", blurb: "Google's coding agent. Uses your Google sign-in." },
  opencode: { label: "OpenCode", blurb: "Open source agent that runs models from many providers." },
  cursor: { label: "Cursor", blurb: "Cursor's agent. Uses your Cursor account.", cloud: "cursorCloud" },
  muse: { label: "Muse Code", blurb: "Meta\u2019s coding agent. Beta." },
  pi: { label: "Pi", blurb: "Minimal agent that runs the model you set up in Pi." },
  omo: { label: "OmO", blurb: "Runs on Pi with a team of helper agents." },
  acpRegistry: { label: "Agent", blurb: "An agent from the open agent registry." },
};

/** Cloud counterparts and platforms (v1 providerDriverMeta.ts). GOAT 2 runs cloud work in a later part. */
export const CLOUD: Readonly<Record<string, DriverMeta & { platform: boolean; blurbOptIn: string }>> = {
  claudeCloud: { label: "Claude Cloud", platform: false, blurb: "Claude on Anthropic's cloud machines.",
    blurbOptIn: "Let bots hand long work to Claude\u2019s cloud machines, so it keeps running when this Mac sleeps. Uses the same Claude account." },
  cursorCloud: { label: "Cursor Cloud", platform: false, blurb: "Cursor's agents on Cursor's cloud.",
    blurbOptIn: "Let bots hand long work to Cursor\u2019s cloud agents, so it keeps running when this Mac sleeps. Uses the same Cursor account." },
  devinCloud: { label: "Devin Cloud", platform: true, blurb: "Runs entirely on Devin\u2019s cloud. Nothing to install.", blurbOptIn: "" },
};

export const CLOUD_LATER = "Cloud runs come in a later GOAT 2 release.";

export const PRESETS = ACP_LOCAL_PRESETS.map((p) => ({ id: p.id, label: p.label, iconUrl: p.iconUrl, installHint: p.installHint, docsUrl: p.docsUrl }));

export const driverLabel = (driver: string) => DRIVERS[driver]?.label ?? CLOUD[driver]?.label ?? driver;

