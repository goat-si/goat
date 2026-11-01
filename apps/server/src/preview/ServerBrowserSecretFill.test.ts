import { makeActionChannel } from "./actionChannel.ts";
import { it } from "@effect/vitest";
import {
  SecretRef,
  SecretRequestError,
  ThreadId,
  type PreviewAutomationRequest,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CDPSession, Page } from "playwright-core";
import { expect } from "vite-plus/test";

import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerBrowserSecretFill from "./ServerBrowserSecretFill.ts";
import { BrowserControlInterrupted, SessionControl } from "./SessionControl.ts";

const threadId = ThreadId.make("secret-fill-unit");
const otherThread = ThreadId.make("secret-fill-unit-other");
const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
const PASSWORD = "pw_unit_secret_value";

/** One password field behind a scripted CDP session; faults are injected per method. */
const makeTab = (
  faults: {
    readonly fillReply?: boolean;
    readonly fillThrew?: boolean;
    readonly fillRefused?: boolean;
    readonly stillFilled?: boolean;
    readonly notPassword?: boolean;
    readonly origin?: string;
  } = {},
  /** Tabs of one profile share their browser context, and so their sign-ins. */
  context: object = {},
) => {
  const field = { value: "", type: "password", isConnected: true };
  const closes: Array<() => void> = [];
  let sessionClosed = false;
  const page = {
    on: () => page,
    url: () => "https://login.test/",
    frames: () => [page],
    mainFrame: () => page,
    context: () => context,
    isClosed: () => false,
  } as unknown as Page;
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
    if (method === "Runtime.releaseObject") return {};
    if (method === "DOM.describeNode") return { node: { nodeName: "INPUT" } };
    const fn = String(params?.functionDeclaration);
    const args = (params?.arguments ?? []) as Array<{ readonly value: unknown }>;
    if (fn.startsWith("function () {\n  let element = document.activeElement;"))
      return { result: { subtype: "node", objectId: "field" } };
    if (fn.includes("querySelectorAll(selector)"))
      return { result: { subtype: "node", objectId: "field" } };
    if (fn.includes("self.origin : null"))
      return {
        result: { value: faults.notPassword ? null : (faults.origin ?? "https://login.test") },
      };
    if (fn.includes("HTMLInputElement.prototype")) {
      if (faults.fillRefused) return { result: { value: false } };
      field.value = String(args[0]?.value);
      // The page's input listener threw after the value was set.
      if (faults.fillThrew)
        return { result: { type: "object" }, exceptionDetails: { text: "Uncaught" } };
      if (faults.fillReply) throw new Error("Target closed");
      return { result: { value: true } };
    }
    // The field has no identifier beside it.
    if (fn.includes("DOCUMENT_POSITION_FOLLOWING")) return { result: { value: null } };
    if (fn.includes('return "empty"')) {
      if (sessionClosed) throw new Error("Target page, context or browser has been closed");
      if (faults.stillFilled) throw new Error("Session closed");
      // Runs the page-side check against the scripted field.
      const check = new Function(`return (${fn});`)() as (this: object, value: unknown) => unknown;
      return { result: { value: check.call({ ...field }, args[0]?.value) } };
    }
    throw new Error(`unexpected ${method}`);
  };
  const tab = {
    page,
    cdp: {
      send,
      on: (event: string, listener: () => void) => event === "close" && closes.push(listener),
    } as unknown as CDPSession,
    frameSessions: new Map(),
    control: new SessionControl("agent-a"),
    recording: null as unknown,
    recordingStart: null as unknown,
  };
  /** The frame's session goes away, as an out-of-process frame's does when it detaches. */
  const closeSession = () => {
    sessionClosed = true;
    for (const listener of closes) listener();
  };
  return { tab, field, closeSession };
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
const checkBlocked = Object.assign(async () => {}, {
  isFenced: () => false,
  blockedFrame: () => false,
});

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
              : Effect.fail(
                  new SecretRequestError({
                    reason:
                      input.origin === "https://login.test" ? "ref_unavailable" : "origin_mismatch",
                  }),
                ),
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
    const uncertain = await fill
      .fill(tab, fillRequest, later(), record, checkBlocked)
      .catch((cause) => cause);
    expect(String(uncertain.message)).toContain("could not confirm whether the password was typed");
    // It may have typed, so it does not say nothing was sent.
    expect(uncertain.detail).toBeUndefined();
    expect(field.value).toBe(PASSWORD);
    await expect(fill.guard(tab, request("evaluate", { expression: "1" }))).rejects.toThrow(
      "holds a password GOAT filled",
    );
  });
});

it.live("keeps the pixels of a tab off after a lost fill reply, once its field lets go", () => {
  const { tab, closeSession } = makeTab({ fillReply: true });
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record, checkBlocked).catch(() => undefined);
    closeSession();
    await fill.guard(tab, request("evaluate", { expression: "1" }));
    await expect(fill.guard(tab, request("snapshot", { captureImage: true }))).rejects.toThrow(
      "image snapshots and recordings of it stay off",
    );
  });
});

it.live("fills nothing while another tab sharing its sign-ins is recording", () => {
  const shared = {};
  const { tab, field } = makeTab({}, shared);
  const { tab: recorder } = makeTab({}, shared);
  return withFill(async (fill) => {
    // The recording tab was acted on, as starting its recording is.
    await fill.guard(recorder, request("status", {}));
    recorder.recording = {};
    const refused = await fill
      .fill(tab, fillRequest, later(), record, checkBlocked)
      .catch((cause) => cause);
    expect(String(refused.message)).toContain("is recording");
    expect(field.value).toBe("");
  });
});

it.live("keeps the pixels of another thread's tab of the same profile off on a filled site", () => {
  const shared = {};
  const { tab } = makeTab({}, shared);
  const { tab: other } = makeTab({}, shared);
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
    const elsewhere = { ...request("snapshot", { captureImage: true }), threadId: otherThread };
    await expect(fill.guard(other, elsewhere)).rejects.toThrow("stay off");
  });
});

it.live(
  "masks a password another thread filled in every answer of a tab sharing its sign-ins",
  () => {
    const shared = {};
    const { tab } = makeTab({}, shared);
    const { tab: other } = makeTab({}, shared);
    return withFill(async (fill) => {
      await fill.fill(tab, fillRequest, later(), record, checkBlocked);
      // The site copied the password into storage the other thread's tab reads back.
      const read = { ...request("read", {}), threadId: otherThread };
      await fill.guard(other, read);
      const answer = fill.mask(read)({ ok: true, result: { text: "stored " + PASSWORD } });
      expect(JSON.stringify(answer)).not.toContain(PASSWORD);
      expect(fill.maskText(otherThread)("stored " + PASSWORD)).not.toContain(PASSWORD);
    });
  },
);

it.live(
  "refuses script in a tab while another tab sharing its sign-ins holds a filled password",
  () => {
    const shared = {};
    const { tab } = makeTab({}, shared);
    const { tab: other } = makeTab({}, shared);
    return withFill(async (fill) => {
      await fill.fill(tab, fillRequest, later(), record, checkBlocked);
      const script = { ...request("evaluate", { expression: "1" }), threadId: otherThread };
      await expect(fill.guard(other, script)).rejects.toThrow("shares this tab's sign-ins holds");
    });
  },
);

it.live(
  "refuses a recording that starts beside a fill under way, before the fill marks the site",
  () => {
    const shared = {};
    const { tab } = makeTab({}, shared);
    const { tab: recorder } = makeTab({}, shared);
    let during = () => {};
    return withFill(
      async (fill) => {
        await fill.guard(recorder, { ...request("status", {}), threadId: otherThread });
        let starting: Promise<void> | undefined;
        let pixels: unknown;
        during = () => {
          starting = fill.guard(recorder, {
            ...request("recordingStart", {}),
            threadId: otherThread,
          });
          try {
            fill.assertPixels(recorder, otherThread);
          } catch (cause) {
            pixels = cause;
          }
        };
        await fill.fill(tab, fillRequest, later(), record, checkBlocked);
        expect(String((pixels as Error | undefined)?.message)).toContain("is filling a password");
        await expect(starting).rejects.toThrow("shares this tab's sign-ins");
      },
      () => during(),
    );
  },
);

it.live("lifts the fence of a field whose frame session closed with its document", () => {
  const { tab, closeSession } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
    await expect(fill.guard(tab, request("evaluate", { expression: "1" }))).rejects.toThrow(
      "holds a password GOAT filled",
    );
    closeSession();
    await fill.guard(tab, request("evaluate", { expression: "1" }));
  });
});

it.live("an exception after the value was set may have typed it, so the fence stays", () => {
  const { tab, field } = makeTab({ fillThrew: true });
  return withFill(async (fill) => {
    const uncertain = await fill
      .fill(tab, fillRequest, later(), record, checkBlocked)
      .catch((cause) => cause);
    expect(String(uncertain.message)).toContain("could not confirm whether the password was typed");
    expect(uncertain.detail).toBeUndefined();
    expect(field.value).toBe(PASSWORD);
    await expect(fill.guard(tab, request("evaluate", { expression: "1" }))).rejects.toThrow(
      "holds a password GOAT filled",
    );
  });
});

it.live("a field the fill refused before setting it says nothing was typed", () => {
  const { tab, field } = makeTab({ fillRefused: true });
  return withFill(async (fill) => {
    const usedUp = await fill
      .fill(tab, fillRequest, later(), record, checkBlocked)
      .catch((cause) => cause);
    expect(String(usedUp.message)).toContain("Nothing was filled");
    expect(usedUp.detail).toEqual({ beforeInput: true });
    expect(field.value).toBe("");
    await fill.guard(tab, request("evaluate", { expression: "1" }));
  });
});

it.live("keeps the fence when GOAT cannot check the filled field", () => {
  const { tab } = makeTab({ stillFilled: true });
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
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
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
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
      const usedUp = await fill
        .fill(tab, fillRequest, later(), record, checkBlocked)
        .catch((cause) => cause);
      expect(String(usedUp.message)).toContain("used up");
      expect(usedUp.detail).toEqual({ beforeInput: true });
      expect(state.consumed).toBe(1);
      expect(field.value).toBe("");
    },
    () => tab.control.stopAgents(),
  );
});

it.live("an expired deadline or a starting recording refuses before the ref is used", () => {
  const { tab, field } = makeTab();
  return withFill(async (fill, state) => {
    await expect(fill.fill(tab, fillRequest, expired, record, checkBlocked)).rejects.toThrow();
    tab.recordingStart = Promise.withResolvers<void>().promise;
    await expect(fill.fill(tab, fillRequest, later(), record, checkBlocked)).rejects.toThrow(
      "recording",
    );
    expect(state.consumed).toBe(0);
    expect(field.value).toBe("");
  });
});

it.live("masks filled values in every answer, keys included only for page-made JSON", () => {
  const { tab } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
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
    const denied = fill.mask(request("evaluate", {}))({
      ok: false,
      error: { _tag: "X", message: `failed ${PASSWORD}`, detail: { text: PASSWORD } },
    });
    expect(JSON.stringify(denied)).not.toContain(PASSWORD);
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
      await fill.fill(tab, fillRequest, later(), record, checkBlocked);
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
  // A fetch collapses whitespace but keeps zero-width characters.
  const fetchSpaced = "alpha  beta\u200bgamma";
  return withFill(
    async (fill) => {
      for (let i = 0; i < 8; i++) await fill.fill(tab, fillRequest, later(), record, checkBlocked);
      const text = [
        `${first}6cdefghijklmnopqrstuvwxyz`,
        encodeURIComponent(second).toLowerCase(),
        unpaired,
        `${trailingPercent}b`,
        `%2${hexStart}`,
        String.raw`- textbox: "long\x01password"`,
        "- text: word withspaces",
        "alpha beta\u200bgamma",
      ].join("\n");
      const outcome = fill.mask(request("fetch", {}))({ ok: true, result: { text } });
      expect(outcome).toEqual({
        ok: true,
        result: {
          text: '[secret]\n[secret]\n[secret]\n[secret]b\n%2[secret]\n- textbox: "[secret]"\n- text: [secret]\n[secret]',
        },
      });
    },
    undefined,
    [first, second, unpaired, trailingPercent, hexStart, control, spaced, fetchSpaced],
  );
});

it.live("masks the start of a filled value that a cut fetch answer ends on", () => {
  const { tab } = makeTab();
  return withFill(
    async (fill) => {
      await fill.fill(tab, fillRequest, later(), record, checkBlocked);
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

it.live("masks a filled value a fetch rendered without its brackets, end spaces or raw URL", () => {
  const { tab } = makeTab();
  return withFill(
    async (fill) => {
      for (let i = 0; i < 3; i++) await fill.fill(tab, fillRequest, later(), record, checkBlocked);
      // A link label loses its brackets, a pre block its end spaces, an href is URL-encoded.
      const text = ["link alphabetagamma", "alt alpha  beta", "href /p/alpha%28beta%29%20gamma"];
      const outcome = fill.mask(request("fetch", {}))({
        ok: true,
        result: { text: text.join("\n") },
      });
      expect(outcome).toEqual({
        ok: true,
        result: { text: ["link [secret]", "alt [secret]", "href /p/[secret]"].join("\n") },
      });
    },
    undefined,
    ["alpha[beta]gamma", "alpha  beta ", "alpha(beta) gamma"],
  );
});

it.live("masks a link label whose dropped brackets join escapes, symbols or a cut", () => {
  const { tab } = makeTab();
  return withFill(
    async (fill) => {
      for (let i = 0; i < 5; i++) await fill.fill(tab, fillRequest, later(), record, checkBlocked);
      const fetched = (text: string, truncated: boolean) =>
        fill.mask(request("fetch", {}))({ ok: true, result: { text, truncated } });
      const labels = [
        "[alpha%41beta](https://x/)",
        "[!@#7$%(8)&*9](https://x/)",
        "[continue](https://x/alpha%FF%20beta)",
        "[next](https://x/p/m7Q/n8Rv9)",
        "ordinary prose",
      ];
      expect(fetched(labels.join("\n"), false)).toEqual({
        ok: true,
        result: {
          text: [
            "[[secret]](https://x/)",
            "[[secret]](https://x/)",
            "[continue](https://x/[secret])",
            "[next](https://x/p/[secret])",
            "ordinary prose",
          ].join("\n"),
          truncated: false,
        },
      });
      expect(fetched("see [alphabetag", true)).toEqual({
        ok: true,
        result: { text: "see [[secret]", truncated: true },
      });
    },
    undefined,
    ["alpha%[41]beta", "!@#[7]$%(8)&*9", "alpha[beta]gamma", "alpha%FF beta", "m7Q\\n8Rv9"],
  );
});

it.live(
  "leaves refs and GOAT's own fields alone when only a short skeleton or a field matches",
  () => {
    const { tab } = makeTab();
    return withFill(
      async (fill) => {
        for (let i = 0; i < 2; i++)
          await fill.fill(tab, fillRequest, later(), record, checkBlocked);
        // "[ ] / e1" drops to "e1", too short to compare that way: refs stay.
        const tree = '- button "Go" [ref=e1]';
        expect(
          fill.mask(request("snapshot", {}))({ ok: true, result: { accessibilityTree: tree } }),
        ).toEqual({
          ok: true,
          result: { accessibilityTree: tree },
        });
        expect(
          fill.mask(request("status", {}))({
            ok: true,
            result: { status: "ready-for-input", text: "page says ready-for-input" },
          }),
        ).toEqual({ ok: true, result: { status: "ready-for-input", text: "page says [secret]" } });
      },
      undefined,
      ["[ ] / e1", "ready-for-input"],
    );
  },
);

it.live("masks a long page text only up to a little past the caller's cut", () => {
  const { tab } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
    // The value straddles the cut at 100, in a text far longer than anything scanned.
    const text = `${"a ".repeat(45)}${PASSWORD}${"z".repeat(1_000_000)}`;
    const masked = fill.maskText(threadId)(text, 100);
    expect(masked.length).toBeLessThan(1_000);
    expect(masked.slice(0, 100)).toBe(`${"a ".repeat(45)}[secret]zz`);
  });
});

it.live("masks a very long filled value without failing the answer", () => {
  const { tab } = makeTab();
  const long = "a".repeat(40_000);
  return withFill(
    async (fill) => {
      await fill.fill(tab, fillRequest, later(), record, checkBlocked);
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
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
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
it.live("masks a password filled after another thread's read began, in that read's answer", () => {
  const shared = {};
  const { tab } = makeTab({}, shared);
  const { tab: other } = makeTab({}, shared);
  return withFill(async (fill) => {
    const read = { ...request("signInState", {}), threadId: otherThread };
    await fill.guard(other, read);
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
    const answer = fill.mask(read)({ ok: true, result: { validation: ["shown " + PASSWORD] } });
    expect(JSON.stringify(answer)).not.toContain(PASSWORD);
  });
});

it.live(
  "masks a tab's own records with a password another thread fills in its context later",
  () => {
    const shared = {};
    const { tab } = makeTab({}, shared);
    const { tab: other } = makeTab({}, shared);
    return withFill(async (fill) => {
      const records = fill.maskText(otherThread, other.page);
      await fill.fill(tab, fillRequest, later(), record, checkBlocked);
      // The console cut sits right inside the password.
      const logged = records("x".repeat(1990) + PASSWORD, 2000).slice(0, 2000);
      expect(logged).not.toContain(PASSWORD.slice(0, 4));
    });
  },
);

it.live("drops an image a tab sharing sign-ins took while a password was filled", () => {
  const shared = {};
  const { tab } = makeTab({}, shared);
  const { tab: other } = makeTab({}, shared);
  return withFill(async (fill) => {
    const picture = { ...request("snapshot", { captureImage: true }), threadId: otherThread };
    await fill.guard(other, picture);
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
    const answer = fill.mask(picture)({ ok: true, result: { screenshot: { data: "image" } } });
    expect(answer.ok).toBe(false);
  });
});

it.effect("refuses a blocked password destination before consuming or filling", () => {
  const { tab, field } = makeTab();
  return withFill(async (fill, state) => {
    const result = await fill
      .fill(
        tab,
        fillRequest,
        later(),
        record,
        Object.assign(
          async (destination?: string) => {
            if (destination === "https://login.test")
              throw new BrowserControlInterrupted("blocked", "blocked_url");
          },
          { isFenced: () => false, blockedFrame: () => false },
        ),
      )
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ reason: "blocked_url" });
    expect(state.consumed).toBe(0);
    expect(field.value).toBe("");
  });
});

it.effect("a blocked cut while resolving a secret target stops further CDP commands", () =>
  Effect.gen(function* () {
    const { tab, field } = makeTab();
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const latch = Promise.withResolvers<void>();
    const methods: Array<string> = [];
    const original = tab.cdp.send.bind(tab.cdp);
    const delayed = new Proxy(tab.cdp, {
      get(target, property, receiver) {
        if (property !== "send") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof tab.cdp.send>) => {
          methods.push(String(args[0]));
          const reply = await Reflect.apply(original, target, args);
          if (args[0] === "Page.getFrameTree") {
            Deferred.doneUnsafe(entered, Effect.void);
            await latch.promise;
          }
          return reply;
        };
      },
    });
    tab.cdp = delayed;
    yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Deferred.await(entered);
        tab.control.cutBlockedUrl();
        yield* Deferred.succeed(resume, undefined);
        latch.resolve();
      }),
    );
    yield* withFill(async (fill) => {
      const error = await fill.fill(tab, fillRequest, later(), record, checkBlocked).then(
        () => null,
        (cause: unknown) => cause,
      );
      expect(methods).toEqual(["Page.getFrameTree"]);
      expect(error).toMatchObject({ reason: "blocked_url" });
      expect(field.value).toBe("");
    });
  }),
);
it.live("never permits history text retention on a secret-fill target", () => {
  const { tab } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, fillRequest, later(), record, checkBlocked);
    const channel = makeActionChannel({
      cdp: tab.cdp,
      page: tab.page,
      signal: new AbortController().signal,
      controlGeneration: () => {},
      isFenced: () => false,
      blockedFrame: () => false,
    });
    expect(await fill.historyField(tab, threadId, channel)).toBeUndefined();
    expect(fill.historySafe(tab, threadId)).toBe(false);
  });
});

it.live("a focused non-password field refuses before consuming or typing the secret", () => {
  const { tab, field } = makeTab({ notPassword: true });
  return withFill(async (fill, state) => {
    const error = await fill
      .fill(tab, request("fillSecret", { secretRef: ref }), later(), record, checkBlocked)
      .catch((cause) => cause);
    expect(error.detail).toEqual({ beforeInput: true });
    expect(field.value).toBe("");
    expect(state.consumed).toBe(0);
  });
});

it.live("a focused password at a different origin refuses without typing", () => {
  const { tab, field } = makeTab({ origin: "https://other.test" });
  return withFill(async (fill, state) => {
    const error = await fill
      .fill(tab, request("fillSecret", { secretRef: ref }), later(), record, checkBlocked)
      .catch((cause) => cause);
    expect(error.detail).toEqual({ beforeInput: true, secretFailure: "not_permitted" });
    expect(field.value).toBe("");
    expect(state.consumed).toBe(0);
  });
});

it.live("fills the focused password using its origin-bound reference", () => {
  const { tab, field } = makeTab();
  return withFill(async (fill) => {
    await fill.fill(tab, request("fillSecret", { secretRef: ref }), later(), record, checkBlocked);
    expect(field.value).toBe(PASSWORD);
  });
});
