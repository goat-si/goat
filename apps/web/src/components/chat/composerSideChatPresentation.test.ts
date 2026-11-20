import { expect, it } from "vite-plus/test";
import { composerTextCommandIsLocal } from "./composerSideChatPresentation";

it("recognizes offered usage, feedback and fork commands as local", () => {
  const options = {
    hasAttachmentsOrContext: false,
    usageLimits: true,
    codexFeedback: true,
    fork: true,
  };
  expect(composerTextCommandIsLocal("/usage-limits", options)).toBe(true);
  expect(composerTextCommandIsLocal("/feedback details", options)).toBe(true);
  expect(composerTextCommandIsLocal("/fork", options)).toBe(true);
  expect(composerTextCommandIsLocal("ordinary", options)).toBe(false);
});
