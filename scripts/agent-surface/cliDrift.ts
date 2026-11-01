// @effect-diagnostics nodeBuiltinImport:off - a plain Node script helper that loads a server module by path; no Effect runtime.
/** Judges one documented `goat ...` invocation against the command trees that dispatch it. */
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { type CliEntry, type SourceRef, readLines, repoRoot } from "./inventory.ts";
import { SHIPPED_TOOL_NAMES } from "./listedNames.ts";
import { code } from "./markdown.ts";

// Loaded at runtime like inventory.ts loads toolkits: the scripts project cannot list server
// sources, so a static import fails its typecheck.
const { agentSurfaceInvocation } = (await import(
  NodeURL.pathToFileURL(NodePath.join(repoRoot, "apps/server/src/cli/agentSurfaceCommand.ts")).href
)) as {
  readonly agentSurfaceInvocation: (
    argv: ReadonlyArray<string>,
    input: { readonly stdin: () => string; readonly file: (path: string) => string },
  ) =>
    | { readonly kind: "usage"; readonly message: string }
    | { readonly kind: "help" | "call" }
    | undefined;
};

export interface CliMention {
  readonly text: string;
  readonly ref: SourceRef;
}

export interface CliDrift {
  readonly text: string;
  readonly ref: SourceRef;
  readonly problem: string;
}

export const checkCliMention = (
  mention: CliMention,
  cli: ReadonlyArray<CliEntry>,
): CliDrift | null => {
  const words = mention.text.split(/\s+/);
  // Generated registry commands and the storage shortcuts are dispatched before makeCli, so they
  // are absent from its help tree; their own parser judges their flags. Docs quote fragments and
  // usage notation, so only a flag the parser rejects counts as drift.
  const registryCommand =
    SHIPPED_TOOL_NAMES.has(words.slice(1, 3).join(".").replace(/-/g, "_")) ||
    (words[1] === "storage" && words[2]?.startsWith("--") === true);
  if (registryCommand) {
    const invocation = agentSurfaceInvocation(words.slice(1), {
      stdin: () => "{}",
      file: () => "{}",
    });
    const message = invocation?.kind === "usage" ? invocation.message.split("\n")[0] : undefined;
    return message !== undefined && /^Unknown flag |needs a verb before --/.test(message)
      ? { text: mention.text, ref: mention.ref, problem: message }
      : null;
  }
  // The lease proxy is dispatched in bin.ts before either CLI tree loads. Its accepted flags
  // come from the argument parser, so a removed flag will become audit drift again.
  if (
    words[1] === "cua-lease-proxy" &&
    readLines("apps/server/src/bin.ts").some((line) =>
      line.includes('command === "cua-lease-proxy"'),
    )
  ) {
    const flags = new Set(
      [
        ...readLines("apps/server/src/cua/ComputerUseLeaseProxyArguments.ts")
          .join("\n")
          .matchAll(/"(--[a-z-]+)"/g),
      ].map((match) => match[1]),
    );
    if (words.slice(2).every((word) => !word.startsWith("--") || flags.has(word))) return null;
  }
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
    const negatedBoolean =
      flag?.startsWith("--no-") &&
      entry.params.some((param) => param.name === "--" + flag.slice(5) && param.type === "boolean");
    if (flag && flag !== "--help" && flag !== "--version" && !flags.has(flag) && !negatedBoolean) {
      return {
        text: mention.text,
        ref: mention.ref,
        problem: code(entry.path.join(" ")) + " has no " + code(flag),
      };
    }
  }
  return null;
};
