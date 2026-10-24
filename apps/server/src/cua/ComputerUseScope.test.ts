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
  it("lists a pid again after a reply names its app without the bundle id a grant names", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
    // get_window_state answers with the app's name and pid but no bundle id.
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid, window_id: 57000 }, listed);
    assert.deepEqual(verdict(listed), { _tag: "resolve", pid: KAKAO.pid });
    // The listing the proxy asks for then judges the call by bundle id again.
    learnApps({ apps: [KAKAO] }, listed);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
  });

  it("does not let a same-named app that reused the pid inherit the approved bundle id", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed);
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid }, listed);
    learnApps({ apps: [{ ...KAKAO, bundle_id: "com.example.KakaoTalk" }] }, listed);
    assert.deepEqual(verdict(listed), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: "com.example.KakaoTalk",
    });
  });
});
