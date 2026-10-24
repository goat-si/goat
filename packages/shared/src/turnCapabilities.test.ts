import { describe, expect, it } from "vite-plus/test";

import { projectComposerContextForProvider } from "./composerContextReferences.ts";
import { requestedTurnCapabilities, withTurnCapabilities } from "./turnCapabilities.ts";

describe("turn capabilities", () => {
  it("counts only the chips still in the text", () => {
    const message = withTurnCapabilities({ text: "Open the dashboard" }, [
      "browser",
      "computer-use",
    ]);
    const records = message.context?.records ?? [];
    expect(requestedTurnCapabilities({ text: message.text, records })).toEqual([
      "browser",
      "computer-use",
    ]);
    const withoutComputer = message.text.replace(/\[Computer\]\([^)]*\) /, "");
    expect(requestedTurnCapabilities({ text: withoutComputer, records })).toEqual(["browser"]);
  });

  it("does not add a second chip for a capability the message already asks for", () => {
    const once = withTurnCapabilities({ text: "Go" }, ["browser"]);
    const twice = withTurnCapabilities(once, ["browser", "browser"]);
    expect(twice).toEqual(once);
  });

  it("tells the agent what was asked and what to do when the tools are missing", () => {
    const message = withTurnCapabilities({ text: "Sign in to the app" }, ["computer-use"]);
    const projected = projectComposerContextForProvider({
      text: message.text,
      records: message.context?.records ?? [],
    });
    expect(projected).toContain("[Capability: Computer; ref=capability_computer-use]");
    expect(projected).toContain("capability: computer-use");
    expect(projected).toContain("If those tools are not in your tool list");
  });
});
