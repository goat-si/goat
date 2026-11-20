import { expect, it } from "vite-plus/test";
import { mobileComposerLocalCommand } from "./composerLocalCommand";

it("classifies offered local commands without changing ordinary redirects", () => {
  const input = { attachmentCount: 0, usageLimitsOffered: true, inThread: true, codex: true };
  expect(mobileComposerLocalCommand("/side question", input)).toBe(true);
  expect(mobileComposerLocalCommand("/usage-limits", input)).toBe(true);
  expect(mobileComposerLocalCommand("/feedback details", input)).toBe(true);
  expect(mobileComposerLocalCommand("/fork", input)).toBe(true);
  expect(mobileComposerLocalCommand("ordinary", input)).toBe(false);
});
