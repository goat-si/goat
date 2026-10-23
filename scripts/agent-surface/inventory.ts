// @effect-diagnostics nodeBuiltinImport:off - a plain Node script that reads source text and loads the registries; no Effect runtime.
/**
 * Inventory of GOAT's agent surface, read from source: every tool the `/mcp`
 * endpoint mounts and every command in the `goat` CLI tree. Nothing here is a
 * hand-maintained list. Toolkits come from `apps/server/src/mcp/toolkits/<name>/tools.ts`
 * and the CLI from `makeCli` in `apps/server/src/binCli.ts`.
 *
 *   node scripts/agent-surface/inventory.ts            # JSON to stdout
 *   node scripts/agent-surface/inventory.ts --tools    # one line per tool
 *
 * `audit.ts` renders `docs/internals/agent-surface-audit.md` from this data.
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
const serverRoot = NodePath.join(repoRoot, "apps/server");
const toolkitsRoot = NodePath.join(serverRoot, "src/mcp/toolkits");
const mcpServerFile = "apps/server/src/mcp/McpHttpServer.ts";

export interface SourceRef {
  readonly path: string;
  readonly line: number;
}

export interface SchemaField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly described: boolean;
}

export interface ToolEntry {
  readonly name: string;
  readonly toolkit: string;
  readonly source: SourceRef | null;
  readonly handler: SourceRef | null;
  /** `McpToolAccess.*` declaration the handler uses; the server enforces this. */
  readonly access: string | null;
  readonly title: string | null;
  readonly description: string;
  readonly descriptionLength: number;
  readonly descriptionHasExample: boolean;
  readonly naming: {
    readonly shape: "goat_resource_verb" | "verb_resource" | "resource_verb" | "other";
    readonly verb: string | null;
    readonly resource: string | null;
  };
  readonly input: {
    readonly fields: ReadonlyArray<SchemaField>;
    readonly required: ReadonlyArray<string>;
    readonly undescribed: ReadonlyArray<string>;
    readonly bytes: number;
  };
  readonly output: {
    readonly topLevelKeys: ReadonlyArray<string>;
    readonly type: string;
  };
  readonly error: {
    readonly failureMode: string;
    readonly tags: ReadonlyArray<string>;
    readonly codes: ReadonlyArray<string>;
  };
  readonly hints: {
    readonly readOnly: boolean;
    readonly destructive: boolean;
    readonly idempotent: boolean;
    readonly openWorld: boolean;
    readonly needsApproval: boolean;
  };
  readonly mutating: boolean;
  /** The published schema allows extra keys; McpHttpServer refuses them at call time. */
  readonly acceptsUndeclaredArguments: boolean;
  readonly clientRequestId: boolean;
  /** The registry marks it `idempotency: "key"`, so GOAT reserves its clientRequestId. */
  readonly deduplicated: boolean;
  readonly pagination: ReadonlyArray<string>;
  readonly humanSteps: ReadonlyArray<string>;
  /** Hand-registered so it can return image content (see McpHttpServer). */
  readonly imageResult: boolean;
}

export interface CliParam {
  readonly name: string;
  readonly kind: "flag" | "argument";
  readonly type: string;
  readonly required: boolean;
  readonly described: boolean;
}

export interface CliEntry {
  readonly path: ReadonlyArray<string>;
  readonly source: SourceRef | null;
  readonly description: string | null;
  readonly unlisted: boolean;
  readonly examples: number;
  readonly params: ReadonlyArray<CliParam>;
  readonly jsonOutput: boolean;
  readonly subcommands: ReadonlyArray<string>;
  readonly help: string;
}

export interface Inventory {
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly unmountedToolkits: ReadonlyArray<string>;
  readonly cli: ReadonlyArray<CliEntry>;
}

// Structural views of the Effect objects; the script loads the server's own
// `effect` instance, so it stays out of the scripts project's type graph.
interface ToolLike {
  readonly name: string;
  readonly description?: string | undefined;
  readonly failureMode: string;
  readonly successSchema: unknown;
  readonly failureSchema: unknown;
  readonly annotations: unknown;
  readonly needsApproval?: unknown;
}
interface ToolkitLike {
  readonly tools: Record<string, ToolLike>;
}
interface HelpParam {
  readonly name: string;
  readonly type: string;
  readonly description: unknown;
  readonly required: boolean;
}
interface CommandLike {
  readonly name: string;
  readonly description: string | undefined;
  readonly unlisted: boolean;
  readonly examples: ReadonlyArray<unknown>;
  readonly subcommands: ReadonlyArray<{ readonly commands: ReadonlyArray<CommandLike> }>;
  readonly buildHelpDoc: (path: ReadonlyArray<string>) => {
    readonly flags: ReadonlyArray<HelpParam>;
    readonly args?: ReadonlyArray<HelpParam>;
  };
}
type JsonSchema = {
  readonly type?: string | ReadonlyArray<string>;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: ReadonlyArray<string>;
  readonly description?: string;
  readonly enum?: ReadonlyArray<unknown>;
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly oneOf?: ReadonlyArray<JsonSchema>;
  readonly items?: JsonSchema;
  readonly $ref?: string;
  readonly $defs?: Record<string, JsonSchema>;
  readonly additionalProperties?: boolean | JsonSchema;
};

const isToolkit = (value: unknown): value is ToolkitLike =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "tools" in value &&
  typeof value.tools === "object" &&
  value.tools !== null;

const serverRequire = NodeModule.createRequire(NodePath.join(serverRoot, "package.json"));
const importFrom = (specifier: string): Promise<Record<string, unknown>> =>
  import(NodeURL.pathToFileURL(serverRequire.resolve(specifier)).href);
const importFile = (file: string): Promise<Record<string, unknown>> =>
  import(NodeURL.pathToFileURL(file).href);

export const rel = (file: string) =>
  NodePath.relative(repoRoot, file).split(NodePath.sep).join("/");

const lines = new Map<string, ReadonlyArray<string>>();
export const readLines = (file: string): ReadonlyArray<string> => {
  let cached = lines.get(file);
  if (!cached) {
    cached = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8").split("\n");
    lines.set(file, cached);
  }
  return cached;
};

export const findLine = (file: string, pattern: RegExp): SourceRef | null => {
  const index = readLines(file).findIndex((line) => pattern.test(line));
  return index === -1 ? null : { path: file, line: index + 1 };
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a tool's name is written: the `Tool.make` call, or the constant it uses. */
const locateTool = (toolkitFile: string, name: string): SourceRef | null => {
  const literal = new RegExp('Tool\\.make\\(\\s*"' + escape(name) + '"');
  const direct = findLine(toolkitFile, literal);
  if (direct) return direct;
  // Multi-line call or a named constant: find the literal anywhere in shipped source.
  const quoted = new RegExp('"' + escape(name) + '"');
  for (const file of [
    toolkitFile,
    ...sourceFiles(["packages/contracts/src", "packages/shared/src"]),
  ]) {
    const ref = findLine(file, quoted);
    if (ref) return ref;
  }
  return null;
};

export const sourceFiles = (
  dirs: ReadonlyArray<string>,
  extension = ".ts",
): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const walk = (dir: string) => {
    for (const entry of NodeFS.readdirSync(NodePath.join(repoRoot, dir), { withFileTypes: true })) {
      const child = dir + "/" + entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith(".")) walk(child);
      } else if (entry.name.endsWith(extension) && !/\.test\.|\.testkit\./.test(entry.name)) {
        out.push(child);
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return out.sort();
};

const refsDefinition = (schema: JsonSchema, root: JsonSchema): JsonSchema => {
  const ref = schema.$ref;
  if (!ref?.startsWith("#/$defs/")) return schema;
  return root.$defs?.[ref.slice("#/$defs/".length)] ?? schema;
};

const typeName = (schema: JsonSchema, root: JsonSchema): string => {
  const resolved = refsDefinition(schema, root);
  if (resolved.enum) return "enum";
  if (resolved.anyOf ?? resolved.oneOf) {
    return (resolved.anyOf ?? resolved.oneOf ?? [])
      .map((option) => typeName(option, root))
      .join("|");
  }
  if (Array.isArray(resolved.type)) return resolved.type.join("|");
  if (typeof resolved.type === "string") {
    return resolved.type === "array" && resolved.items
      ? typeName(resolved.items, root) + "[]"
      : resolved.type;
  }
  return "unknown";
};

const VERBS = new Set([
  "add",
  "browse",
  "cancel",
  "capabilities",
  "clean",
  "cleanup",
  "click",
  "clone",
  "close",
  "configuration",
  "configure",
  "create",
  "delegate",
  "delete",
  "dialog",
  "discard",
  "drag",
  "edit",
  "evaluate",
  "fork",
  "get",
  "handoff",
  "hover",
  "ingest",
  "interrupt",
  "inventory",
  "launch",
  "link",
  "list",
  "merge",
  "navigate",
  "open",
  "organize",
  "prepare",
  "press",
  "preview",
  "promote",
  "read",
  "remove",
  "render",
  "reorder",
  "report",
  "reports",
  "request",
  "resize",
  "respond",
  "run",
  "schedule",
  "screenshot",
  "scroll",
  "search",
  "select",
  "send",
  "set",
  "snapshot",
  "start",
  "status",
  "stop",
  "transfers",
  "type",
  "unlink",
  "unwatch",
  "update",
  "upload",
  "wait",
  "watch",
  "write",
]);

const guessNaming = (name: string): ToolEntry["naming"] => {
  const parts = name.split("_");
  if (parts[0] === "goat" && parts.length >= 3) {
    return {
      shape: "goat_resource_verb",
      resource: parts[1] ?? null,
      verb: parts.slice(2).join("_"),
    };
  }
  const first = parts[0] ?? "";
  if (VERBS.has(first) && parts.length >= 2) {
    return { shape: "verb_resource", verb: first, resource: parts.slice(1).join("_") };
  }
  if (parts.length >= 2) {
    return { shape: "resource_verb", resource: first, verb: parts.slice(1).join("_") };
  }
  return { shape: "other", verb: null, resource: null };
};

const PAGINATION_FIELDS = new Set([
  "cursor",
  "nextCursor",
  "limit",
  "offset",
  "afterSequence",
  "hasMore",
  "pageToken",
  "before",
  "after",
  "beforeSequence",
]);

const HUMAN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["secret entry", /request_secret|enters? the secret|secretRef/i],
  ["user approval", /\bapprov(al|e)\b|needs? the user|ask the user|user confirms?/i],
  ["sign-in", /\bsign[ -]?in\b|\blog ?in\b|OAuth|device code/i],
  ["pairing", /\bpair(ing)?\b/i],
  [
    "user answers a question",
    /pending (request|question)|answer(s|ed)? (it|the question)|user input/i,
  ],
  ["user chooses in UI", /in Settings|the user (opens|clicks|chooses|picks)|\bin the app\b/i],
];

const humanStepsFor = (text: string): ReadonlyArray<string> =>
  HUMAN_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);

const collectFailure = (
  schema: JsonSchema,
  root: JsonSchema,
  tags: Set<string>,
  codes: Set<string>,
) => {
  const resolved = refsDefinition(schema, root);
  for (const option of [...(resolved.anyOf ?? []), ...(resolved.oneOf ?? [])]) {
    collectFailure(option, root, tags, codes);
  }
  const props = resolved.properties ?? {};
  for (const value of props["_tag"]?.enum ?? []) tags.add(String(value));
  for (const value of refsDefinition(props["code"] ?? {}, root).enum ?? [])
    codes.add(String(value));
  for (const value of refsDefinition(props["reason"] ?? {}, root).enum ?? [])
    codes.add(String(value));
};

/** Handler access declarations, keyed by tool name, from each toolkit's handlers.ts. */
const handlerAccess = (handlersFile: string): Map<string, { access: string; ref: SourceRef }> => {
  const out = new Map<string, { access: string; ref: SourceRef }>();
  if (!NodeFS.existsSync(NodePath.join(repoRoot, handlersFile))) return out;
  const source = readLines(handlersFile);
  // Local wrappers such as `const writesThread = (...) => McpToolAccess.writesThreads(...)`.
  const wrappers = new Map<string, string>();
  source.forEach((line, index) => {
    const wrapper = /^\s*const (\w+) = /.exec(line)?.[1];
    if (!wrapper) return;
    const body = source.slice(index, index + 4).join(" ");
    const target = /=>\s*McpToolAccess\.(\w+)/.exec(body)?.[1];
    if (target) wrappers.set(wrapper, target);
  });
  source.forEach((line, index) => {
    const match = /^\s*"?([a-z][a-z0-9_]*)"?\s*:\s*(?:McpToolAccess\.)?(\w+)\(/.exec(line);
    if (!match?.[1] || !match[2]) return;
    const access = line.includes("McpToolAccess.") ? match[2] : wrappers.get(match[2]);
    if (access) out.set(match[1], { access, ref: { path: handlersFile, line: index + 1 } });
  });
  // Tools keyed by a constant (`[NAME]: McpToolAccess.x`): resolve the constant's name later.
  readLines(handlersFile).forEach((line, index) => {
    const match = /^\s*\[([A-Za-z_.]+)\]\s*:\s*McpToolAccess\.(\w+)/.exec(line);
    if (match?.[1] && match[2]) {
      out.set("[" + match[1] + "]", {
        access: match[2],
        ref: { path: handlersFile, line: index + 1 },
      });
    }
  });
  return out;
};

const READ_ACCESS = new Set(["reads", "readsOrReachesHost", "readsAsCaller"]);
// `actsAsCaller` covers reads and writes alike; the tool's own hint decides.
const isMutating = (access: string | null, readOnlyHint: boolean) =>
  access === null || access === "actsAsCaller" ? !readOnlyHint : !READ_ACCESS.has(access);

export async function collectTools(): Promise<{
  tools: ReadonlyArray<ToolEntry>;
  unmountedToolkits: ReadonlyArray<string>;
}> {
  const { Tool } = await importFrom("effect/ai");
  const Context = await importFrom("effect/Context");
  const ToolApi = Tool as {
    getJsonSchema: (tool: ToolLike) => JsonSchema;
    getJsonSchemaFromSchema: (schema: unknown) => JsonSchema;
    Readonly: unknown;
    Destructive: unknown;
    Idempotent: unknown;
    OpenWorld: unknown;
    Title: unknown;
  };
  const getAnnotation = Context["getOrUndefined"] as (context: unknown, key: unknown) => unknown;
  const getReference = Context["get"] as (context: unknown, key: unknown) => unknown;
  const resolve = (await importFrom("@goat/contracts/agentSurface/resolve")) as {
    resolveAgentSurfaceEntry: (name: string) => unknown;
    isKeyedWrite: (entry: unknown) => boolean;
  };
  const keyed = (name: string) => {
    const entry = resolve.resolveAgentSurfaceEntry(name);
    return entry !== undefined && resolve.isKeyedWrite(entry);
  };

  const mcpServerSource = readLines(mcpServerFile).join("\n");
  const imageRegistered = new Set(
    [...mcpServerSource.matchAll(/register(\w+)\(\)/g)].map((match) => match[1] ?? ""),
  );
  const tools = new Map<string, ToolEntry>();
  const unmounted: Array<string> = [];
  const dirs = NodeFS.readdirSync(toolkitsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const toolsFile = "apps/server/src/mcp/toolkits/" + dir + "/tools.ts";
    const handlersFile = "apps/server/src/mcp/toolkits/" + dir + "/handlers.ts";
    if (!NodeFS.existsSync(NodePath.join(repoRoot, toolsFile))) continue;
    if (!mcpServerSource.includes('"./toolkits/' + dir + '/tools.ts"')) unmounted.push(dir);
    const module = await importFile(NodePath.join(repoRoot, toolsFile));
    const access = handlerAccess(handlersFile);
    for (const exported of Object.values(module)) {
      if (!isToolkit(exported)) continue;
      for (const tool of Object.values(exported.tools)) {
        if (tools.has(tool.name)) continue;
        const input = ToolApi.getJsonSchema(tool);
        const success = ToolApi.getJsonSchemaFromSchema(tool.successSchema);
        const failure = ToolApi.getJsonSchemaFromSchema(tool.failureSchema);
        const tags = new Set<string>();
        const codes = new Set<string>();
        collectFailure(failure, failure, tags, codes);
        const props = input.properties ?? {};
        const required = input.required ?? [];
        const fields = Object.entries(props).map(([name, schema]) => ({
          name,
          type: typeName(schema, input),
          required: required.includes(name),
          described: Boolean(refsDefinition(schema, input).description ?? schema.description),
        }));
        const successResolved = refsDefinition(success, success);
        const outputKeys = Object.keys(successResolved.properties ?? {});
        const description = tool.description ?? "";
        const readOnly = getReference(tool.annotations, ToolApi.Readonly) === true;
        const titleValue = getAnnotation(tool.annotations, ToolApi.Title);
        const handler =
          access.get(tool.name) ??
          [...access.entries()].find(
            ([key]) => key.startsWith("[") && resolvesTo(key, tool.name),
          )?.[1];
        const pascal = tool.name
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("");
        tools.set(tool.name, {
          name: tool.name,
          toolkit: dir,
          source: locateTool(toolsFile, tool.name),
          handler: handler?.ref ?? null,
          access: handler?.access ?? null,
          title: typeof titleValue === "string" ? titleValue : null,
          description,
          descriptionLength: description.length,
          descriptionHasExample: /e\.g\.|for example|example:|\{type:|\bsuch as\b/i.test(
            description,
          ),
          naming: guessNaming(tool.name),
          input: {
            fields,
            required,
            undescribed: fields.filter((field) => !field.described).map((field) => field.name),
            bytes: JSON.stringify(input).length,
          },
          output: { topLevelKeys: outputKeys, type: typeName(success, success) },
          error: {
            failureMode: tool.failureMode,
            tags: [...tags].sort(),
            codes: [...codes].sort(),
          },
          hints: {
            readOnly,
            destructive: getReference(tool.annotations, ToolApi.Destructive) === true,
            idempotent: getReference(tool.annotations, ToolApi.Idempotent) === true,
            openWorld: getReference(tool.annotations, ToolApi.OpenWorld) === true,
            needsApproval: tool.needsApproval !== undefined && tool.needsApproval !== false,
          },
          mutating: isMutating(handler?.access ?? null, readOnly),
          acceptsUndeclaredArguments: input.additionalProperties !== false,
          clientRequestId: "clientRequestId" in props,
          deduplicated: keyed(tool.name),
          pagination: [...fields.map((field) => field.name), ...outputKeys].filter((name) =>
            PAGINATION_FIELDS.has(name),
          ),
          humanSteps: humanStepsFor(description + " " + JSON.stringify(input)),
          imageResult:
            imageRegistered.has(pascal) || imageRegistered.has(pascal.replace(/^Html/, "Html")),
        });
      }
    }
  }
  return {
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unmountedToolkits: unmounted,
  };
}

/** `[CHANNEL_MCP_TOOL_NAMES.ingest]` style keys: compare the constant's last segment loosely. */
const resolvesTo = (key: string, name: string) => {
  const last = key.slice(1, -1).split(".").pop() ?? "";
  const snake = last.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return name === snake || name.endsWith("_" + snake);
};

const optionText = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof value.value === "string"
  ) {
    return value.value;
  }
  return null;
};

const CLI_FILES = () => ["apps/server/src/binCli.ts", ...sourceFiles(["apps/server/src/cli"])];

const locateCommand = (
  path: ReadonlyArray<string>,
  description: string | null,
): SourceRef | null => {
  const name = path[path.length - 1] ?? "";
  if (path.length === 1) return findLine("apps/server/src/binCli.ts", /Command\.make\("goat"/);
  const pattern = new RegExp('Command\\.make\\("' + escape(name) + '"');
  const parent = (path[path.length - 2] ?? "").replace(/-/g, "").toLowerCase();
  const top = path[1] ?? "";
  // Same-named leaves (`create`, `list`) are told apart by the variable
  // convention `<parent><Name>Command`, then by the file named for the top command.
  // A command object reused under two parents (`auth client revoke` is the
  // session revoke command) is matched by its description first.
  const candidates = CLI_FILES().flatMap((file) =>
    readLines(file).flatMap((line, index, all) =>
      pattern.test(line)
        ? [
            {
              file,
              line,
              ref: { path: file, line: index + 1 },
              nearby: all.slice(index, index + 14).join(" "),
            },
          ]
        : [],
    ),
  );
  const probe = description?.slice(0, 40);
  const byDescription = probe ? candidates.filter(({ nearby }) => nearby.includes(probe)) : [];
  if (byDescription.length === 1) return byDescription[0]?.ref ?? null;
  const byVariable = candidates.find(({ line }) =>
    (/const (\w+)/.exec(line)?.[1] ?? "").toLowerCase().startsWith(parent),
  );
  const byFile = candidates.find(({ file }) => file.endsWith("/" + top + ".ts"));
  return (byVariable ?? byFile ?? candidates[0])?.ref ?? null;
};

export async function collectCli(): Promise<ReadonlyArray<CliEntry>> {
  const { makeCli } = (await importFile(NodePath.join(serverRoot, "src/binCli.ts"))) as {
    makeCli: (options: { cloudEnabled: boolean }) => CommandLike;
  };
  const { CliOutput } = (await importFrom("effect/cli")) as {
    CliOutput: {
      defaultFormatter: (options: { colors: boolean }) => {
        formatHelpDoc: (doc: unknown) => string;
      };
    };
  };
  const formatter = CliOutput.defaultFormatter({ colors: false });
  const out: Array<CliEntry> = [];
  const visit = (command: CommandLike, path: ReadonlyArray<string>, parentUnlisted: boolean) => {
    const doc = command.buildHelpDoc(path);
    const params: Array<CliParam> = [
      ...doc.flags.map((flag) => ({
        name: "--" + flag.name,
        kind: "flag" as const,
        type: flag.type,
        required: flag.required,
        described: Boolean(optionText(flag.description)?.trim()),
      })),
      ...(doc.args ?? []).map((arg) => ({
        name: arg.name,
        kind: "argument" as const,
        type: arg.type,
        required: arg.required,
        described: Boolean(optionText(arg.description)?.trim()),
      })),
    ];
    const children = command.subcommands.flatMap((group) => group.commands);
    out.push({
      path,
      source: locateCommand(path, command.description?.trim() || null),
      description: command.description?.trim() || null,
      unlisted: parentUnlisted || command.unlisted,
      examples: command.examples.length,
      params,
      jsonOutput: params.some((param) => param.name === "--json"),
      subcommands: children.map((child) => child.name),
      help: formatter.formatHelpDoc(doc),
    });
    for (const child of children)
      visit(child, [...path, child.name], parentUnlisted || command.unlisted);
  };
  // Builds without T3 Connect config swap `connect` for a stub; inventory the real tree.
  visit(makeCli({ cloudEnabled: true }), ["goat"], false);
  return out;
}

export async function collectInventory(): Promise<Inventory> {
  const { tools, unmountedToolkits } = await collectTools();
  return { tools, unmountedToolkits, cli: await collectCli() };
}

if (import.meta.main) {
  const inventory = await collectInventory();
  if (process.argv.includes("--tools")) {
    for (const tool of inventory.tools) {
      const flags = [
        tool.mutating ? "mut" : "ro",
        tool.clientRequestId ? "crid" : "",
        tool.pagination.length ? "page" : "",
        tool.humanSteps.length ? "human" : "",
      ].filter(Boolean);
      process.stdout.write(tool.toolkit.padEnd(16) + tool.name.padEnd(40) + flags.join(",") + "\n");
    }
  } else {
    process.stdout.write(JSON.stringify(inventory, null, 2) + "\n");
  }
}
