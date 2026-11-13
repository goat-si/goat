import { isChangedCode } from "../check-changed-command.ts";

// The prose audit.ts scans for tool and CLI mentions; check:changed reruns the audit when one changes.
export const AUDIT_OUTPUT = "docs/internals/agent-surface-audit.md";
export const AUDIT_DOC_DIRS: ReadonlyArray<string> = ["docs", "structure", ".agents/skills"];
export const AUDIT_ROOT_DOCS: ReadonlyArray<string> = ["AGENTS.md", "CONTRIBUTING.md", "README.md"];

const isAuditScannedDoc = (file: string): boolean =>
  file.endsWith(".md") &&
  (AUDIT_ROOT_DOCS.includes(file) || AUDIT_DOC_DIRS.some((dir) => file.startsWith(`${dir}/`)));

// CI's check job runs these on every pull request. The audit cites code across the repository and
// scans docs for tool mentions, so a change to either can make its page stale.
export function agentSurfaceCheckSteps(
  files: ReadonlyArray<string>,
): Array<{ name: string; args: Array<string> }> {
  if (!files.some((file) => isChangedCode(file) || isAuditScannedDoc(file))) return [];
  return [
    { name: "agent surface audit", args: ["run", "agent-surface:check"] },
    { name: "agent context budget", args: ["run", "agent-surface:context-budget-check"] },
  ];
}
