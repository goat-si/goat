// @effect-diagnostics nodeBuiltinImport:off -- lstat is required to remove symlinks without following them.
import {
  GOAT_SKILL_NAME_PREFIX,
  GOAT_SKILL_SCOPE,
  isGoatSkillName,
  type ServerProviderSkill,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { parseSkillFrontmatter } from "./SkillFrontmatter.ts";

class GlobalSkillError extends Data.TaggedError("GlobalSkillError")<{ readonly cause: unknown }> {}

const FOLDER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SCAN = 200;
const MAX_FILE = 128 * 1024;
const MAX_SKILL = 24_000;
const MAX_TOTAL = 48_000;

const readInFull = (root: string, names: ReadonlyArray<string>) =>
  `Read these skills in full from ${root}/<name-without-goat-prefix>/SKILL.md: ${names.join(", ")}`;

async function readEntries(root: string): Promise<string[]> {
  const entries: string[] = [];
  let directory: Awaited<ReturnType<typeof NodeFSP.opendir>>;
  try {
    directory = await NodeFSP.opendir(root);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return entries;
    throw cause;
  }
  try {
    while (entries.length < MAX_SCAN) {
      const entry = await directory.read();
      if (!entry) break;
      entries.push(entry.name);
    }
  } finally {
    await directory.close();
  }
  return entries;
}

async function readHead(file: string, max: number): Promise<string> {
  const info = await NodeFSP.stat(file);
  if (!info.isFile()) throw new Error("Skill is not a regular file");
  const handle = await NodeFSP.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Skill is not a regular file");
    const buffer = Buffer.alloc(Math.min(stat.size, max));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function directoryName(name: string): string | undefined {
  const folder = isGoatSkillName(name) ? name.slice(GOAT_SKILL_NAME_PREFIX.length) : "";
  return FOLDER.test(folder) ? folder : undefined;
}

export function makeGlobalSkills(input: {
  readonly globalSkillsDir: string;
  readonly disabled: Effect.Effect<ReadonlyArray<string>>;
}) {
  const root = NodePath.resolve(input.globalSkillsDir);
  const list = Effect.fn("GlobalSkills.list")(function* () {
    const disabled = new Set(yield* input.disabled);
    const entries = yield* Effect.tryPromise({
      try: () => readEntries(root),
      catch: (cause) => new GlobalSkillError({ cause }),
    });
    const skills: ServerProviderSkill[] = [];
    for (const folder of entries) {
      if (!FOLDER.test(folder)) continue;
      const dir = NodePath.join(root, folder);
      const contents = yield* Effect.tryPromise({
        try: () => readHead(NodePath.join(dir, "SKILL.md"), 16 * 1024),
        catch: (cause) => new GlobalSkillError({ cause }),
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) continue;
      const frontmatter = parseSkillFrontmatter(contents);
      const name = `${GOAT_SKILL_NAME_PREFIX}${folder}`;
      skills.push({
        name,
        path: dir,
        scope: GOAT_SKILL_SCOPE,
        enabled: !disabled.has(name),
        ...(frontmatter.kind === "parsed" && frontmatter.name
          ? { displayName: frontmatter.name }
          : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
    return skills;
  });
  const remove = Effect.fn("GlobalSkills.remove")(function* (name: string) {
    const folder = directoryName(name);
    if (!folder) return yield* new GlobalSkillError({ cause: "Invalid global skill name" });
    const target = NodePath.resolve(root, folder);
    if (NodePath.dirname(target) !== root)
      return yield* new GlobalSkillError({ cause: "Invalid global skill path" });
    yield* Effect.tryPromise({
      try: async () => {
        const stat = await NodeFSP.lstat(target);
        if (stat.isSymbolicLink()) await NodeFSP.unlink(target);
        else if (stat.isDirectory()) await NodeFSP.rm(target, { recursive: true });
        else throw new Error("Skill is not a directory");
      },
      catch: (cause) => new GlobalSkillError({ cause }),
    });
  });
  const readForTurn = Effect.fn("GlobalSkills.readForTurn")(function* (
    names: ReadonlyArray<string>,
  ) {
    const disabled = new Set(yield* input.disabled);
    const selected = [
      ...new Set(names.filter((name) => directoryName(name) && !disabled.has(name))),
    ].slice(0, 8);
    const blocks: string[] = [];
    const omitted: string[] = [];
    // A skill cut to fit still reaches the agent, which must know to read the rest itself.
    const truncated: string[] = [];
    for (const name of selected) {
      const dir = NodePath.join(root, directoryName(name) ?? "");
      const text = yield* Effect.tryPromise({
        try: () => readHead(NodePath.join(dir, "SKILL.md"), MAX_FILE),
        catch: (cause) => new GlobalSkillError({ cause }),
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (text === undefined) {
        omitted.push(name);
        continue;
      }
      const attributePath = dir
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      const block = `<goat_skill name="${name}" path="${attributePath}">\n${text.slice(0, MAX_SKILL)}\n</goat_skill>`;
      const notice = readInFull(root, selected);
      if ([...blocks, block, notice].join("\n\n").length > MAX_TOTAL) omitted.push(name);
      else {
        blocks.push(block);
        if (text.length > MAX_SKILL) truncated.push(name);
      }
    }
    const unread = selected.filter((name) => omitted.includes(name) || truncated.includes(name));
    if (unread.length) blocks.push(readInFull(root, unread));
    return blocks.join("\n\n");
  });
  return { list, remove, readForTurn, globalSkillsDir: root };
}
