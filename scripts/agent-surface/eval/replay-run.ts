// @effect-diagnostics nodeBuiltinImport:off - offline replay context and trace files, never a provider client.
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import { loadServedCatalog } from "../servedCatalog.ts";
import { REPLAY_VERSION, replayCases } from "./replay-cases.ts";
import { decodeReplayRun, gradeReplay } from "./replay.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    case: { type: "string" },
    listing: { type: "string", default: "core" },
    context: { type: "boolean", default: false },
    trace: { type: "string" },
  },
});
const testCase = replayCases.find((entry) => entry.id === values.case);
if (!testCase)
  throw new Error("--case must name one of: " + replayCases.map((entry) => entry.id).join(", "));
const listing = values.listing;
if (listing !== "core" && listing !== "full") throw new Error("--listing must be core or full");
if (values.context === Boolean(values.trace))
  throw new Error("Choose --context or --trace <file.json>");

const catalog = await loadServedCatalog();
try {
  const tools = await catalog.listedAsThread(listing);
  if (values.context) {
    // Loaded at runtime: the scripts project does not compile provider-core.
    const instructions = (await import(
      new URL(
        "../../../packages/provider-core/src/server/orchestrationInstructions.ts",
        import.meta.url,
      ).href
    )) as {
      readonly goatOrchestrationSystemPrompt: (hasGoatMcp: boolean) => string;
      readonly GOAT_BROWSER_TOOL_INSTRUCTIONS: string;
    };
    console.log(
      JSON.stringify(
        {
          version: REPLAY_VERSION,
          caseId: testCase.id,
          listing,
          role: testCase.role,
          instructions:
            instructions.goatOrchestrationSystemPrompt(true) +
            instructions.GOAT_BROWSER_TOOL_INSTRUCTIONS,
          tools,
          priorTurns: testCase.priorTurns,
          prompt: testCase.prompt,
        },
        null,
        2,
      ),
    );
  } else {
    const tracePath = values.trace;
    if (!tracePath) throw new Error("--trace needs a file path");
    const raw: unknown = JSON.parse(NodeFS.readFileSync(tracePath, "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("version" in raw) ||
      raw.version !== REPLAY_VERSION ||
      !("caseId" in raw) ||
      raw.caseId !== testCase.id ||
      !("listing" in raw) ||
      raw.listing !== listing
    )
      throw new Error("Trace version, caseId and listing must match the replay context");
    const checks = gradeReplay(
      testCase.expect,
      decodeReplayRun(raw),
      tools.map((tool) => tool.name),
    );
    const pass = checks.every((check) => check.pass);
    console.log(
      JSON.stringify(
        { version: REPLAY_VERSION, caseId: testCase.id, listing, pass, checks },
        null,
        2,
      ),
    );
    if (!pass) process.exitCode = 1;
  }
} finally {
  await catalog.dispose();
}
