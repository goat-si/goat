import { it } from "@effect/vitest";
import {
  SecretRef,
  SecretRequestError,
  ThreadId,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CDPSession, Page } from "playwright-core";
import { expect } from "vite-plus/test";

import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerBrowserSecretFill from "./ServerBrowserSecretFill.ts";
import { SessionControl } from "./SessionControl.ts";

const threadId = ThreadId.make("secret-fill-unit");
const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
const PASSWORD = "pw_unit_secret_value";

/** One password field behind a scripted CDP session; faults are injected per method. */
const makeTab = (faults: { readonly fillReply?: boolean; readonly stillFilled?: boolean } = {}) => {
  const field = { value: "", type: "password", isConnected: true };
  const page = { frames: () => [], mainFrame: () => page } as unknown as Page;
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.releaseObject") return {};
    if (method === "DOM.describeNode") return { node: { nodeName: "INPUT" } };
    const fn = String(params?.functionDeclaration);
    const args = (params?.arguments ?? []) as Array<{ readonly value: unknown }>;
    if (fn.includes("querySelectorAll(selector)"))
      return { result: { subtype: "node", objectId: "field" } };
    if (fn.includes("self.origin : null")) return { result: { value: "https://login.test" } };
    if (fn.includes("HTMLInputElement.prototype")) {
      field.value = String(args[0]?.value);
      if (faults.fillReply) throw new Error("Target closed");
      return { result: { value: true } };
    }
    if (fn.includes('return "empty"')) {
      if (faults.stillFilled) throw new Error("Session closed");
      // Runs the page-side check against the scripted field.
      const check = new Function(`return (${fn});`)() as (this: object, value: unknown) => unknown;
      return { result: { value: check.call({ ...field }, args[0]?.value) } };
    }
    throw new Error(`unexpected ${method}`);
  };
  const tab = {
    page,
    cdp: { send } as unknown as CDPSession,
    frameSessions: new Map(),
    control: new SessionControl("agent-a"),
    recording: null as unknown,
    recordingStart: null as unknown,
  };
  return { tab, field };
};

const request = (operation: PreviewAutomationRequest["operation"], input: unknown) =>
  ({
    requestId: "r",
    threadId,
    operation,
    input,
    timeoutMs: 15_000,
    agentSessionId: "agent-a",
  }) as const;

const fillRequest = request("fillSecret", { secretRef: ref, selector: "#pw" });
const record = <T, A>(_tab: T, _action: string, run: () => Promise<A>) => run();

/** A one-use ref whose consumption can run a hook first, as a person's Stop would land. */
const withFill = <A>(
  body: (
    fill: Effect.Success<typeof ServerBrowserSecretFill.make>,
    state: { consumed: number },
  ) => Promise<A>,
  beforeConsume: () => void = () => {},
  passwords: ReadonlyArray<string> = [PASSWORD],
) => {
  const state = { consumed: 0 };
  const secrets = Layer.succeed(
    SecretRequests.SecretRequests,
    SecretRequests.SecretRequests.of({
      answer: () => Effect.die("unused"),
      savedRef: () => Effect.die("unused"),
      consume: () => Effect.die("unused"),
      saveToFile: () => Effect.die("unused"),
      consumeForOrigin: (input) =>
        Effect.sync(beforeConsume).pipe(
          Effect.flatMap(() =>
            input.origin === "https://login.test" && state.consumed < passwords.length
              ? Effect.sync(() => passwords[state.consumed++]!)
              : Effect.fail(new SecretRequestError({ reason: "ref_unavailable" })),
          ),
        ),
    }),
  );
  return ServerBrowserSecretFill.make.pipe(
    Effect.flatMap((fill) => Effect.promise(() => body(fill, state))),
    Effect.provide(secrets),
  );
};

/** Absolute deadlines that never and always passed, so no clock is read. */
const later = () => Number.POSITIVE_INFINITY;
const expired = 0;

it.live("keeps the fence when the fill's reply is lost after the page may have typed it", () => {
  const { tab, field } = makeTab({ fillReply: true });
  return withFill(async (fill) => {
    await expect(fill.fill(tab, fillRequest, later(), record)).rejects.toThrow(
      "could not confirm whether the password was typed",
    );
    expect(field.value).toBe(PASSWORD);
    await expect(fill.guard(tab, request("evaluate", { expression: "1" }))).rejects.toThrow(
      "holds a password GOAT filled",
    );
  });
});

it.live("keeps the fence when GOAT cannot check the filled field", () => {
  const { tab } = makeTab({ stillFilled: true });
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record);
    await expect(fill.guard(tab, request("recordingStart", {}))).rejects.toThrow(
      "cannot confirm the password it filled is gone",
    );
    // The field may now show part of the value as plain text, which the mask cannot find.
    await expect(fill.guard(tab, request("snapshot", { captureImage: false }))).rejects.toThrow(
      "cannot confirm the password it filled is gone",
    );
  });
});

it.live("lifts the fence once the filled field no longer holds the value", () => {
  const { tab, field } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record);
    await expect(fill.guard(tab, request("snapshot", {}))).rejects.toThrow("holds a password");
    await fill.guard(tab, request("snapshot", { captureImage: false }));
    field.value = "";
    await fill.guard(tab, request("evaluate", { expression: "1" }));
  });
});

it.live("a Stop that lands while the ref is consumed leaves the field empty", () => {
  const { tab, field } = makeTab();
  return withFill(
    async (fill, state) => {
      await expect(fill.fill(tab, fillRequest, later(), record)).rejects.toThrow("used up");
      expect(state.consumed).toBe(1);
      expect(field.value).toBe("");
    },
    () => tab.control.stopAgents(),
  );
});

it.live("an expired deadline or a starting recording refuses before the ref is used", () => {
  const { tab, field } = makeTab();
  return withFill(async (fill, state) => {
    await expect(fill.fill(tab, fillRequest, expired, record)).rejects.toThrow();
    tab.recordingStart = Promise.withResolvers<void>().promise;
    await expect(fill.fill(tab, fillRequest, later(), record)).rejects.toThrow("recording");
    expect(state.consumed).toBe(0);
    expect(field.value).toBe("");
  });
});

it.live("masks filled values in every answer, keys included only for page-made JSON", () => {
  const { tab } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record);
    const outcome = (operation: PreviewAutomationRequest["operation"], result: unknown) =>
      fill.mask(request(operation, {}))({ ok: true, result });
    expect(outcome("evaluate", { [PASSWORD]: PASSWORD })).toEqual({
      ok: true,
      result: { "[secret]": "[secret]" },
    });
    expect(outcome("scrollCollect", { items: [{ [PASSWORD]: true }], rounds: 1 })).toEqual({
      ok: true,
      result: { items: [{ "[secret]": true }], rounds: 1 },
    });
    expect(
      outcome("logs", { network: { entries: [{ method: PASSWORD, url: "https://x/" }] } }),
    ).toEqual({
      ok: true,
      result: { network: { entries: [{ method: "[secret]", url: "https://x/" }] } },
    });
    const data = `iVBOR${PASSWORD}`;
    expect(
      outcome("snapshot", { title: PASSWORD, screenshot: { mimeType: "image/png", data } }),
    ).toEqual({
      ok: true,
      result: { title: "[secret]", screenshot: { mimeType: "image/png", data } },
    });
    expect(
      fill.mask(request("status", {}))({
        ok: false,
        error: { _tag: "X", message: `said ${PASSWORD}` },
      }),
    ).toEqual({ ok: false, error: { _tag: "X", message: "said [secret]" } });
  });
});

it.live("masks a filled value in the escaped and URL-encoded forms a page echoes it in", () => {
  const { tab } = makeTab();
  const password = 'p@ss "w0rd"\\ ä&+=';
  return withFill(
    async (fill) => {
      await fill.fill(tab, fillRequest, later(), record);
      const echoed = [
        JSON.stringify({ password }),
        `password=${encodeURIComponent(password)}`,
        new URLSearchParams({ password }).toString(),
      ].join("\n");
      const outcome = fill.mask(request("fetch", {}))({ ok: true, result: { text: echoed } });
      expect(outcome).toEqual({
        ok: true,
        result: {
          text: ['{"password":"[secret]"}', "password=[secret]", "password=[secret]"].join("\n"),
        },
      });
    },
    undefined,
    [password],
  );
});

it.live("masks lowercase percent escapes, overlapping values and a value no URL can encode", () => {
  const { tab } = makeTab();
  const first = "very-private-prefix%2";
  const second = "&cdefghijklmnopqrstuvwxyz";
  const unpaired = "pw\uD800abc";
  // Hex digits right after a value's end or start must not hide it by looking like an escape.
  const trailingPercent = "long-password%a";
  const hexStart = "aBcdefgh123";
  // Playwright's snapshot writes control characters as \xNN.
  const control = "long\u0001password";
  // Playwright's snapshot drops zero-width characters and collapses whitespace.
  const spaced = "word  with\u200bspaces";
  return withFill(
    async (fill) => {
      for (let i = 0; i < 7; i++) await fill.fill(tab, fillRequest, later(), record);
      const text = [
        `${first}6cdefghijklmnopqrstuvwxyz`,
        encodeURIComponent(second).toLowerCase(),
        unpaired,
        `${trailingPercent}b`,
        `%2${hexStart}`,
        String.raw`- textbox: "long\x01password"`,
        "- text: word withspaces",
      ].join("\n");
      const outcome = fill.mask(request("fetch", {}))({ ok: true, result: { text } });
      expect(outcome).toEqual({
        ok: true,
        result: {
          text: '[secret]\n[secret]\n[secret]\n[secret]b\n%2[secret]\n- textbox: "[secret]"\n- text: [secret]',
        },
      });
    },
    undefined,
    [first, second, unpaired, trailingPercent, hexStart, control, spaced],
  );
});

it.live("masks the start of a filled value that a cut fetch answer ends on", () => {
  const { tab } = makeTab();
  return withFill(
    async (fill) => {
      await fill.fill(tab, fillRequest, later(), record);
      const fetched = (text: string, truncated: boolean) =>
        fill.mask(request("fetch", {}))({ ok: true, result: { text, truncated } });
      expect(fetched("echo alpha ", true)).toEqual({
        ok: true,
        result: { text: "echo [secret]", truncated: true },
      });
      // An answer that was not cut ends where the page's text ends.
      expect(fetched("echo alpha ", false)).toEqual({
        ok: true,
        result: { text: "echo alpha ", truncated: false },
      });
    },
    undefined,
    ["alpha beta gamma"],
  );
});

it.live("masks a very long filled value without failing the answer", () => {
  const { tab } = makeTab();
  const long = "a".repeat(40_000);
  return withFill(
    async (fill) => {
      await fill.fill(tab, fillRequest, later(), record);
      const text = `${"a".repeat(100_000)} tail`;
      expect(fill.mask(request("fetch", {}))({ ok: true, result: { text } })).toEqual({
        ok: true,
        result: { text: "[secret] tail" },
      });
    },
    undefined,
    [long],
  );
});

it.live("keeps the fence while an edited filled field still holds part of the value", () => {
  const { tab, field } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record);
    field.value = PASSWORD.slice(0, -1);
    await expect(fill.guard(tab, request("evaluate", { expression: "1" }))).rejects.toThrow(
      "holds a password GOAT filled",
    );
    // A password input still shows dots, so a text snapshot cannot read the edited value.
    await fill.guard(tab, request("snapshot", { captureImage: false }));
    field.type = "text";
    await expect(fill.guard(tab, request("snapshot", { captureImage: false }))).rejects.toThrow(
      "shows a password GOAT filled as plain text",
    );
    field.value = "";
    await fill.guard(tab, request("evaluate", { expression: "1" }));
    // Revealed with its value unchanged, the field still shows the password as plain text.
    field.value = PASSWORD;
    await expect(fill.guard(tab, request("snapshot", { captureImage: false }))).rejects.toThrow(
      "shows a password GOAT filled as plain text",
    );
    field.value = "";
    // A page that puts the value back is fenced again, even after a check found the field empty.
    await fill.guard(tab, request("snapshot", { captureImage: false }));
    field.type = "password";
    field.value = PASSWORD;
    await expect(fill.guard(tab, request("evaluate", { expression: "1" }))).rejects.toThrow(
      "holds a password GOAT filled",
    );
    // Detached and put back, revealed and edited, the same node is fenced again.
    field.isConnected = false;
    await fill.guard(tab, request("snapshot", { captureImage: false }));
    field.isConnected = true;
    field.type = "text";
    field.value = PASSWORD.slice(0, -1);
    await expect(fill.guard(tab, request("snapshot", { captureImage: false }))).rejects.toThrow(
      "shows a password GOAT filled as plain text",
    );
  });
});
