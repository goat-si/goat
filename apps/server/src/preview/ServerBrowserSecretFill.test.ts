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
  const field = { value: "", type: "password" };
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
    if (fn.includes("this.value === value")) {
      if (faults.stillFilled) throw new Error("Session closed");
      // Runs the page-side check against the scripted field.
      const check = new Function(`return (${fn});`)() as (this: object, value: unknown) => unknown;
      return { result: { value: check.call({ isConnected: true, ...field }, args[0]?.value) } };
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
  password = PASSWORD,
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
            input.origin === "https://login.test" && state.consumed === 0
              ? Effect.sync(() => {
                  state.consumed += 1;
                  return password;
                })
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
    password,
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
  });
});
