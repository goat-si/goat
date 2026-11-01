import { expect, it } from "vite-plus/test";
import { ComposerContextId, EnvironmentId } from "@goat/contracts";
import { CONTEXT_CLIPBOARD_MIMES, GOAT_CONTEXT_LINK_PROTOCOL } from "@goat/contracts/legacyT3Names";
import { readPastedComposerContext, importPastedComposerText } from "./composerInlineTokenPaste";

const record = {
  version: 1 as const,
  kind: "mention" as const,
  contextId: ComposerContextId.make("ctx"),
  label: "file",
  path: "src/file.ts",
};
const fragment = {
  version: 1 as const,
  source: { environmentId: EnvironmentId.make("source") },
  records: [record],
};
// goat-rename: legacy-begin
it.each(CONTEXT_CLIPBOARD_MIMES)("imports context from clipboard MIME %s", (mime) => {
  for (const prefix of ["t3", "goat"]) {
    const clipboard = {
      getData: (type: string) =>
        type === "text/plain"
          ? `[file](${prefix}-context://v1/mention/ctx)`
          : type === mime
            ? JSON.stringify(fragment)
            : "",
    };
    expect(readPastedComposerContext(clipboard)).toEqual(fragment);
    expect(importPastedComposerText(clipboard, () => new Map([["ctx", "imported"]]))).toBe(
      `[file](${GOAT_CONTEXT_LINK_PROTOCOL}://v1/mention/imported)`,
    );
  }
});
// goat-rename: legacy-end
