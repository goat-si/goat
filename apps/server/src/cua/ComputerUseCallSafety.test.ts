import { describe, expect, it } from "@effect/vitest";
import { deniedCallApp } from "./ComputerUseCallSafety.ts";

describe("computer use call safety", () => {
  it("launch_app with bundle_id and urls is a second target under full access", () => {
    for (const value of [["https://example.com"], [], "", null]) {
      expect(
        deniedCallApp(
          { name: "launch_app", args: { bundle_id: "com.example.Editor", urls: value } },
          [],
          true,
        ),
      ).toBeDefined();
    }
    expect(
      deniedCallApp(
        { name: "launch_app", args: { bundle_id: "com.example.Editor", session: null } },
        [],
        true,
      ),
    ).toBeUndefined();
  });
  it("non-person full access refuses terminals on macOS, Linux and Windows", () => {
    for (const app of [
      "com.apple.Terminal",
      "dev.warp.Warp-Stable",
      "com.mitchellh.ghostty",
      "org.alacritty",
      "com.github.wez.wezterm",
      "co.zeit.hyper",
      "org.tabby",
      "com.googlecode.iterm2",
      "net.kovidgoyal.kitty",
      "/usr/bin/GNOME-Terminal-Server",
      "/usr/bin/kgx",
      "/usr/bin/ptyxis",
      "/usr/bin/konsole",
      "/usr/bin/xterm",
      "/usr/bin/xfce4-terminal",
      "/usr/bin/tilix",
      "/usr/bin/terminator",
      "/usr/bin/foot",
      "/usr/bin/urxvt",
      "/usr/bin/st",
      "/usr/bin/warp-terminal",
      "/opt/WezTerm-GUI",
      "C:\\Windows\\System32\\WindowsTerminal.EXE",
      "C:\\Windows\\System32\\WT.exe",
      "powershell",
      "pwsh",
      "cmd",
      "conhost",
      "openconsole",
      "iterm",
      "iterm2",
      "terminal",
      "warp",
      "ghostty",
      "kitty",
      "alacritty",
      "wezterm",
      "hyper",
      "tabby",
    ]) {
      expect(deniedCallApp({ name: "click", args: {}, app }, [], true), app).toBe(app);
    }
    expect(
      deniedCallApp({ name: "click", args: {}, app: "/usr/bin/editor" }, [], true),
    ).toBeUndefined();
  });
  it("does not allow a name-only launch when a safety policy applies", () => {
    expect(
      deniedCallApp({ name: "launch_app", args: { name: "Editor" } }, ["com.example.Blocked"]),
    ).toBe("Editor");
    expect(deniedCallApp({ name: "launch_app", args: { name: "Editor" } }, [], true)).toBe(
      "Editor",
    );
    expect(
      deniedCallApp({ name: "launch_app", args: { path: "/Applications/Editor.app" } }, [
        "com.example.Blocked",
      ]),
    ).toBe("/Applications/Editor.app");
  });
  it("does not allow a batch whose scope cannot be checked against policy", () => {
    const call = {
      name: "run_script",
      args: { app_scope: { apps: ["Editor"], delivery: "background" } },
    };
    expect(deniedCallApp(call, ["com.example.Blocked"])).toBe("Editor");
    expect(deniedCallApp(call, [], true)).toBe("Editor");
    expect(deniedCallApp({ name: "run_script", args: { script: "click()" } }, [], true)).toBe(
      "unscoped batch",
    );
  });
  it("permits a verified ordinary batch but refuses a terminal batch in non-person full access", () => {
    const call = (app: string) => ({
      name: "run_script",
      args: { app_scope: { apps: [app] } },
      safetyApps: [app],
    });
    expect(deniedCallApp(call("com.example.Editor"), [], true)).toBeUndefined();
    expect(deniedCallApp(call("com.apple.Terminal"), [], true)).toBe("com.apple.Terminal");
  });
  it("refuses terminal for non-person full access but allows a person's terminal", () => {
    const call = { name: "click", args: {}, app: "com.apple.Terminal" };
    expect(deniedCallApp(call, [], true)).toBe("com.apple.Terminal");
    expect(deniedCallApp(call, [], false)).toBeUndefined();
  });
  it("refuses organization-denied apps and batch scopes", () => {
    const denied = ["com.example.Blocked"];
    expect(deniedCallApp({ name: "click", args: {}, app: "COM.EXAMPLE.BLOCKED" }, denied)).toBe(
      "COM.EXAMPLE.BLOCKED",
    );
    expect(
      deniedCallApp(
        { name: "click", args: {}, app: "/example/editor", safetyApps: ["com.example.Blocked"] },
        denied,
      ),
    ).toBe("com.example.Blocked");
    expect(
      deniedCallApp(
        {
          name: "run_script",
          args: { app_scope: { apps: ["com.example.Blocked"], delivery: "background" } },
        },
        denied,
      ),
    ).toBe("com.example.Blocked");
    expect(
      deniedCallApp({ name: "click", args: {}, app: "com.example.Good" }, denied),
    ).toBeUndefined();
  });
});
