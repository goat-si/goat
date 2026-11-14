// @effect-diagnostics nodeBuiltinImport:off - a static scan of script files with no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

it("rejects unverified automatic downloads in scripts", () => {
  const root = import.meta.dirname;
  const violations: string[] = [];
  // This is a single-line regression guard, not a shell parser.
  function scan(directory: string): void {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "fixtures") scan(path);
      } else if (/\.(?:ts|mjs|cjs|sh|ps1)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        for (const [index, line] of NodeFS.readFileSync(path, "utf8").split(/\r?\n/).entries()) {
          if (/^\s*(?:#|\/\/|\*|<#)/.test(line)) continue;
          if (
            /\bnpx\b.*(?:--yes\b|(?:^|\s)-y(?:\s|$))|\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash|zsh)\b|\b(?:irm|iwr)\b[^\n]*\|\s*iex\b/i.test(
              line,
            )
          ) {
            violations.push(`${NodePath.relative(root, path)}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }
  }
  scan(root);
  assert.deepEqual(violations, []);
});
