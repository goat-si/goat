import { assert, describe, it } from "@effect/vitest";

import { approvedApps, learnApps, type ListedApp, scopeVerdict } from "./ComputerUseScope.ts";

const KAKAO = { pid: 6972, bundle_id: "com.kakao.KakaoTalkMac", name: "KakaoTalk" };

const verdict = (listed: Map<number, ListedApp>) =>
  scopeVerdict({
    name: "click",
    args: { pid: KAKAO.pid, window_id: 57000, x: 51, y: 104 },
    apps: approvedApps([KAKAO.bundle_id]),
    appOf: (pid) => listed.get(pid),
  });

describe("learnApps", () => {
  it("keeps the bundle id a listing gave when a later reply names the app only", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
    // get_window_state answers with the app's name and pid but no bundle id.
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid, window_id: 57000 }, listed);
    assert.deepEqual(listed.get(KAKAO.pid), { id: KAKAO.bundle_id, name: "KakaoTalk" });
    assert.deepEqual(verdict(listed), { _tag: "allow" });
  });

  it("forgets a pid's bundle id once a reply shows another app on it", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed);
    learnApps({ app_name: "Calculator", pid: KAKAO.pid }, listed);
    assert.deepEqual(listed.get(KAKAO.pid), { id: "Calculator", name: "Calculator" });
    assert.deepEqual(verdict(listed), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: "Calculator",
    });
  });
});
