import { assert, describe, it } from "@effect/vitest";

import { approvedApps, learnApps, type ListedApp, scopeVerdict } from "./ComputerUseScope.ts";

const KAKAO = { pid: 6972, bundle_id: "com.kakao.KakaoTalkMac", name: "KakaoTalk" };

const verdict = (listed: Map<number, ListedApp>) =>
  scopeVerdict({
    name: "click",
    args: { pid: KAKAO.pid, window_id: 57000, x: 51, y: 104 },
    apps: approvedApps([KAKAO.bundle_id]),
    appOf: (pid) => listed.get(pid),
    bundleIds: true,
  });

describe("learnApps", () => {
  it("refuses protected apps even under an unrestricted control", () => {
    for (const id of [
      "com.apple.systempreferences",
      "com.apple.loginwindow",
      "com.apple.SecurityAgent",
      "com.apple.coreauthd",
      "com.apple.LocalAuthentication.UIAgent",
      "com.apple.keychainaccess",
      "com.apple.ScreenTimeAgent",
      "com.apple.ScreenTimeWidgetApplication",
      "com.apple.ScreenTimeViewService",
    ]) {
      const result = scopeVerdict({
        name: "click",
        args: { pid: 12, window_id: 34 },
        apps: undefined,
        appOf: () => ({ id, name: "System app" }),
        bundleIds: true,
      });
      assert.equal(result._tag, "refuse", id);
      if (result._tag === "refuse") assert.equal(result.reason, "app_not_allowed", id);
    }
  });

  it("does not run an unrestricted batch without an app scope", () => {
    assert.equal(
      scopeVerdict({
        name: "run_script",
        args: { script: "click()" },
        apps: undefined,
        appOf: () => undefined,
        bundleIds: true,
      })._tag,
      "refuse",
    );
  });

  it("refuses protected apps in batch scopes even when the grant names them", () => {
    for (const apps of [undefined, approvedApps(["com.apple.systempreferences"])]) {
      assert.deepInclude(
        scopeVerdict({
          name: "run_script",
          args: {
            script: "click()",
            app_scope: { apps: ["com.apple.systempreferences"], delivery: "background" },
          },
          apps,
          appOf: () => undefined,
          bundleIds: true,
        }),
        { _tag: "refuse", reason: "app_not_allowed" },
      );
    }
  });
  it("lists a pid again after a reply names its app without the bundle id a grant names", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed, true);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
    // get_window_state answers with the app's name and pid but no bundle id.
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid, window_id: 57000 }, listed, false);
    assert.deepEqual(verdict(listed), { _tag: "resolve", pid: KAKAO.pid });
    // The listing the proxy asks for then judges the call by bundle id again.
    learnApps({ apps: [KAKAO] }, listed, true);
    assert.deepEqual(verdict(listed), { _tag: "allow" });
  });

  it("does not let a same-named app that reused the pid inherit the approved bundle id", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [KAKAO] }, listed, true);
    learnApps({ app_name: "KakaoTalk", pid: KAKAO.pid }, listed, false);
    learnApps({ apps: [{ ...KAKAO, bundle_id: "com.example.KakaoTalk" }] }, listed, true);
    assert.deepEqual(verdict(listed), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: "com.example.KakaoTalk",
    });
  });

  // Linux list_apps nests each running app's windows, which name the process, not the desktop id.
  const CALCULATOR = {
    pid: 3827077,
    bundle_id: "org.gnome.Calculator",
    name: "Calculator",
    windows: [{ app_name: "gnome-calculator", pid: 3827077, window_id: 8388612 }],
  };
  const readCalculator = (listed: Map<number, ListedApp>) =>
    scopeVerdict({
      name: "get_window_state",
      args: { pid: CALCULATOR.pid, window_id: 8388612 },
      apps: approvedApps([CALCULATOR.bundle_id]),
      appOf: (pid) => listed.get(pid),
      bundleIds: false,
    });

  it("keeps an approved Linux app's desktop id when list_apps nests its windows", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [CALCULATOR] }, listed, true);
    assert.deepEqual(readCalculator(listed), { _tag: "allow" });
  });

  it("keeps an approved Linux app's desktop id when list_apps also lists it as a process", () => {
    // The pinned Linux driver answers list_apps with the apps and, beside them, every process.
    for (const answer of [
      { apps: [CALCULATOR], processes: [{ name: "Calculator", pid: CALCULATOR.pid }] },
      { processes: [{ name: "Calculator", pid: CALCULATOR.pid }], apps: [CALCULATOR] },
    ]) {
      const listed = new Map<number, ListedApp>();
      learnApps({ structuredContent: answer }, listed, true);
      assert.deepEqual(readCalculator(listed), { _tag: "allow" });
    }
  });

  it("lists the apps again before refusing a pid known only by its window's app name", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ windows: CALCULATOR.windows }, listed, false);
    assert.deepEqual(readCalculator(listed), { _tag: "resolve", pid: CALCULATOR.pid });
    learnApps({ apps: [CALCULATOR] }, listed, true);
    assert.deepEqual(readCalculator(listed), { _tag: "allow" });
  });

  // A request may name an app without a bundle id by the executable it runs.
  it("lets select_text reach only the approved app whose window it targets", () => {
    const listed = new Map<number, ListedApp>();
    learnApps(
      { apps: [KAKAO, { pid: 7100, bundle_id: "com.apple.Notes", name: "Notes" }] },
      listed,
      true,
    );
    const judge = (pid: number) =>
      scopeVerdict({
        name: "select_text",
        args: { pid, window_id: 57000, element_token: "s0000abcd:3", text: "hello" },
        apps: approvedApps([KAKAO.bundle_id]),
        appOf: (known) => listed.get(known),
        bundleIds: true,
      });
    assert.equal(judge(KAKAO.pid)._tag, "allow");
    assert.deepInclude(judge(7100), { _tag: "refuse", reason: "app_not_approved" });
  });

  it.each([
    {
      host: "Windows, where the helper's list_apps gives the executable",
      entry: { pid: 4100, name: "notes.exe", executable: "C:\\Apps\\notes.exe" },
      approved: "c:\\apps\\notes.exe",
      executableOf: undefined,
    },
    {
      host: "Linux, where the proxy reads it from /proc",
      entry: { pid: 4100, name: "xeyes" },
      approved: "/usr/bin/xeyes",
      executableOf: (pid: number) => (pid === 4100 ? "/usr/bin/xeyes" : undefined),
    },
  ])("allows an app approved by its executable path on $host", (input) => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [input.entry] }, listed, true, input.executableOf);
    const judge = (apps: ReadonlyArray<string>) =>
      scopeVerdict({
        name: "click",
        args: { pid: 4100, window_id: 9 },
        apps: approvedApps(apps),
        appOf: (pid) => listed.get(pid),
        bundleIds: false,
      });
    assert.equal(judge([input.approved])._tag, "allow");
    assert.deepInclude(judge(["/usr/bin/other"]), { _tag: "refuse", reason: "app_not_approved" });
  });

  it("matches a Linux executable path exactly, and a Windows one the way Windows spells it", () => {
    const judge = (entry: Record<string, unknown>, apps: ReadonlyArray<string>) => {
      const listed = new Map<number, ListedApp>();
      learnApps({ apps: [{ pid: 4100, name: "notes", ...entry }] }, listed, true);
      return scopeVerdict({
        name: "click",
        args: { pid: 4100, window_id: 9 },
        apps: approvedApps(apps),
        appOf: (pid) => listed.get(pid),
        bundleIds: false,
      })._tag;
    };
    assert.equal(judge({ executable: "/opt/notes" }, ["/opt/Notes"]), "refuse");
    assert.equal(judge({ executable: "/opt/Notes" }, ["/opt/notes"]), "refuse");
    assert.equal(judge({ executable: "/opt/Notes" }, ["/opt/Notes"]), "allow");
    assert.equal(judge({ executable: "C:\\Apps\\Notes.exe" }, ["c:/apps//NOTES.EXE"]), "allow");
    // A name still matches as before, whatever its case.
    assert.equal(judge({}, ["NOTES"]), "allow");
  });

  it("names a process without a desktop id by its listed name, never by what its windows say", () => {
    const listed = new Map<number, ListedApp>();
    // A window titles its app however it likes, even as another app's desktop id.
    const fixture = {
      pid: 3731239,
      bundle_id: null,
      name: "python3",
      windows: [{ app_name: "org.example.Editor", pid: 3731239, window_id: 4194307 }],
    };
    learnApps(
      { apps: [fixture], processes: [{ name: "python3", pid: fixture.pid }] },
      listed,
      true,
    );
    const read = (apps: ReadonlyArray<string>) =>
      scopeVerdict({
        name: "get_window_state",
        args: { pid: fixture.pid, window_id: 4194307 },
        apps: approvedApps(apps),
        appOf: (pid) => listed.get(pid),
        bundleIds: false,
      });
    assert.deepEqual(read(["org.example.Editor"]), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: "python3",
    });
    assert.deepEqual(read(["python3"]), { _tag: "allow" });
  });
});

describe("scopeVerdict", () => {
  it("approves an app by the id list_apps reports, so its display name is no second grant to it", () => {
    const byName = (listed: Map<number, ListedApp>) =>
      scopeVerdict({
        name: "click",
        args: { pid: KAKAO.pid, window_id: 57000, x: 51, y: 104 },
        apps: approvedApps([KAKAO.name]),
        appOf: (pid) => listed.get(pid),
        bundleIds: true,
      });
    const listed = new Map<number, ListedApp>();
    // list_windows on macOS names the app without its bundle id; that is no identity.
    learnApps(
      { windows: [{ pid: KAKAO.pid, app_name: KAKAO.name, window_id: 57000 }] },
      listed,
      false,
    );
    assert.deepEqual(byName(listed), { _tag: "resolve", pid: KAKAO.pid });
    learnApps({ apps: [KAKAO] }, listed, true);
    assert.deepEqual(byName(listed), {
      _tag: "refuse",
      reason: "app_not_approved",
      app: KAKAO.bundle_id,
    });
    // A later name-only answer cannot replace the listed identity with the display name.
    learnApps(
      { windows: [{ pid: KAKAO.pid, app_name: KAKAO.name, window_id: 57000 }] },
      listed,
      false,
    );
    assert.notDeepEqual(byName(listed), { _tag: "allow" });
  });

  it("keeps apps the driver lists by name alone, as on Linux and Windows", () => {
    const listed = new Map<number, ListedApp>();
    learnApps({ apps: [{ pid: 12, name: "gedit" }] }, listed, true);
    learnApps({ pid: 12, app_name: "gedit", window_id: 3 }, listed, false);
    assert.deepEqual(
      scopeVerdict({
        name: "click",
        args: { pid: 12, window_id: 3, x: 1, y: 1 },
        apps: approvedApps(["gedit"]),
        appOf: (pid) => listed.get(pid),
        bundleIds: false,
      }),
      { _tag: "allow" },
    );
  });

  it("takes a listed app's bundle id over the windows its entry nests", () => {
    const listed = new Map<number, ListedApp>();
    learnApps(
      {
        apps: [{ ...KAKAO, windows: [{ pid: KAKAO.pid, app_name: KAKAO.name, window_id: 57000 }] }],
      },
      listed,
      true,
    );
    assert.deepEqual(listed.get(KAKAO.pid), {
      id: KAKAO.bundle_id,
      name: KAKAO.name,
      bundleId: KAKAO.bundle_id,
    });
    assert.deepEqual(verdict(listed), { _tag: "allow" });
  });

  it("takes a listed app's id over the name-only processes list Windows and Linux send beside it", () => {
    const listed = new Map<number, ListedApp>();
    learnApps(
      {
        structuredContent: {
          apps: [{ pid: 42, bundle_id: "org.example.Editor", name: "Editor" }],
          processes: [{ pid: 42, name: "Editor" }],
        },
      },
      listed,
      true,
    );
    assert.deepEqual(listed.get(42), {
      id: "org.example.Editor",
      name: "Editor",
      bundleId: "org.example.Editor",
    });
  });

  it("launches an app under a list only by an approved bundle id on macOS, and never elsewhere", () => {
    const launch = (args: object, bundleIds: boolean, apps: ReadonlyArray<string>) =>
      scopeVerdict({
        name: "launch_app",
        args,
        apps: approvedApps(apps),
        appOf: () => undefined,
        bundleIds,
      });
    // A grant naming Safari by name must not open the Safari another grant holds by bundle id.
    assert.deepInclude(
      launch({ name: "Safari", urls: ["https://example.com"] }, true, ["Safari"]),
      {
        _tag: "refuse",
        launch: "bundle_id",
      },
    );
    assert.deepInclude(
      launch({ bundle_id: "com.apple.Safari", name: "Safari" }, true, ["com.apple.Safari"]),
      { _tag: "refuse", launch: "bundle_id" },
    );
    assert.deepEqual(launch({ bundle_id: "com.apple.Safari" }, true, ["com.apple.Safari"]), {
      _tag: "allow",
    });
    // Linux runs launch_path (or opens urls) whatever bundle_id says, and Windows prefers a path
    // or AUMID over it, so no argument there proves which app opens.
    for (const args of [
      { bundle_id: "org.gnome.gedit", launch_path: "firefox" },
      { name: "gedit" },
      { bundle_id: "org.gnome.gedit", urls: ["https://example.com"] },
    ])
      assert.deepInclude(launch(args, false, ["org.gnome.gedit", "gedit"]), {
        _tag: "refuse",
        launch: "unverifiable",
      });
  });
});
