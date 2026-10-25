// @effect-diagnostics nodeBuiltinImport:off -- The lease proxy CLI writes no files; installing the skill is a plain sync write at attach time.
/**
 * Where an agent finds GOAT's computer use guide on disk, and the app notes the lease proxy adds
 * to its first read of an app's window, like Aside's per-app guidance in `getApp`. The skill is
 * written under the server's state directory on the machine that runs the driver, which is the
 * machine every agent with computer use runs on.
 *
 * @module ComputerUseGuide
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  COMPUTER_USE_SKILL_DIRECTORY,
  COMPUTER_USE_SKILL_FILE,
  computerUseAppNote,
  computerUseSkillFiles,
} from "@goat/provider-core/server/builtinSkills/computerUseSkillFiles";

/**
 * Writes the skill for this platform under `<stateDir>/skills/computer-use` when it differs from
 * what is there, and returns its SKILL.md path. Undefined when it cannot be written: the always-on
 * sections still carry the rules, so a missing file only loses the long guide.
 */
export function installComputerUseSkill(
  stateDir: string,
  platform: NodeJS.Platform,
): string | undefined {
  const directory = NodePath.join(stateDir, "skills", COMPUTER_USE_SKILL_DIRECTORY);
  try {
    for (const [relative, content] of Object.entries(computerUseSkillFiles(platform))) {
      const target = NodePath.join(directory, relative);
      let current: string | undefined;
      try {
        current = NodeFS.readFileSync(target, "utf8");
      } catch {
        current = undefined;
      }
      if (current === content) continue;
      NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
      // Written whole then renamed, so a reader never sees half a file.
      const temporary = target + ".tmp-" + process.pid;
      NodeFS.writeFileSync(temporary, content);
      NodeFS.renameSync(temporary, target);
    }
    return NodePath.join(directory, COMPUTER_USE_SKILL_FILE);
  } catch {
    return undefined;
  }
}

/** The first line a provider gets that points at the skill file. */
const skillPointer = (skillPath: string) =>
  `Before the first computer use action in a turn, read the computer use skill at ${skillPath} (and the files it names when they apply).`;

/**
 * What the lease proxy adds to tool answers on their way to the agent, like Aside's guidance in
 * `getApp`: the skill's path on the first successful answer of the connection, and an app's notes
 * on the first successful answer about that app's window. Lines it cannot read, errors and
 * handshake answers pass unchanged.
 */
export function makeAppGuide(platform: NodeJS.Platform, skillPath: string | undefined) {
  const told = new Set<string>();
  let pointed = skillPath === undefined;
  return (line: string): string => {
    // Answers can carry megabytes of screenshot; only parse one that can need a note.
    if (
      pointed &&
      !line.includes('"app_name"') &&
      !(skillPath !== undefined && line.includes('"protocolVersion"'))
    )
      return line;
    let message: {
      result?: {
        protocolVersion?: unknown;
        instructions?: unknown;
        content?: unknown;
        isError?: unknown;
        structuredContent?: { app_name?: unknown };
      };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return line;
    }
    const result = message?.result;
    // The MCP initialize answer: providers that read server instructions learn the skill's path
    // before any call (modelcontextprotocol.io, "Server Instructions").
    if (result !== undefined && "protocolVersion" in result && skillPath !== undefined) {
      const own = typeof result.instructions === "string" ? result.instructions + "\n\n" : "";
      result.instructions = own + skillPointer(skillPath);
      return JSON.stringify(message);
    }
    if (result === undefined || result.isError === true || !Array.isArray(result.content))
      return line;
    const added: Array<{ type: "text"; text: string }> = [];
    if (!pointed && skillPath !== undefined) {
      pointed = true;
      added.push({ type: "text", text: skillPointer(skillPath) });
    }
    const app = result.structuredContent?.app_name;
    const note =
      typeof app === "string" && !told.has(app) ? computerUseAppNote(platform, app) : undefined;
    if (note !== undefined && typeof app === "string") {
      told.add(app);
      added.push({ type: "text", text: `GOAT notes for ${app}:\n${note}` });
    }
    if (added.length === 0) return line;
    result.content = [...(result.content as ReadonlyArray<unknown>), ...added];
    return JSON.stringify(message);
  };
}
