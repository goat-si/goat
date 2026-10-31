import { describe, expect, it } from "vite-plus/test";
import { screenCodeAppNote } from "./computerUseSkillFiles.ts";

const apps = [
  ["Finder", "com.apple.finder"],
  ["System Settings", "com.apple.systempreferences"],
  ["KakaoTalk", "com.kakao.KakaoTalkMac"],
  ["TextEdit", "com.apple.textedit"],
  ["Preview", "com.apple.preview"],
  ["Safari", "com.apple.safari"],
] as const;

describe("screen-code app notes", () => {
  it.each(apps)("uses screen calls for %s and resolves its bundle id", (name, bundle) => {
    const note = screenCodeAppNote("darwin", name);
    expect(note).toBeTruthy();
    expect(note).not.toMatch(
      /element_token|press_key|invoke_menu|type_text|max_depth|list_windows|get_window_state|verify_state|hotkey|since/,
    );
    expect(screenCodeAppNote("darwin", bundle)).toBe(note);
    expect(screenCodeAppNote("linux", name)).toBeUndefined();
    expect(screenCodeAppNote("win32", name)).toBeUndefined();
  });

  it("preserves KakaoTalk's read and sending safeguards", () => {
    const note = screenCodeAppNote("darwin", "KakaoTalk");
    expect(note).toContain("Opening a chat marks its messages read");
    expect(note).toContain("confirm the recipient and the text with the person first");
    expect(note).toContain("{ send: true }");
    expect(note).toContain("only when the person asked");
    expect(note).toContain("never send again");
  });

  it.each(apps)("never teaches %s an Enter without a target, which chat apps refuse", (name) => {
    expect(screenCodeAppNote("darwin", name)).not.toMatch(/app\.press\("Enter"\)/);
  });

  it("teaches Enter in KakaoTalk only as a requested send, since the host refuses any other Enter there", () => {
    const presses =
      screenCodeAppNote("darwin", "KakaoTalk")?.match(/app\.press\("Enter"[^)]*\)/g) ?? [];
    expect(presses.length).toBeGreaterThan(0);
    for (const press of presses) expect(press).toContain("send: true");
  });
});
