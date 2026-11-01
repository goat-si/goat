import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { LEGACY_RENDER_COUNTER_GLOBALS } from "@goat/contracts/legacyT3Names";
import {
  isRenderCounterApp,
  renderCounterScheme,
  renderCounterAliases,
  renderCounterCall,
  RENDER_COUNTER_GLOBALS,
} from "./render-counter-protocol";

describe("measurement script and running app compatibility", () => {
  it.each([RENDER_COUNTER_GLOBALS, LEGACY_RENDER_COUNTER_GLOBALS])(
    "calls a complete namespace from either app version",
    (names) => {
      let running = false;
      const context = {
        [names.start]: () => {
          running = true;
        },
        [names.stop]: () => ({ commits: running ? 1 : 0 }),
        [names.open]: (url: string) => url,
        [names.reload]: () => true,
      };
      NodeVM.runInNewContext(renderCounterCall("start"), context);
      expect(NodeVM.runInNewContext(renderCounterCall("stop"), context)).toEqual({ commits: 1 });
      expect(
        NodeVM.runInNewContext(renderCounterCall("open", "goat-dev://threads/1"), context),
      ).toBe("goat-dev://threads/1");
    },
  );

  it("old scripts and new scripts share state through aliases", () => {
    let commits = 0;
    const context = renderCounterAliases({
      start: () => {
        commits = 2;
      },
      stop: () => ({ commits }),
      open: () => true,
      reload: () => true,
    });
    NodeVM.runInNewContext(`${LEGACY_RENDER_COUNTER_GLOBALS.start}()`, context);
    expect(NodeVM.runInNewContext(renderCounterCall("stop"), context)).toEqual({ commits: 2 });
    NodeVM.runInNewContext(renderCounterCall("start"), context);
    expect(NodeVM.runInNewContext(`${LEGACY_RENDER_COUNTER_GLOBALS.stop}()`, context)).toEqual({
      commits: 2,
    });
  });

  it("prefers GOAT and propagates errors without retrying a legacy side effect", () => {
    let legacyCalls = 0;
    const legacy = Object.fromEntries(
      Object.values(LEGACY_RENDER_COUNTER_GLOBALS).map((name) => [
        name,
        () => {
          legacyCalls++;
        },
      ]),
    );
    const goat = Object.fromEntries(
      Object.values(RENDER_COUNTER_GLOBALS).map((name) => [
        name,
        () => {
          throw new Error("operation failed");
        },
      ]),
    );
    expect(() =>
      NodeVM.runInNewContext(renderCounterCall("start"), { ...legacy, ...goat }),
    ).toThrow("operation failed");
    expect(legacyCalls).toBe(0);
    expect(() => NodeVM.runInNewContext(renderCounterCall("start"), {})).toThrow(
      "Render counter unavailable",
    );
  });

  it("ignores partial GOAT capabilities when an old complete app is available", () => {
    const context = Object.fromEntries(
      Object.values(LEGACY_RENDER_COUNTER_GLOBALS).map((name) => [name, () => "legacy"]),
    );
    context[RENDER_COUNTER_GLOBALS.start] = () => {
      throw new Error("Partial namespace must not run");
    };
    expect(NodeVM.runInNewContext(renderCounterCall("start"), context)).toBe("legacy");
  });

  it.each([
    "si.goat.mobile",
    "si.goat.mobile.dev",
    "si.goat.mobile.preview",
    "com.t3tools.t3code.dev",
  ])("discovers current or older app %s", (id) => {
    expect(isRenderCounterApp(id)).toBe(true);
  });

  it("rejects an unrelated app attached to Metro", () => {
    expect(isRenderCounterApp("com.example.other")).toBe(false);
    expect(isRenderCounterApp("si.goat.mobile.unrelated")).toBe(false);
  });
});

describe("measurement link scheme", () => {
  it.each([
    ["si.goat.mobile.dev", "goat-dev"],
    ["si.goat.mobile.preview", "goat-preview"],
    ["si.goat.mobile", "goat"],
    ["com.t3tools.t3code.dev", "t3code-dev"],
  ])("opens the discovered %s app with its registered scheme", (appId, scheme) => {
    expect(renderCounterScheme(appId!)).toBe(scheme);
  });

  it.each(["si.goat.mobile.dev", "com.t3tools.t3code.dev"])("honors --scheme for %s", (appId) =>
    expect(renderCounterScheme(appId, "custom-scheme")).toBe("custom-scheme"),
  );
});
