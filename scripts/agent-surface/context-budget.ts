// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a plain Node script that loads the served catalog and the instruction builders; no Effect program of its own.
/**
 * What GOAT puts into each harness's context: the served tool listing, the instruction block,
 * what a later turn adds, and (with --db) the wake messages GOAT writes into threads.
 *
 *   node scripts/agent-surface/context-budget.ts [--json] [--check] [--listing full|core] [--db <copy>]
 *
 * The listing comes from servedCatalog.ts: the registrations /mcp mounts, built in-process at the
 * checked-out commit, and passes through the server's own tools/list filter as a GOAT thread
 * receives it under agentToolListing --listing (default: the server's default listing).
 * --check exits 1 when a harness goes over BUDGET, so CI holds the context diet's targets.
 * Instruction text comes from the exported builders. Adapters compose those builders inline, so
 * each harness below names the source that composes it and a fragment that source must still
 * contain; the script exits 1 when one is missing instead of reporting a stale composition.
 * Tokens are estimated as UTF-8 bytes / 4, the rule Codex itself uses
 * (apps/server/src/provider/CodexDeveloperInstructions.ts). Pass --db only a copy, never the
 * live database; it is opened read-only.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import { type ListedTool, loadServedCatalog, repoRoot } from "./servedCatalog.ts";

const fromRepo = <T>(file: string): Promise<T> =>
  import(NodeURL.pathToFileURL(NodePath.join(repoRoot, file)).href) as Promise<T>;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const tokens = (n: number) => Math.ceil(n / 4);

const json = (value: unknown) => (value === undefined ? "" : JSON.stringify(value));
/** What a harness hands the model per tool: name, description, input schema, annotations. */
const modelFacing = (tool: ListedTool) =>
  bytes(tool.name) +
  bytes(tool.title ?? "") +
  bytes(tool.description ?? "") +
  bytes(json(tool.inputSchema)) +
  bytes(json(tool.annotations));

interface Builders {
  readonly orchestration: {
    readonly GOAT_ORCHESTRATION_INSTRUCTIONS: string;
    readonly GOAT_BROWSER_TOOL_INSTRUCTIONS: string;
    readonly goatAcpPromptWithInstructions: (input: {
      readonly prompt: string;
      readonly state: { readonly interactionMode: "default"; readonly hasGoatMcp: boolean };
    }) => string;
    readonly goatOrchestrationPromptForFirstRun: (input: {
      readonly prompt: string;
      readonly runOrdinal: number;
      readonly hasGoatMcp: boolean;
    }) => string;
    readonly goatOrchestrationSystemPrompt: (hasGoatMcp: boolean) => string;
  };
  readonly development: { readonly GOAT_DEVELOPMENT_INSTRUCTIONS: string };
  readonly runtime: {
    readonly buildRuntimeInstructions: (runtime: {
      readonly harness: string;
      readonly model?: string;
      readonly reasoningEffort?: string;
    }) => string;
  };
  readonly memory: { readonly MEMORY_DATA_BOUNDARY_REMINDER: string };
  readonly codex: {
    readonly buildCodexAdditionalContext: (
      runtime: { readonly model: string; readonly reasoningEffort: string },
      tools: { readonly browser: boolean; readonly device: boolean; readonly computerUse: boolean },
    ) => Record<string, { readonly value: string }>;
    readonly buildCodexDeveloperInstructions: (mode: "default") => string;
  };
}

const loadBuilders = async (): Promise<Builders> => ({
  orchestration: await fromRepo("packages/provider-core/src/server/orchestrationInstructions.ts"),
  development: await fromRepo("packages/provider-core/src/server/developmentInstructions.ts"),
  runtime: await fromRepo("packages/provider-core/src/server/runtimeInstructions.ts"),
  memory: await fromRepo("packages/provider-core/src/server/memoryContext.ts"),
  codex: await fromRepo("apps/server/src/provider/CodexDeveloperInstructions.ts"),
});

/** A fixed turn: default mode, GOAT MCP attached, browser tools on, device and computer use off. */
const MODEL = "model-slug";
const PROMPT = "";
const MEMORY_TOOLS_LINE =
  "GOAT memory tools: read=true, write=true, source=true. Unavailable or denied tools must not be claimed.";

type Delivery = "listed" | "harness may defer";
interface Harness {
  readonly name: string;
  /** Where the block goes and how often GOAT sends it. */
  readonly carrier: string;
  readonly delivery: Delivery;
  readonly composedIn: string;
  /** Text the composing source must still contain for this composition to be current. */
  readonly mustContain: ReadonlyArray<string>;
  readonly firstTurn: (b: Builders) => string;
  /** What GOAT appends to every later turn's input; resident blocks are not resent. */
  readonly laterTurn: (b: Builders) => string;
}

const harnesses: ReadonlyArray<Harness> = [
  {
    name: "Codex (code mode)",
    carrier:
      "turn additionalContext + collaboration-mode developer instructions; resent on change or after compaction",
    delivery: "harness may defer",
    composedIn: "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
    mustContain: ["buildCodexAdditionalContext(", "developer_instructions: developerInstructions"],
    firstTurn: (b) =>
      Object.values(
        b.codex.buildCodexAdditionalContext(
          { model: MODEL, reasoningEffort: "high" },
          { browser: true, device: false, computerUse: false },
        ),
      )
        .map((entry) => entry.value)
        .join("") + b.codex.buildCodexDeveloperInstructions("default"),
    laterTurn: () => "",
  },
  {
    name: "Claude",
    carrier: "appended system prompt, resident on every request",
    delivery: "harness may defer",
    composedIn: "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
    mustContain: [
      'harness: "Claude Code"',
      "MemoryContext.MEMORY_DATA_BOUNDARY_REMINDER",
      'GOAT_DEVELOPMENT_INSTRUCTIONS +\n          (input.mcpServers === undefined ? "" : GOAT_ORCHESTRATION_INSTRUCTIONS)',
    ],
    firstTurn: (b) =>
      [
        b.runtime.buildRuntimeInstructions({ harness: "Claude Code" }),
        b.memory.MEMORY_DATA_BOUNDARY_REMINDER,
        b.development.GOAT_DEVELOPMENT_INSTRUCTIONS +
          b.orchestration.GOAT_ORCHESTRATION_INSTRUCTIONS,
      ].join("\n\n"),
    laterTurn: () => "",
  },
  {
    name: "OpenCode",
    carrier: "session instructions entry, resident; rewritten when it changes",
    delivery: "listed",
    composedIn: "packages/provider-opencode/src/server/v2/adapter.ts",
    mustContain: [
      'harness: "OpenCode"',
      "goatOrchestrationSystemPrompt(mcpAvailable)",
      "GOAT memory tools: read=",
    ],
    firstTurn: (b) =>
      [
        b.runtime.buildRuntimeInstructions({ harness: "OpenCode", model: MODEL }),
        b.orchestration.goatOrchestrationSystemPrompt(true),
        MEMORY_TOOLS_LINE,
      ].join("\n\n"),
    laterTurn: () => "",
  },
  {
    name: "Cursor",
    carrier: "prepended to the first user message; runtime block appended to every message",
    delivery: "listed",
    composedIn: "packages/provider-cursor/src/server/adapter.ts",
    mustContain: [
      "goatOrchestrationPromptForFirstRun({",
      'harness: "Cursor"',
      "GOAT memory tools: read=",
    ],
    firstTurn: (b) =>
      [
        b.orchestration.goatOrchestrationPromptForFirstRun({
          prompt: PROMPT,
          runOrdinal: 1,
          hasGoatMcp: true,
        }),
        b.runtime.buildRuntimeInstructions({ harness: "Cursor", model: MODEL }),
        MEMORY_TOOLS_LINE,
      ].join("\n\n"),
    laterTurn: (b) =>
      [
        "",
        b.runtime.buildRuntimeInstructions({ harness: "Cursor", model: MODEL }),
        MEMORY_TOOLS_LINE,
      ].join("\n\n"),
  },
  {
    name: "ACP",
    carrier:
      "prepended to the first prompt and after mode change or compaction; runtime block on every prompt",
    delivery: "listed",
    composedIn: "packages/provider-acp/src/server/adapter.ts",
    mustContain: ["goatAcpPromptWithInstructions({", "text: buildRuntimeInstructions({"],
    firstTurn: (b) =>
      b.orchestration.goatAcpPromptWithInstructions({
        prompt: PROMPT,
        state: { interactionMode: "default", hasGoatMcp: true },
      }) + b.runtime.buildRuntimeInstructions({ harness: "ACP", model: MODEL }),
    laterTurn: (b) => b.runtime.buildRuntimeInstructions({ harness: "ACP", model: MODEL }),
  },
  {
    name: "Pi",
    carrier: "system prompt sections, resident on every request",
    delivery: "harness may defer",
    composedIn: "packages/provider-pi/src/server/mcpExtensionSource.ts",
    mustContain: [
      "sections.goat_code_development = DEVELOPMENT_INSTRUCTIONS;",
      "sections.goat_code_orchestration = ORCHESTRATION_INSTRUCTIONS;",
    ],
    firstTurn: (b) =>
      [
        b.development.GOAT_DEVELOPMENT_INSTRUCTIONS,
        b.orchestration.GOAT_ORCHESTRATION_INSTRUCTIONS.trim(),
      ].join("\n\n"),
    laterTurn: () => "",
  },
];

interface WakeStats {
  readonly kind: string;
  readonly count: number;
  readonly median: number;
  readonly p90: number;
  readonly max: number;
}

/** Messages the server itself wrote into threads (wakes, completions), grouped by kind. */
async function wakeMessages(dbPath: string): Promise<ReadonlyArray<WakeStats>> {
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare("select payload_json from orchestration_v2_projection_messages where role = 'user'")
    .all();
  const groups = new Map<string, Array<number>>();
  for (const row of rows) {
    if (typeof row.payload_json !== "string") continue;
    const payload = JSON.parse(row.payload_json) as {
      readonly creationSource?: string;
      readonly text?: string;
      readonly notification?: { readonly source?: { readonly kind?: string } };
      readonly delegatedCompletion?: unknown;
    };
    if (payload.creationSource !== "server") continue;
    const kind =
      payload.delegatedCompletion !== undefined
        ? "delegated_completion"
        : (payload.notification?.source?.kind ?? "other");
    groups.set(kind, [...(groups.get(kind) ?? []), bytes(payload.text ?? "")]);
  }
  return [...groups].map(([kind, sizes]) => {
    const sorted = sizes.toSorted((a, b) => a - b);
    const at = (q: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return { kind, count: sorted.length, median: at(0.5), p90: at(0.9), max: sorted.at(-1) ?? 0 };
  });
}

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const argv = process.argv.slice(2);
const dbIndex = argv.indexOf("--db");
const dbPath = dbIndex === -1 ? undefined : argv[dbIndex + 1];
const { DEFAULT_AGENT_TOOL_LISTING } = await fromRepo<{
  readonly DEFAULT_AGENT_TOOL_LISTING: string;
}>("packages/contracts/src/agentSurface/listing.ts");
const listingIndex = argv.indexOf("--listing");
const listingMode = listingIndex === -1 ? DEFAULT_AGENT_TOOL_LISTING : argv[listingIndex + 1];
if (listingMode !== "full" && listingMode !== "core") {
  console.error("--listing takes full or core");
  process.exit(1);
}

const stale = harnesses.flatMap((harness) => {
  const source = NodeFS.readFileSync(NodePath.join(repoRoot, harness.composedIn), "utf8");
  return harness.mustContain
    .filter((fragment) => !source.includes(fragment))
    .map(
      (fragment) =>
        harness.name +
        ": " +
        harness.composedIn +
        " no longer contains " +
        JSON.stringify(fragment),
    );
});
if (stale.length > 0) {
  console.error("Composition changed; update context-budget.ts:\n" + stale.join("\n"));
  process.exit(1);
}

const builders = await loadBuilders();
const catalog = await loadServedCatalog();
const listed = await catalog.listedAsThread(listingMode);
await catalog.dispose();
const perTool = listed
  .map((tool) => ({ name: tool.name, bytes: modelFacing(tool) }))
  .toSorted((a, b) => b.bytes - a.bytes);
const listing = {
  mode: listingMode,
  tools: listed.length,
  modelFacingBytes: perTool.reduce((sum, tool) => sum + tool.bytes, 0),
  descriptionBytes: listed.reduce((sum, tool) => sum + bytes(tool.description ?? ""), 0),
  inputSchemaBytes: listed.reduce((sum, tool) => sum + bytes(json(tool.inputSchema)), 0),
  outputSchemaBytes: listed.reduce((sum, tool) => sum + bytes(json(tool.outputSchema)), 0),
  toolsListBytes: bytes(JSON.stringify(listed)),
  largest: perTool.slice(0, 10),
};
const rows = harnesses.map((harness) => {
  const instructions = bytes(harness.firstTurn(builders));
  const laterTurn = bytes(harness.laterTurn(builders));
  return {
    harness: harness.name,
    carrier: harness.carrier,
    delivery: harness.delivery,
    instructionBytes: instructions,
    firstPromptBytes: instructions + listing.modelFacingBytes,
    laterTurnBytes: laterTurn,
  };
});
/** The always-injected targets every harness keeps (D21 in docs/internals/agent-surface.md). */
const BUDGET = {
  instructionBytes: 6 * 1024,
  listingBytes: 6 * 1024,
  firstPromptBytes: 12 * 1024,
  laterTurnBytes: 300,
} as const;
const overBudget = rows.flatMap((row) =>
  (
    [
      ["instructions", row.instructionBytes, BUDGET.instructionBytes],
      ["listing", listing.modelFacingBytes, BUDGET.listingBytes],
      ["first prompt", row.firstPromptBytes, BUDGET.firstPromptBytes],
      ["each later turn", row.laterTurnBytes, BUDGET.laterTurnBytes],
    ] as const
  )
    .filter(([, measured, limit]) => measured > limit)
    .map(([what, measured, limit]) => `${row.harness}: ${what} ${measured} B, over ${limit} B`),
);
const report = {
  commit: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
  tokenEstimate: "utf8 bytes / 4",
  listing,
  harnesses: rows,
  budget: BUDGET,
  overBudget,
  wakes: dbPath === undefined ? null : await wakeMessages(dbPath),
};

if (argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const n = (value: number) => value.toLocaleString("en-US");
  const kb = (value: number) => n(value) + " B (~" + n(tokens(value)) + " tok)";
  const out = [
    "Commit " +
      report.commit +
      (report.dirty ? " (dirty)" : "") +
      "; tokens estimated as UTF-8 bytes / 4.",
    "",
    "Served listing (agentToolListing " +
      listing.mode +
      "): " +
      listing.tools +
      " tools, " +
      kb(listing.modelFacingBytes) +
      " model-facing (name, description, input schema, annotations); descriptions " +
      n(listing.descriptionBytes) +
      " B, input schemas " +
      n(listing.inputSchemaBytes) +
      " B; output schemas add " +
      n(listing.outputSchemaBytes) +
      " B to the " +
      n(listing.toolsListBytes) +
      " B tools/list payload.",
    "",
    "| Harness | Instructions | First prompt (instructions + listing) | Each later turn | Listing | Carrier |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...rows.map(
      (row) =>
        "| " +
        row.harness +
        " | " +
        kb(row.instructionBytes) +
        " | " +
        kb(row.firstPromptBytes) +
        " | " +
        kb(row.laterTurnBytes) +
        " | " +
        row.delivery +
        " | " +
        row.carrier +
        " |",
    ),
    "",
    "Largest tools (model-facing bytes): " +
      listing.largest.map((tool) => tool.name + " " + n(tool.bytes)).join(", "),
    "",
    "Budget per harness: instructions " +
      n(BUDGET.instructionBytes) +
      " B, listing " +
      n(BUDGET.listingBytes) +
      " B, first prompt " +
      n(BUDGET.firstPromptBytes) +
      " B, each later turn " +
      n(BUDGET.laterTurnBytes) +
      " B. " +
      (overBudget.length === 0 ? "Every harness is within it." : overBudget.join("; ") + "."),
  ];
  if (report.wakes !== null) {
    out.push(
      "",
      "| Wake kind | Count | Median B | p90 B | Max B |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...report.wakes.map(
        (wake) =>
          "| " +
          wake.kind +
          " | " +
          wake.count +
          " | " +
          wake.median +
          " | " +
          wake.p90 +
          " | " +
          wake.max +
          " |",
      ),
    );
  }
  console.log(out.join("\n"));
}
if (argv.includes("--check") && overBudget.length > 0) {
  console.error(
    "Over the context budget under agentToolListing " + listingMode + ":\n" + overBudget.join("\n"),
  );
  process.exitCode = 1;
}
