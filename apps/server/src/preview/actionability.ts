// @effect-diagnostics nodeBuiltinImport:off - Playwright error messages can contain terminal color escapes.
import * as NodeUtil from "node:util";

export const actionabilityReason = (message: string) => {
  const lines = NodeUtil.stripVTControlCharacters(message).split("\n");
  for (const line of lines.toReversed()) {
    const match = /^\s*-\s*element is not (visible|enabled|stable)(?:\s|$)/i.exec(line);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return undefined;
};
