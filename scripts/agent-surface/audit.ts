// @effect-diagnostics nodeBuiltinImport:off - a plain Node script that reads source text and loads the registries; no Effect runtime.
/**
 * Renders docs/internals/agent-surface-audit.md from the live inventory in
 * ./inventory.ts plus a scan of docs and agent prompts for drift.
 *
 *   node scripts/agent-surface/audit.ts           # rewrite the doc
 *   node scripts/agent-surface/audit.ts --check   # exit 1 when the doc is stale
 *
 * Every count, list, and path:line below is computed; only the wording of the
 * findings and the ranking of fixes live in this file.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  type CliEntry,
  type Inventory,
  type SourceRef,
  collectInventory,
  readLines,
  repoRoot,
  sourceFiles,
} from "./inventory.ts";
import { at, files, ref } from "./citations.ts";
import { SHIPPED_TOOL_NAMES, toolTokensIn } from "./listedNames.ts";
import { code, groupBy, list, pct, table, TICK } from "./markdown.ts";

const OUTPUT = "docs/internals/agent-surface-audit.md";

interface Mention {
  readonly token: string;
  readonly ref: SourceRef;
}

const DOC_FILES = () => [
  ...sourceFiles(["docs"], ".md").filter((file) => file !== OUTPUT),
  ...sourceFiles(["structure"], ".md"),
  ...sourceFiles([".agents/skills"], ".md"),
  "AGENTS.md",
  "CONTRIBUTING.md",
  "README.md",
];
const PROMPT_FILES = () =>
  sourceFiles(["packages/provider-core/src/server"]).filter((file) =>
    file.endsWith("Instructions.ts"),
  );

// Metric, table, and enum names share the snake_case shape. In Markdown, count a
// name only inside a code span on a line that talks about tools; prompts are
// all agent-facing text, so every name there counts.
const TOOL_CONTEXT = /\btools?\b|\bMCP\b|\bcall(s|ed|ing)?\b/i;

const toolMentions = (
  files: ReadonlyArray<string>,
  firstSegments: ReadonlySet<string>,
  markdown: boolean,
): Array<Mention> => {
  const out: Array<Mention> = [];
  for (const file of files) {
    readLines(file).forEach((line, index) => {
      const prefixed = [...line.matchAll(/mcp__goat__([a-z][a-z0-9_]*)/g)].map(
        (match) => match[1] ?? "",
      );
      const texts = markdown
        ? TOOL_CONTEXT.test(line)
          ? [...line.matchAll(SPAN)]
              .map((match) => match[1] ?? "")
              .filter((span) => !span.startsWith("<"))
          : []
        : [line];
      const tokens = texts.flatMap(toolTokensIn);
      for (const token of new Set([...prefixed, ...tokens])) {
        const first = token.split("_")[0] ?? "";
        if (first === "goat" || firstSegments.has(first) || token.includes(".")) {
          out.push({ token, ref: { path: file, line: index + 1 } });
        }
      }
    });
  }
  return out;
};

interface CliMention {
  readonly text: string;
  readonly ref: SourceRef;
}

const FENCE = new RegExp("^\\s*" + TICK + TICK + TICK);
const SPAN = new RegExp(TICK + "([^" + TICK + "]+)" + TICK, "g");

const cliMentions = (files: ReadonlyArray<string>): Array<CliMention> => {
  const out: Array<CliMention> = [];
  for (const file of files) {
    let fenced = false;
    readLines(file).forEach((line, index) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return;
      }
      const spans = fenced
        ? [line.replace(/^\s*\$\s+/, "").trim()]
        : [...line.matchAll(SPAN)].map((match) => match[1] ?? "");
      for (const span of spans) {
        const text = span.replace(/^sudo\s+/, "").replace(/\s+\\$/, "");
        if (/^goat\s+[a-z-]/.test(text)) out.push({ text, ref: { path: file, line: index + 1 } });
      }
    });
  }
  return out;
};

interface CliDrift {
  readonly text: string;
  readonly ref: SourceRef;
  readonly problem: string;
}

const checkCliMention = (mention: CliMention, cli: ReadonlyArray<CliEntry>): CliDrift | null => {
  const words = mention.text.split(/\s+/);
  let entry = cli.find((command) => command.path.length === 1);
  let consumed = 1;
  for (let index = 1; index < words.length; index++) {
    const word = words[index] ?? "";
    if (word.startsWith("-") || word.startsWith("<") || !/^[a-z][a-z-]*$/.test(word)) break;
    const path = [...words.slice(0, index), word].join(" ");
    const child = cli.find((command) => command.path.join(" ") === path);
    if (!child) {
      const takesArgument = entry?.params.some((param) => param.kind === "argument") ?? false;
      if (entry && entry.subcommands.length > 0 && !takesArgument) {
        return {
          text: mention.text,
          ref: mention.ref,
          problem: "no subcommand " + code(word) + " under " + code(entry.path.join(" ")),
        };
      }
      break;
    }
    entry = child;
    consumed = index + 1;
  }
  if (!entry) return null;
  const flags = new Set(
    entry.params.filter((param) => param.kind === "flag").map((param) => param.name),
  );
  for (const word of words.slice(consumed)) {
    const flag = /^(--[a-z][a-z0-9-]*)/.exec(word)?.[1];
    if (flag && flag !== "--help" && flag !== "--version" && !flags.has(flag)) {
      return {
        text: mention.text,
        ref: mention.ref,
        problem: code(entry.path.join(" ")) + " has no " + code(flag),
      };
    }
  }
  return null;
};

const SYNONYMS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["read one thing", ["read", "get", "status", "configuration"]],
  ["list things", ["list", "inventory", "transfers", "reports", "search"]],
  [
    "remove or stop",
    [
      "delete",
      "remove",
      "discard",
      "cancel",
      "stop",
      "close",
      "unlink",
      "unwatch",
      "cleanup",
      "interrupt",
    ],
  ],
  ["change", ["update", "configure", "edit", "organize", "reorder", "set_appearance"]],
  ["start work", ["launch", "delegate", "create", "send", "fork", "schedule", "run", "clone"]],
];

const usesVerb = (name: string, verb: string) =>
  name === verb ||
  name.startsWith(verb + "_") ||
  name.endsWith("_" + verb) ||
  name.includes("_" + verb + "_");

function analyse(inventory: Inventory) {
  const tools = inventory.tools;
  const mutating = tools.filter((tool) => tool.mutating);
  const fields = tools.flatMap((tool) => tool.input.fields);
  const firstSegments = new Set(tools.map((tool) => tool.name.split("_")[0] ?? ""));
  const knownNames = new Set([...tools.map((tool) => tool.name), ...SHIPPED_TOOL_NAMES.keys()]);
  // Error codes share the snake_case shape; they are not tools.
  const codes = new Set(tools.flatMap((tool) => tool.error.codes));
  // Strict scan finds names that do not exist; loose scan measures coverage.
  const docMentions = toolMentions(DOC_FILES(), firstSegments, true);
  const docCoverage = toolMentions(DOC_FILES(), firstSegments, false);
  const promptMentions = toolMentions(PROMPT_FILES(), firstSegments, false);
  const unknown = (mentions: ReadonlyArray<Mention>) =>
    mentions.filter(
      (mention) =>
        !knownNames.has(mention.token) &&
        !codes.has(mention.token) &&
        // Stems of real names, such as goat_thread in "goat_thread_*".
        ![...knownNames].some((name) => name.startsWith(mention.token + "_")),
    );
  const shipped = (mention: Mention) => SHIPPED_TOOL_NAMES.get(mention.token) ?? mention.token;
  const docSet = new Set(docCoverage.map(shipped));
  const promptSet = new Set(promptMentions.map(shipped));
  const cliDocMentions = cliMentions(DOC_FILES());
  const cliDrift = cliDocMentions
    .map((mention) => checkCliMention(mention, inventory.cli))
    .filter((drift): drift is CliDrift => drift !== null);
  const documentedCli = new Set(
    cliDocMentions.map((mention) => {
      const words = mention.text.split(/\s+/);
      let best = "goat";
      for (const command of inventory.cli) {
        const path = command.path.join(" ");
        if (words.slice(0, command.path.length).join(" ") === path && path.length > best.length)
          best = path;
      }
      return best;
    }),
  );
  const hintMismatch = tools.filter(
    (tool) =>
      tool.access !== null &&
      tool.access !== "actsAsCaller" &&
      tool.hints.readOnly === tool.mutating,
  );
  const actsAsCallerReads = tools.filter(
    (tool) =>
      tool.access === "actsAsCaller" &&
      !tool.hints.readOnly &&
      /(_status|_read|_list)$/.test(tool.name),
  );
  return {
    tools,
    mutating,
    fields,
    unknownDoc: unknown(docMentions),
    unknownPrompt: unknown(promptMentions),
    undocumented: tools.filter((tool) => !docSet.has(tool.name)).map((tool) => tool.name),
    unprompted: tools
      .filter((tool) => !promptSet.has(tool.name) && !docSet.has(tool.name))
      .map((tool) => tool.name),
    cliDrift,
    undocumentedCli: inventory.cli.filter(
      (command) =>
        !command.unlisted &&
        command.path.length > 1 &&
        command.subcommands.length === 0 &&
        !documentedCli.has(command.path.join(" ")),
    ),
    hintMismatch,
    actsAsCallerReads,
  };
}

export function render(inventory: Inventory): string {
  const a = analyse(inventory);
  const { tools, mutating, fields } = a;
  const cli = inventory.cli;
  const toolkits = groupBy(tools, (tool) => tool.toolkit);
  const shapes = groupBy(tools, (tool) => tool.naming.shape);
  const failureModes = groupBy(tools, (tool) => tool.error.failureMode);
  const undescribed = fields.filter((field) => !field.described);
  const allUndescribed = tools.filter(
    (tool) =>
      tool.input.fields.length > 0 && tool.input.undescribed.length === tool.input.fields.length,
  );
  const mutatingWithoutCrid = mutating.filter((tool) => !tool.clientRequestId);
  const withCrid = tools.filter((tool) => tool.clientRequestId);
  const paginated = tools.filter((tool) => tool.pagination.length > 0);
  const paginationStyles = groupBy(paginated, (tool) =>
    tool.pagination.includes("nextCursor")
      ? "cursor/nextCursor"
      : tool.pagination.includes("afterSequence")
        ? "afterSequence/hasMore"
        : tool.pagination.includes("hasMore")
          ? "limit/hasMore"
          : "limit only",
  );
  const unlimitedLists = tools.filter(
    (tool) => /_list$|^list_/.test(tool.name) && tool.pagination.length === 0,
  );
  const longest = [...tools].sort((x, y) => y.descriptionLength - x.descriptionLength).slice(0, 6);
  const withExamples = tools.filter((tool) => tool.descriptionHasExample);
  const untitled = tools.filter((tool) => tool.title === null);
  const extraKeys = tools.filter((tool) => tool.acceptsUndeclaredArguments);
  const errorFamilies = groupBy(tools, (tool) => tool.error.tags.join("+"));
  const human = tools.filter((tool) => tool.humanSteps.length > 0);
  const listedCli = cli.filter((command) => !command.unlisted);
  const leafCli = listedCli.filter(
    (command) => command.subcommands.length === 0 && command.path.length > 1,
  );
  const jsonCli = leafCli.filter((command) => command.jsonOutput);
  const exampleCli = cli.filter((command) => command.examples > 0);
  const undescribedCli = cli.filter((command) => command.description === null);
  const undescribedParams = cli.flatMap((command) =>
    command.params
      .filter((param) => !param.described)
      .map((param) => command.path.join(" ") + " " + param.name),
  );
  const mcpSources = sourceFiles(["apps/server/src/mcp"]);
  const opaqueCodes = ["orchestration_error", "invalid_request"].map((failureCode) => ({
    code: failureCode,
    hits: mcpSources.flatMap((file) =>
      readLines(file).flatMap((line, index) =>
        line.includes('"' + failureCode + '"') ? [{ path: file, line: index + 1 }] : [],
      ),
    ),
  }));
  const command = (path: string) => cli.find((entry) => entry.path.join(" ") === path);
  const tool = (name: string) => tools.find((entry) => entry.name === name);

  const toolkitRows = [...toolkits.entries()].map(([name, members]) => [
    code(name),
    members.length,
    members.filter((member) => member.mutating).length,
    members.filter((member) => member.clientRequestId).length,
    members.filter((member) => member.pagination.length > 0).length,
    [...new Set(members.map((member) => member.error.failureMode))].join(", "),
    new Set(members.flatMap((member) => member.error.tags)).size,
    "apps/server/src/mcp/toolkits/" + name + "/tools.ts",
  ]);

  const misplaced = tools.filter((entry) => {
    const resource = (entry.naming.resource ?? "").toLowerCase();
    const toolkit = entry.toolkit.toLowerCase();
    return (
      entry.naming.shape === "goat_resource_verb" &&
      !toolkit.startsWith(resource.slice(0, 4)) &&
      !resource.startsWith(toolkit.slice(0, 4)) &&
      !toolkit.toLowerCase().includes(resource)
    );
  });

  const synonymRows = SYNONYMS.map(([intent, verbs]) => [
    intent,
    verbs
      .map((verb) => [verb, tools.filter((entry) => usesVerb(entry.name, verb)).length] as const)
      .filter(([, count]) => count > 0)
      .map(([verb, count]) => code(verb) + " (" + count + ")")
      .join(", "),
  ]);

  const fixes = rankedFixes(inventory, a, {
    extraKeys: extraKeys.length,
    undescribed: undescribed.length,
    allUndescribed: allUndescribed.length,
    mutatingWithoutCrid: mutatingWithoutCrid.length,
    failureModes: [...failureModes.entries()]
      .map(([mode, members]) => members.length + " " + code(mode))
      .join(", "),
    errorFamilies: errorFamilies.size,
    jsonCli: jsonCli.length,
    leafCli: leafCli.length,
    exampleCli: exampleCli.length,
    withExamples: withExamples.length,
    unlimitedLists: unlimitedLists.map((entry) => entry.name),
    longest: longest[0]?.descriptionLength ?? 0,
  });

  const unknownMentions = [
    ...groupBy([...a.unknownPrompt, ...a.unknownDoc], (mention) => mention.token).entries(),
  ];

  return [
    "# Agent surface audit",
    "",
    "<!-- Generated by scripts/agent-surface/audit.ts. Do not edit by hand; run " +
      code("pnpm agent-surface:audit") +
      ". -->",
    "",
    "This page measures what an agent meets when it drives GOAT today: the tools mounted on " +
      code("/mcp") +
      " and the " +
      code("goat") +
      " command tree. Every count and cited file comes from loading those registries from source (" +
      code("scripts/agent-surface/inventory.ts") +
      "), so regenerating after a change shows whether a finding still holds. " +
      "It is the evidence base for the agent surface redesign: it describes problems and ranks fixes, and leaves the target design to that spec.",
    "",
    "Run " +
      code("node scripts/agent-surface/inventory.ts") +
      " for the full JSON inventory, including per-tool schemas, hints, enforced access, and the rendered " +
      code("--help") +
      " of every command.",
    "",
    "## Snapshot",
    "",
    table(
      ["Measure", "Value"],
      [
        ["MCP tools mounted on /mcp", tools.length],
        [
          "Toolkits",
          toolkits.size +
            (inventory.unmountedToolkits.length
              ? " (unmounted: " + inventory.unmountedToolkits.join(", ") + ")"
              : ""),
        ],
        ["Mutating tools, by enforced handler access", mutating.length],
        [
          "Mutating tools that accept clientRequestId",
          mutating.length - mutatingWithoutCrid.length,
        ],
        [
          "Mutating tools whose clientRequestId GOAT deduplicates",
          mutating.filter((tool) => tool.deduplicated).length,
        ],
        [
          "Input parameters with a description",
          fields.length -
            undescribed.length +
            " of " +
            fields.length +
            " (" +
            pct(fields.length - undescribed.length, fields.length) +
            ")",
        ],
        ["Tool descriptions with an example", withExamples.length + " of " + tools.length],
        [
          "CLI commands, listed / unlisted",
          listedCli.length + " / " + (cli.length - listedCli.length),
        ],
        ["CLI commands with usage examples", exampleCli.length + " of " + cli.length],
        ["Listed CLI leaf commands with --json", jsonCli.length + " of " + leafCli.length],
      ],
    ),
    "",
    table(
      [
        "Toolkit",
        "Tools",
        "Mutating",
        "clientRequestId",
        "Paginated",
        "failureMode",
        "Error tags",
        "Source",
      ],
      toolkitRows,
    ),
    "",
    "## Naming",
    "",
    "Tool names follow three shapes, so an agent cannot guess a name from the resource and verb it wants:",
    "",
    table(
      ["Shape", "Count", "Examples"],
      [...shapes.entries()].map(([shape, members]) => [
        code(shape),
        members.length,
        list(
          members.map((member) => member.name),
          6,
        ),
      ]),
    ),
    "",
    "The " +
      code("goat_") +
      " prefix marks only some tools, and the catalog test pins exactly that set (" +
      at(
        "apps/server/src/mcp/toolkits/core.test.ts",
        /filter\(\(name\) => name\.startsWith\("goat_"\)\)/,
        "publishes unique tool names",
      ) +
      "). " +
      list(
        (shapes.get("verb_resource") ?? []).map((member) => member.name),
        8,
      ) +
      " put the verb first, and " +
      list(
        (shapes.get("resource_verb") ?? []).map((member) => member.name),
        8,
      ) +
      " put an unprefixed resource first. " +
      "Pull requests use " +
      code("link_pull_request") +
      " and " +
      code("watch_pull_request") +
      " where threads use " +
      code("goat_thread_watch") +
      "; scheduled tasks are " +
      code("schedule_task") +
      ", " +
      code("list_scheduled_tasks") +
      ", and " +
      code("run_scheduled_task_now") +
      ".",
    "",
    "Toolkits do not match the resource in the name, which matters once docs or permissions are grouped by toolkit:",
    "",
    table(
      ["Tool", "Lives in toolkit", "Declared at"],
      misplaced.map((entry) => [code(entry.name), code(entry.toolkit), ref(entry.source)]),
    ),
    "",
    "One intent is spelled several ways (tool counts in parentheses):",
    "",
    table(["Intent", "Verbs in use"], synonymRows),
    "",
    "## Schemas and envelopes",
    "",
    "- **Undeclared arguments.** " +
      extraKeys.length +
      " of " +
      tools.length +
      " published input schemas say " +
      code('"additionalProperties": true') +
      ", but every registration refuses undeclared arguments at call time (" +
      at(
        "apps/server/src/mcp/McpHttpServer.ts",
        /const refuseUndeclaredArguments/,
        "refuseUndeclaredArguments",
      ) +
      "). A client that validates against the schema cannot learn the real contract.",
    "- **Two failure modes.** Tools split " +
      [...failureModes.entries()]
        .map(([mode, members]) => members.length + " " + code(mode))
        .join(" and ") +
      ". Both reach the client as " +
      code("isError") +
      " with JSON in a text block and no " +
      code("structuredContent") +
      " (" +
      at("apps/server/src/mcp/toolkits/core.test.ts", /const declaredFailure/, "declaredFailure") +
      "), so an agent parses text to branch on an error.",
    "- **" +
      errorFamilies.size +
      " error families.** " +
      [...errorFamilies.entries()]
        .map(
          ([tags, members]) =>
            members.length +
            " tools fail with " +
            (tags.split("+").length > 2
              ? tags.split("+").length + " tagged errors"
              : tags.split("+").map(code).join(" or ")),
        )
        .join("; ") +
      ". Only " +
      code("OrchestratorMcpFailure") +
      " carries a machine " +
      code("code") +
      " (" +
      at(
        "packages/contracts/src/orchestratorMcpFailure.ts",
        /export const OrchestratorMcpFailureCode/,
        "OrchestratorMcpFailureCode",
      ) +
      "). Preview, device, worktree, and pull request failures are told apart by " +
      code("_tag") +
      " alone, and every preview tool advertises all of its toolkit's tags whether or not it can raise them.",
    "- **Idempotency.** " +
      withCrid.length +
      " tools accept " +
      code("clientRequestId") +
      ": " +
      list(
        withCrid.map((entry) => entry.name),
        10,
      ) +
      ". The other " +
      mutatingWithoutCrid.length +
      " mutating tools have no retry key, including the destructive " +
      list(
        mutatingWithoutCrid.filter((entry) => entry.hints.destructive).map((entry) => entry.name),
        10,
      ) +
      ".",
    "- **Pagination.** " +
      [...paginationStyles.entries()]
        .map(
          ([style, members]) =>
            members.length +
            (members.length === 1 ? " tool uses " : " tools use ") +
            code(style) +
            " (" +
            list(
              members.map((member) => member.name),
              4,
            ) +
            ")",
        )
        .join("; ") +
      ". List tools with no page control: " +
      (unlimitedLists.length ? list(unlimitedLists.map((entry) => entry.name)) : "none") +
      ".",
    "- **Hints that disagree with enforcement.** The handler's " +
      code("McpToolAccess") +
      " declaration is what the server enforces; the MCP " +
      code("readOnlyHint") +
      " is what clients see. They disagree for " +
      (a.hintMismatch.length
        ? a.hintMismatch
            .map(
              (entry) =>
                code(entry.name) +
                " (hint " +
                (entry.hints.readOnly ? "read-only" : "not read-only") +
                ", handler " +
                code(entry.access ?? "?") +
                " at " +
                ref(entry.handler) +
                ")",
            )
            .join(", ")
        : "no tools") +
      "." +
      (a.actsAsCallerReads.length
        ? " Reads declared " +
          code("actsAsCaller") +
          " without a read-only hint: " +
          list(a.actsAsCallerReads.map((entry) => entry.name)) +
          "."
        : ""),
    "- **Image results.** " +
      code("preview_snapshot") +
      ", " +
      code("device_screenshot") +
      ", and " +
      code("html_preview") +
      " are registered by hand to return image content (" +
      at(
        "apps/server/src/mcp/McpHttpServer.ts",
        /const imageToolRegistration/,
        "imageToolRegistration",
      ) +
      "), outside the toolkit path every other tool uses.",
    "",
    "## Descriptions and examples",
    "",
    "Only " +
      pct(fields.length - undescribed.length, fields.length) +
      " of input parameters carry a description. " +
      allUndescribed.length +
      " tools describe none of their parameters, for example " +
      list(
        allUndescribed.map((entry) => entry.name),
        10,
      ) +
      ". Optional fields encode as " +
      code("anyOf [T, null]") +
      " with no stated default, so an agent learns defaults only from prose.",
    "",
    withExamples.length +
      " of " +
      tools.length +
      " tool descriptions include an example. " +
      untitled.length +
      " tools have no " +
      code("Tool.Title") +
      ". Description length is uneven; the longest are:",
    "",
    table(
      ["Tool", "Characters", "Declared at"],
      longest.map((entry) => [code(entry.name), entry.descriptionLength, ref(entry.source)]),
    ),
    "",
    "Long descriptions carry routing policy (when to use another tool, what to tell the user) that every session pays for in context and no test checks.",
    "",
    "## Errors an agent cannot act on",
    "",
    opaqueCodes
      .map(
        ({ code: failureCode, hits }) =>
          "- " +
          code(failureCode) +
          " is raised across " +
          code("apps/server/src/mcp") +
          (hits.length ? ", for example in " + files(hits).slice(0, 4).join(", ") : "") +
          ". The code does not say whether to retry, fix the input, or ask the user.",
      )
      .join("\n"),
    "- " +
      code("OrchestratorMcpFailure") +
      " has only " +
      code("code") +
      " and " +
      code("message") +
      " (" +
      at(
        "packages/contracts/src/orchestratorMcpFailure.ts",
        /export class OrchestratorMcpFailure /,
        "OrchestratorMcpFailure",
      ) +
      "): no retry hint, offending field, or next action. Recovery advice, where it exists, lives in message text.",
    "",
    "## Where a human is required",
    "",
    "These are the steps GOAT cannot finish without a person today, and how an agent finds out:",
    "",
    table(
      ["Step", "How it surfaces to an agent", "Evidence"],
      [
        [
          "Enter a secret (webhook signing, credentials)",
          "Agent calls " +
            code("request_secret") +
            "; the user types the value in the app; the agent gets a " +
            code("secretRef") +
            ". Only callable from inside a GOAT thread.",
          ref(tool("request_secret")?.source ?? null) +
            ", " +
            at(
              "apps/server/src/mcp/completionWebhook.ts",
              /secretRef comes from .+ in a GOAT thread/,
            ),
        ],
        [
          "Answer a provider question or approval",
          "The thread turns waiting; " +
            code("goat_pending_request_list") +
            ", " +
            code("goat_pending_request_read") +
            ", and " +
            code("goat_pending_request_respond") +
            " let an agent answer, and escalation names the tool to use.",
          at(
            "apps/server/src/orchestration-v2/QuestionEscalationService.ts",
            /answerWith: "goat_pending_request_respond"/,
          ) +
            ", " +
            at(
              "apps/server/src/mcp/PendingQuestionsMcpService.ts",
              /tool: "goat_pending_request_respond"/,
            ),
        ],
        [
          "Raise runtime or interaction mode",
          "The call fails with " +
            code("runtime_mode_escalation_denied") +
            " or " +
            code("interaction_mode_escalation_denied") +
            ". No tool requests approval, so the agent must stop and tell the user.",
          at(
            "packages/contracts/src/orchestratorMcpFailure.ts",
            /"runtime_mode_escalation_denied"/,
          ),
        ],
        [
          "Grant a capability or credential",
          "The call fails with " +
            code("capability_denied") +
            " or " +
            code("thread_credential_required") +
            "; the user resolves it in settings or by issuing a token.",
          at("packages/contracts/src/orchestratorMcpFailure.ts", /"thread_credential_required"/),
        ],
        [
          "GOAT Connect sign-in (OAuth or device code)",
          "CLI only: " +
            code("goat connect login") +
            ", or " +
            code("--headless") +
            " for the device flow. No MCP tool starts it or reports its state.",
          at("apps/server/src/cli/connect.ts", /OAuth device flow/),
        ],
        [
          "Pair a client",
          code("goat pair") +
            " or " +
            code("goat auth pairing create") +
            " on the host, or Settings → Connections. No MCP tool.",
          ref(command("goat pair")?.source ?? null),
        ],
        [
          "Add an SSH host",
          code("goat_connection_add_ssh") +
            " exists; host key trust, passphrases, and MFA prompts are not modelled as a handoff.",
          ref(tool("goat_connection_add_ssh")?.source ?? null),
        ],
        [
          "Put " + code("goat") + " on PATH",
          "A desktop install writes a launcher under the GOAT home, off PATH; adding it to PATH is an opt-in desktop action.",
          at("apps/desktop/src/app/DesktopCliShim.ts", /A desktop install puts no .goat. on PATH/) +
            ", " +
            at("apps/desktop/src/app/DesktopCliCommand.ts", /is off PATH/),
        ],
      ],
    ),
    "",
    "Tools whose description or schema tells the agent to involve the user: " +
      human.map((entry) => code(entry.name) + " (" + entry.humanSteps.join(", ") + ")").join(", ") +
      ".",
    "",
    "There is no single handoff primitive. Each case has its own tool, error code, or CLI step, and none returns a resumable handle the agent can wait on.",
    "",
    "## CLI",
    "",
    "The CLI operates a server; it is not an agent interface. Its " +
      listedCli.length +
      " listed commands cover serving, auth tokens, pairing, the background service, updates, themes, traces, triage, and GOAT Connect. " +
      "Nothing lists, reads, or drives threads or tasks, and projects only have " +
      code("goat project add") +
      ", " +
      code("remove") +
      ", and " +
      code("rename") +
      ". " +
      "The one generic bridge, " +
      code("goat acp-mcp-call") +
      ", is unlisted and its arguments are undescribed (" +
      ref(command("goat acp-mcp-call")?.source ?? null) +
      ").",
    "",
    "- " +
      exampleCli.length +
      " of " +
      cli.length +
      " commands define usage examples, so " +
      code("--help") +
      " never shows a worked call.",
    "- " +
      jsonCli.length +
      " of " +
      leafCli.length +
      " listed leaf commands offer " +
      code("--json") +
      ": " +
      list(jsonCli.map((entry) => entry.path.join(" "))) +
      ".",
    "- " +
      undescribedCli.length +
      " commands have no description, all of them unlisted internals. Undescribed parameters: " +
      (undescribedParams.length ? list(undescribedParams, 6) : "none") +
      ".",
    "- " +
      code("goat auth client revoke") +
      ' reuses the session revoke command under a second parent, so its help reads "Revoke an active session." (' +
      ref(command("goat auth client revoke")?.source ?? null) +
      ").",
    "- Server flags such as " +
      code("--dev-url") +
      " repeat on subcommands that start no server, such as " +
      code("goat auth pairing create") +
      ".",
    "",
    "## Drift between docs and the registry",
    "",
    "Scanned the Markdown docs (docs, structure, skills, root guides) and the agent prompt sources in " +
      code("packages/provider-core/src/server") +
      ".",
    "",
    unknownMentions.length === 0
      ? "No doc or prompt names a tool that does not exist."
      : "Names that look like tools but are not in the registry:\n\n" +
        table(
          ["Name", "Where"],
          unknownMentions.map(([token, mentions]) => [
            code(token),
            ((where) =>
              where.slice(0, 3).join(", ") +
              (where.length > 3 ? " (+" + (where.length - 3) + ")" : ""))(
              files(mentions.map((mention) => mention.ref)),
            ),
          ]),
        ),
    "",
    a.cliDrift.length === 0
      ? "Every " +
        code("goat ...") +
        " invocation in the docs resolves to a real command and its flags."
      : "CLI invocations in the docs that do not resolve:\n\n" +
        table(
          ["Text", "Problem", "Where"],
          a.cliDrift.map((drift) => [code(drift.text), drift.problem, ref(drift.ref)]),
        ),
    "",
    a.undocumented.length +
      " of " +
      tools.length +
      " tools are never named in any Markdown doc, and " +
      a.unprompted.length +
      " are named in neither docs nor agent prompts: " +
      list(a.unprompted, 24) +
      ". " +
      "Agents learn these only from the MCP catalog.",
    "",
    "Listed CLI commands no doc invokes: " +
      (a.undocumentedCli.length
        ? list(
            a.undocumentedCli.map((entry) => entry.path.join(" ")),
            20,
          )
        : "none") +
      ".",
    "",
    "The server's " +
      code("/llms.txt") +
      " lists every registry path with its summary, but arguments and examples are still served only by the MCP catalog.",
    "",
    "## Fixes ranked by agent impact",
    "",
    fixes.map((fix, index) => index + 1 + ". **" + fix.title + "** " + fix.body).join("\n"),
    "",
  ].join("\n");
}

interface Fix {
  readonly title: string;
  readonly body: string;
}

function rankedFixes(
  inventory: Inventory,
  a: ReturnType<typeof analyse>,
  n: {
    readonly extraKeys: number;
    readonly undescribed: number;
    readonly allUndescribed: number;
    readonly mutatingWithoutCrid: number;
    readonly failureModes: string;
    readonly errorFamilies: number;
    readonly jsonCli: number;
    readonly leafCli: number;
    readonly exampleCli: number;
    readonly withExamples: number;
    readonly unlimitedLists: ReadonlyArray<string>;
    readonly longest: number;
  },
): ReadonlyArray<Fix> {
  return [
    {
      title: "One error envelope with a machine code and a next action.",
      body:
        n.errorFamilies +
        " error families and two failure modes (" +
        n.failureModes +
        ") all arrive as JSON inside text. Return " +
        code("structuredContent") +
        " shaped like " +
        code("{code, message, retryable, field?, next?}") +
        " from every tool so an agent branches on data.",
    },
    {
      title: "A single human handoff primitive.",
      body: 'Secrets, approvals, mode escalation, capability grants, and sign-in each surface differently (see "Where a human is required"). One handoff result with an id, what the user must do and where, plus one wait call, lets any agent pause and resume instead of failing.',
    },
    {
      title: "Serve the full tool reference from the registry.",
      body:
        a.unprompted.length +
        " tools appear in no doc or prompt. " +
        code("/llms.txt") +
        " now lists every path for the calling credential; " +
        code("goat_describe") +
        " should serve arguments and examples from the same registry, with no committed reference pages (decision D14 in agent-surface.md).",
    },
    {
      title: "Describe every parameter.",
      body:
        n.undescribed +
        " of " +
        a.fields.length +
        " parameters have no description, and " +
        n.allUndescribed +
        " tools describe none. Extend the catalog test at " +
        at(
          "apps/server/src/mcp/toolkits/core.test.ts",
          /publishes unique tool names/,
          "publishes unique tool names",
        ) +
        " to fail on an undescribed field.",
    },
    {
      title: "Publish the real argument contract.",
      body:
        n.extraKeys +
        " schemas advertise " +
        code("additionalProperties: true") +
        " while the server refuses extra keys. Emit " +
        code("false") +
        " so schema-validating clients reject a bad call before sending it.",
    },
    {
      title: "Retry keys on every mutating tool.",
      body:
        n.mutatingWithoutCrid +
        " mutating tools take no " +
        code("clientRequestId") +
        ", so a dropped response leaves an agent unable to retry safely. Start with destructive tools and thread launch.",
    },
    {
      title: "One naming grammar.",
      body:
        "Pick one shape for all " +
        inventory.tools.length +
        " tools, keep old names as hidden aliases for a release, and drop the partial " +
        code("goat_") +
        " prefix that the MCP server name already supplies.",
    },
    {
      title: "Derive hints from enforcement.",
      body:
        "Compute " +
        code("readOnlyHint") +
        " from the handler's " +
        code("McpToolAccess") +
        " declaration instead of annotating it separately. " +
        (a.hintMismatch.length + a.actsAsCallerReads.length) +
        " tools disagree or under-declare today, which misleads clients that auto-approve reads.",
    },
    {
      title: "Ship " + code("goat") + " on PATH with the app.",
      body:
        "Agents outside GOAT need a stable entry point. Put the launcher on PATH by default with a clear opt-out, and make " +
        code("goat --version") +
        " the first-run check.",
    },
    {
      title: "Give the CLI an agent face.",
      body:
        "Add listed " +
        code("goat tool list") +
        " and " +
        code("goat tool call <name> --json") +
        " generated from the same registry, so shells and CI reach every MCP capability through one documented grammar. Today only the unlisted " +
        code("acp-mcp-call") +
        " exists.",
    },
    {
      title: code("--json") + " on every listed leaf command.",
      body:
        "Only " +
        n.jsonCli +
        " of " +
        n.leafCli +
        " offer it; agents parse human tables otherwise.",
    },
    {
      title: "Examples in help and tool descriptions, executed in tests.",
      body:
        n.exampleCli +
        " CLI commands use " +
        code("Command.withExamples") +
        " and " +
        n.withExamples +
        " tool descriptions show a call. Keep examples as data, render them into help and docs, and run them in a smoke test so they cannot rot.",
    },
    {
      title: "Uniform pagination.",
      body:
        "Use one cursor shape everywhere and add it to list tools that lack one (" +
        (n.unlimitedLists.length ? n.unlimitedLists.map(code).join(", ") : "none today") +
        ").",
    },
    {
      title: "Move routing policy out of tool descriptions.",
      body:
        "The longest description is " +
        n.longest +
        " characters, mostly when-to-use guidance. Keep descriptions to what the tool does and its contract, and put policy in the orchestration prompt once.",
    },
    {
      title: "Group tools by resource.",
      body: "Move queue and pending request tools out of the thread toolkit and thread launch out of the project toolkit, and give scheduled tasks one toolkit, so permissions, docs, and discovery follow the resource an agent is working on.",
    },
  ];
}

if (import.meta.main) {
  const target = NodePath.join(repoRoot, OUTPUT);
  const output = render(await collectInventory());
  const current = NodeFS.existsSync(target) ? NodeFS.readFileSync(target, "utf8") : "";
  if (!process.argv.includes("--check")) {
    NodeFS.writeFileSync(target, output);
    process.stdout.write("Wrote " + OUTPUT + "\n");
  } else if (current !== output) {
    process.stderr.write(OUTPUT + " is stale. Run: pnpm agent-surface:audit\n");
    process.exitCode = 1;
  }
}
