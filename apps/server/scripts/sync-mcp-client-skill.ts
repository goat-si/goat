// @effect-diagnostics nodeBuiltinImport:off - a one-off maintenance script with no Effect runtime.
// Regenerates src/cli/mcpClientSkill.ts from the installable skill after editing
// skills/goat-mcp/SKILL.md. Run it after `vp fmt`, which reflows the markdown.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const skillPath = NodePath.join(repoRoot, "skills/goat-mcp/SKILL.md");
const modulePath = NodePath.join(repoRoot, "apps/server/src/cli/mcpClientSkill.ts");

const escaped = NodeFS.readFileSync(skillPath, "utf8")
  .replaceAll("\\", "\\\\")
  .replaceAll("`", "\\`")
  .replaceAll("${", "\\${");

NodeFS.writeFileSync(
  modulePath,
  [
    "// Generated from skills/goat-mcp/SKILL.md by apps/server/scripts/sync-mcp-client-skill.ts.",
    "// Bundled so `goat mcp skill` works offline; mcpClientSkill.test.ts fails when they differ.",
    `export const MCP_CLIENT_SKILL = \`${escaped}\`;`,
    "",
  ].join("\n"),
);
