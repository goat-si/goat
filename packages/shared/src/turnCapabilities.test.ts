import { describe, expect, it } from "vite-plus/test";

import { projectComposerContextForProvider } from "./composerContextReferences.ts";
import {
  appCapabilityContextRecord,
  appIdForContextId,
  capabilityContextRecordsInText,
  requestedTurnCapabilities,
  turnCapabilityContextRecord,
  turnCapabilityForContextId,
  withTurnCapabilities,
} from "./turnCapabilities.ts";
import { formatComposerContextReference } from "./composerContextReferences.ts";

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

  it("rebuilds a composer's capability records from the chips in its text", () => {
    const { text, context } = withTurnCapabilities({ text: "Look" }, ["computer-use"]);
    expect(capabilityContextRecordsInText(`${text} and again ${text}`)).toEqual(context?.records);
    expect(
      capabilityContextRecordsInText("[Computer](goat-context://v1/capability/other)"),
    ).toEqual([]);
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

describe("app chips", () => {
  const finder = appCapabilityContextRecord({ id: "com.apple.finder", name: "Finder" });

  it("ask for computer use aimed at one app, carried in the chip's id", () => {
    expect(finder).toMatchObject({
      kind: "capability",
      capability: "computer-use",
      label: "Finder",
      app: { id: "com.apple.finder", name: "Finder" },
    });
    expect(appIdForContextId(finder.contextId)).toBe("com.apple.finder");
    expect(turnCapabilityForContextId(finder.contextId)).toBe("computer-use");
    expect(
      appIdForContextId(turnCapabilityContextRecord("computer-use").contextId),
    ).toBeUndefined();
    expect(appIdForContextId("app_zz")).toBeUndefined();
  });

  it("round-trip through the text: a sent message keeps the app and asks for computer use", () => {
    const text = `${formatComposerContextReference(finder)} open Downloads`;
    const records = capabilityContextRecordsInText(text);
    expect(records).toEqual([finder]);
    expect(requestedTurnCapabilities({ text, records })).toEqual(["computer-use"]);
  });

  it("keep an executable path id that fits the context id", () => {
    const record = appCapabilityContextRecord({ id: "C:\\Apps\\Editor.exe", name: "Editor" });
    expect(appIdForContextId(record.contextId)).toBe("C:\\Apps\\Editor.exe");
    expect(record.contextId.length).toBeLessThanOrEqual(128);
  });
});

describe("app chip provider note", () => {
  it("names the app and its id for the agent", () => {
    const record = appCapabilityContextRecord({ id: "com.kakao.KakaoTalkMac", name: "KakaoTalk" });
    const projected = projectComposerContextForProvider({
      text: `${formatComposerContextReference(record)} 메시지 확인해줘`,
      records: [record],
    });
    expect(projected).toContain("capability: computer-use");
    expect(projected).toContain("app: KakaoTalk");
    expect(projected).toContain("appId: com.kakao.KakaoTalkMac");
  });
});
