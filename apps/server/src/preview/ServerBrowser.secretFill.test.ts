// @effect-diagnostics nodeBuiltinImport:off - one-time dummy passwords come from node:crypto.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  SecretRef,
  SecretRequestError,
  ThreadId,
  type PreviewAutomationFillSecretResult,
  type PreviewAutomationRead,
  type PreviewAutomationSignInState,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, describe, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { unusedPreviewBrowser } from "./PreviewBrowser.testkit.ts";
import { chromiumInstalled } from "./PreviewChromium.fixture.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import { playwrightDebugLogging } from "./ServerBrowserSecretFill.ts";

const PAGES: Record<string, string> = {
  "https://login.test/": [
    "<title>Sign in</title>",
    '<input id="user" aria-label="Email"><input id="pw" type="password" aria-label="Password">',
    '<p id="echo"></p>',
    "<script>document.getElementById('pw').addEventListener('input', (event) => {",
    "  console.log('typed ' + event.target.value);",
    "  document.getElementById('echo').textContent = 'you typed ' + event.target.value;",
    "});</script>",
  ].join(""),
  "https://login.test/focus": '<title>Focus</title><input id="pw" type="password">',
  "https://login.test/framed":
    '<title>Framed</title><iframe id="auth" src="https://auth.test/frame"></iframe>' +
    '<iframe id="sandboxed" sandbox="allow-scripts" src="https://auth.test/frame"></iframe>',
  "https://auth.test/frame": '<input id="pw" type="password" aria-label="Password">',
  "https://other.test/": '<title>Other</title><input id="pw" type="password">',
  "https://login.test/next": "<title>Next</title><p>Signed in</p>",
  "https://login.test/form": [
    "<title>Sign in</title>",
    '<form method="post" action="https://login.test/welcome">',
    '<input id="user" name="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" name="pw" type="password"><button id="go">Sign in</button></form>',
    "<script>document.getElementById('pw').addEventListener('input', (event) =>",
    "  localStorage.setItem('typed', event.target.value));</script>",
  ].join(""),
  "https://login.test/mention": [
    "<p>Welcome back jun@example.com</p><form>",
    '<input id="user" autocomplete="username" value="wrong@example.com">',
    '<input id="pw" type="password"></form>',
  ].join(""),
  "https://login.test/echo-error": [
    '<form><input id="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" type="password"><p role="alert" id="err"></p></form>',
    "<script>document.getElementById('pw').addEventListener('input', (event) => {",
    "  document.getElementById('err').textContent = 'x'.repeat(195) + event.target.value;",
    "});</script>",
  ].join(""),
  "https://login.test/form-denied": [
    '<form method="post" action="https://login.test/denied">',
    '<input id="user" name="user" autocomplete="username" value="jun@example.com">',
    '<input id="pw" name="pw" type="password"><button id="go">Sign in</button></form>',
  ].join(""),
  "https://login.test/denied":
    '<title>Denied</title><p role="alert">That password is not right for jun@example.com.</p>',
  "https://login.test/blank-user":
    '<form><input id="user" autocomplete="username"><input id="pw" type="password"></form>',
  "https://login.test/welcome": [
    "<title>Welcome</title><p>Signed in as jun@example.com</p><canvas id='c'></canvas>",
    "<script>const c = document.getElementById('c').getContext('2d');",
    "c.fillText(localStorage.getItem('typed') || '', 10, 10);</script>",
  ].join(""),
  "https://login.test/two":
    '<title>Two</title><input id="pw" type="password"><input id="pw2" type="password">',
};

let browser: Promise<Browser> | undefined;
const contexts: Array<BrowserContext> = [];

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    async contextFor() {
      browser ??= chromium.launch({ headless: true });
      const context = await (await browser).newContext();
      await context.route("**/*", (route) =>
        route.fulfill({ contentType: "text/html", body: PAGES[route.request().url()] ?? "" }),
      );
      contexts.push(context);
      return context;
    }
    async close() {
      for (const context of contexts.splice(0)) await context.close().catch(() => {});
      // An open Chromium keeps the test worker alive, so each layer's close ends it.
      const launched = browser;
      browser = undefined;
      await (await launched)?.close().catch(() => {});
    }
  },
}));

const threadId = ThreadId.make("secret-fill-thread");
const scope = {
  environmentId: EnvironmentId.make("secret-fill-env"),
  thread: {
    threadId,
    providerSessionId: "agent-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "secret-fill-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

/** A one-use store with the real service's origin rule; refusals leave the value in place. */
const makeSecrets = (beforeConsume: () => Promise<unknown> = async () => {}) => {
  const saved = new Map<string, { readonly origin: string; readonly value: string }>();
  const consumed: Array<string> = [];
  const save = (origin: string) => {
    const ref = SecretRef.make(`secret-ref:${NodeCrypto.randomBytes(16).toString("hex")}`);
    const value = `pw_${NodeCrypto.randomUUID()}`;
    saved.set(ref, { origin, value });
    return { ref, value };
  };
  const unused = () => Effect.die("unused in these tests");
  const service = SecretRequests.SecretRequests.of({
    answer: unused,
    savedRef: unused,
    consume: unused,
    saveToFile: unused,
    consumeForOrigin: (input) =>
      Effect.promise(beforeConsume).pipe(
        Effect.andThen(() => {
          const entry = saved.get(input.ref);
          if (entry === undefined)
            return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
          if (entry.origin !== input.origin)
            return Effect.fail(new SecretRequestError({ reason: "origin_mismatch" }));
          saved.delete(input.ref);
          consumed.push(input.ref);
          return Effect.succeed(entry.value);
        }),
      ),
  });
  return { save, saved, consumed, layer: Layer.succeed(SecretRequests.SecretRequests, service) };
};

const layerFor = (secrets: ReturnType<typeof makeSecrets>) =>
  ServerBrowser.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Manager.layer,
        Broker.layer,
        secrets.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(scope.environmentId),
          getDescriptor: Effect.die("unused descriptor"),
        }),
        Layer.succeed(PreviewBrowser.PreviewBrowser, unusedPreviewBrowser),
        Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
          available: false,
          awaitAttached: () => Effect.succeed(false),
          detached: Stream.empty,
          attached: Stream.empty,
          isAttached: () => Effect.succeed(false),
          endpoint: () => Effect.die("unused endpoint"),
          pointer: () => Effect.void,
          turn: () => Effect.void,
        }),
        PreviewAgentActivity.layer,
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "goat-secret-fill-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const harness = Effect.gen(function* () {
  const service = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const open = Effect.fn("test.open")(function* (url: string) {
    const opened = yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "open",
      input: { url, reuseExistingTab: false, show: false },
    });
    const tabId = PreviewTabId.make(opened.tabId!);
    const page = contexts.at(-1)!.pages()[0]!;
    return { tabId, page };
  });
  const call = <A>(
    tabId: PreviewTabId,
    operation: Broker.PreviewAutomationInvokeInput["operation"],
    input: unknown,
  ) => broker.invoke<A>({ scope, tabId, operation, input });
  const fill = (tabId: PreviewTabId, input: object) =>
    call<PreviewAutomationFillSecretResult>(tabId, "fillSecret", input);
  /** Waits for the session list to report the tab's privacy, driven by its change signal. */
  const privacy = (tabId: PreviewTabId, on: boolean) =>
    Stream.merge(Stream.succeed(undefined), service.sessionChanges).pipe(
      Stream.mapEffect(() => service.sessions),
      Stream.filter((views) => views.some((view) => view.tabId === tabId && view.private === on)),
      Stream.runHead,
    );
  return { service, open, call, fill, privacy };
});

const fieldValue = (page: Page, frame = page.mainFrame()) => frame.locator("#pw").inputValue();

// A test that times out never reaches its layer's close; this still ends Chromium.
afterAll(async () => {
  await (await browser)?.close().catch(() => {});
});

describe.skipIf(!chromiumInstalled)("goat_preview_fill_secret in a real server browser", () => {
  it.live("fills a password on its origin while the agent's answers never carry it", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, call, fill } = yield* harness;
        const { tabId, page } = yield* open("https://login.test/");
        const { ref, value } = secrets.save("https://login.test");

        const result = yield* fill(tabId, { secretRef: ref, selector: "#pw" });
        expect(result).toEqual({
          filled: true,
          origin: "https://login.test",
          privateMode: false,
          account: "unverified",
        });
        expect(yield* Effect.promise(() => fieldValue(page))).toBe(value);
        expect(secrets.consumed).toEqual([ref]);

        // The page echoes the value into its text and console; GOAT's answers mask both.
        const snapshot = yield* call<PreviewAutomationSnapshot>(tabId, "snapshot", {
          captureImage: false,
        });
        const logs = yield* call<object>(tabId, "logs", {});
        for (const answer of [snapshot, logs, result])
          expect(JSON.stringify(answer)).not.toContain(value);
        expect(snapshot.visibleText).toContain("you typed ");
        expect(JSON.stringify(logs)).toContain("typed [secret]");

        // While the field holds it, the agent's own script and pixels are refused.
        const evaluated = yield* call<object>(tabId, "evaluate", {
          expression: "document.querySelector('#pw').value",
        }).pipe(Effect.flip);
        expect(JSON.stringify(evaluated)).toContain("holds a password GOAT filled");
        const pictured = yield* call<object>(tabId, "snapshot", { captureImage: true }).pipe(
          Effect.flip,
        );
        expect(JSON.stringify(pictured)).toContain("holds a password GOAT filled");

        // After the page moves on, script runs again, and an exact echo is still masked.
        yield* call(tabId, "navigate", { url: "https://login.test/next" });
        const echoed = yield* call<unknown>(tabId, "evaluate", {
          expression: `({ ${JSON.stringify(value)}: ${JSON.stringify(value)} })`,
        });
        expect(JSON.stringify(echoed)).not.toContain(value);
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live("refuses another origin and a non-password target without using the ref", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, fill } = yield* harness;
        const other = yield* open("https://other.test/");
        const { ref, value } = secrets.save("https://login.test");

        const elsewhere = yield* fill(other.tabId, { secretRef: ref, selector: "#pw" }).pipe(
          Effect.flip,
        );
        expect(JSON.stringify(elsewhere)).toContain("for another site");
        expect(yield* Effect.promise(() => fieldValue(other.page))).toBe("");

        const login = yield* open("https://login.test/");
        const notPassword = yield* fill(login.tabId, { secretRef: ref, selector: "#user" }).pipe(
          Effect.flip,
        );
        expect(JSON.stringify(notPassword)).toContain("not an enabled password field");
        expect(secrets.saved.has(ref)).toBe(true);

        yield* fill(login.tabId, { secretRef: ref, selector: "#pw" });
        expect(yield* Effect.promise(() => fieldValue(login.page))).toBe(value);
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live(
    "fills the focused password field of a private tab and lets the tab leave private mode",
    () => {
      const secrets = makeSecrets();
      return Effect.scoped(
        Effect.gen(function* () {
          const { open, fill, privacy } = yield* harness;
          const { tabId, page } = yield* open("https://login.test/focus");
          // As a page's own focus would; headless autofocus differs across platforms.
          yield* Effect.promise(() => page.locator("#pw").focus());
          yield* privacy(tabId, true);
          const { ref, value } = secrets.save("https://login.test");

          const result = yield* fill(tabId, { secretRef: ref });
          expect(result).toMatchObject({ filled: true, origin: "https://login.test" });
          expect(yield* Effect.promise(() => fieldValue(page))).toBe(value);
          yield* privacy(tabId, false);
        }).pipe(Effect.provide(layerFor(secrets))),
      );
    },
  );

  it.live(
    "binds a focused field in a frame to that frame's origin and refuses a sandboxed one",
    () => {
      const secrets = makeSecrets();
      return Effect.scoped(
        Effect.gen(function* () {
          const { open, fill } = yield* harness;
          const { tabId, page } = yield* open("https://login.test/framed");
          const auth = page.frameLocator("#auth").locator("#pw");
          const sandboxed = page.frameLocator("#sandboxed").locator("#pw");
          const { ref, value } = secrets.save("https://auth.test");

          // A sandboxed frame keeps its https URL but has an opaque origin.
          yield* Effect.promise(() => sandboxed.focus());
          const opaque = yield* fill(tabId, { secretRef: ref }).pipe(Effect.flip);
          expect(JSON.stringify(opaque)).toContain("no web origin");
          expect(secrets.saved.has(ref)).toBe(true);

          yield* Effect.promise(() => auth.focus());
          const result = yield* fill(tabId, { secretRef: ref });
          expect(result.origin).toBe("https://auth.test");
          expect(yield* Effect.promise(() => auth.inputValue())).toBe(value);
          expect(yield* Effect.promise(() => sandboxed.inputValue())).toBe("");
        }).pipe(Effect.provide(layerFor(secrets))),
      );
    },
  );

  it.live("stays fenced until every field GOAT filled has let go of its password", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, call, fill } = yield* harness;
        const { tabId, page } = yield* open("https://login.test/two");
        const first = secrets.save("https://login.test");
        const second = secrets.save("https://login.test");
        yield* fill(tabId, { secretRef: first.ref, selector: "#pw" });
        yield* fill(tabId, { secretRef: second.ref, selector: "#pw2" });
        const evaluate = call<number>(tabId, "evaluate", { expression: "1 + 1" });

        // Cleared by page script, so no field takes focus and makes the tab private.
        const clear = (id: string) =>
          Effect.promise(() =>
            page.evaluate(`document.querySelector(${JSON.stringify(id)}).value = ""`),
          );
        yield* clear("#pw2");
        expect(JSON.stringify(yield* Effect.flip(evaluate))).toContain("holds a password");
        yield* clear("#pw");
        expect(yield* evaluate).toBe(2);
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live(
    "stays fenced when the page swaps the filled field for a new one holding the value",
    () => {
      const secrets = makeSecrets();
      return Effect.scoped(
        Effect.gen(function* () {
          const { open, call, fill } = yield* harness;
          const { tabId, page } = yield* open("https://login.test/focus");
          const { ref } = secrets.save("https://login.test");
          yield* fill(tabId, { secretRef: ref, selector: "#pw" });
          // The page's own script moves the value into a fresh, visible field.
          yield* Effect.promise(() =>
            page.evaluate(
              "(() => { const old = document.getElementById('pw'); const next = document.createElement('input'); next.id = 'shown'; next.value = old.value; old.replaceWith(next); })()",
            ),
          );
          const evaluated = yield* call<object>(tabId, "evaluate", { expression: "1 + 1" }).pipe(
            Effect.flip,
          );
          expect(JSON.stringify(evaluated)).toContain("shows a password GOAT filled as plain text");
          const read = yield* call<object>(tabId, "snapshot", { captureImage: false }).pipe(
            Effect.flip,
          );
          expect(JSON.stringify(read)).toContain("shows a password GOAT filled as plain text");
          // Once the page clears the new field too, the fence lifts.
          yield* Effect.promise(() => page.evaluate("document.getElementById('shown').value = ''"));
          expect(yield* call<number>(tabId, "evaluate", { expression: "1 + 1" })).toBe(2);
        }).pipe(Effect.provide(layerFor(secrets))),
      );
    },
  );

  it.live("refuses a tab a person stopped, keeping the ref", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { service, open, fill } = yield* harness;
        const { tabId } = yield* open("https://login.test/");
        const { ref } = secrets.save("https://login.test");
        yield* service.controlSession({ threadId, tabId, control: "stop" });

        const stopped = yield* fill(tabId, { secretRef: ref, selector: "#pw" }).pipe(Effect.flip);
        expect(stopped).toMatchObject({ reason: "stopped" });
        expect(secrets.saved.has(ref)).toBe(true);
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });
});

describe("playwrightDebugLogging", () => {
  it("refuses every DEBUG pattern that could turn on Playwright's protocol log", () => {
    for (const debug of ["pw:protocol", "pw*", "p*", "*", "*protocol*", "*pw*", "goat:*,pw:api"])
      expect(playwrightDebugLogging(debug)).toBe(true);
    for (const debug of [undefined, "", "goat:server", "-pw:*"])
      expect(playwrightDebugLogging(debug)).toBe(false);
  });
});

it.live("reads another session's human-controlled tab without taking authority", () => {
  const secrets = makeSecrets();
  return Effect.scoped(
    Effect.gen(function* () {
      const { service, open } = yield* harness;
      const { tabId } = yield* open("https://login.test/");
      const viewer = yield* service.attachViewer({
        threadId: scope.thread.threadId,
        tabId,
        maxWidth: 1280,
        maxHeight: 800,
        quality: 70,
        canOperate: true,
      });
      yield* viewer.input({ type: "takeControl" });
      const broker = yield* Broker.PreviewAutomationBroker;
      const reader = {
        ...scope,
        requestNamespace: "read-observer",
        thread: { ...scope.thread, providerSessionId: "read-observer" },
      };
      const result = yield* broker.invoke<PreviewAutomationRead>({
        scope: reader,
        operation: "read",
        tabId,
        input: { settleMs: 100 },
      });
      expect(result).toMatchObject({ title: "Sign in", settled: true });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope: reader,
        operation: "status",
        tabId,
        input: {},
      });
      expect(status.control).toMatchObject({ owner: "human", ownedByCaller: false });
      yield* viewer.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layerFor(secrets)));
});

describe.skipIf(!chromiumInstalled)("what a sign-in on a server browser tab reports", () => {
  it.live("a password filled beside an empty identifier is partial, never signed in", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, call, fill } = yield* harness;
        const { tabId } = yield* open("https://login.test/blank-user");
        const { ref } = secrets.save("https://login.test");
        yield* fill(tabId, { secretRef: ref, selector: "#pw" });
        const state = yield* call<PreviewAutomationSignInState>(tabId, "signInState", {});
        expect(state).toMatchObject({
          stage: "partial",
          fields: { identifier: "empty", password: "filled" },
          submitted: false,
        });
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live(
    "a submission that carried the password is only site_accepted until a person hands the tab back",
    () => {
      const secrets = makeSecrets();
      return Effect.scoped(
        Effect.gen(function* () {
          const { service, open, call, fill } = yield* harness;
          const { tabId, page } = yield* open("https://login.test/form");
          const { ref } = secrets.save("https://login.test");
          const filled = yield* fill(tabId, {
            secretRef: ref,
            selector: "#pw",
            expectedAccount: "jun@example.com",
          });
          expect(filled.account).toBe("matched");
          const applied = yield* call<PreviewAutomationSignInState>(tabId, "signInState", {});
          expect(applied.stage).toBe("fields_applied");
          // The site's own button sends the form, as a person or a page script would.
          yield* Effect.promise(() =>
            Promise.all([page.waitForURL("https://login.test/welcome"), page.click("#go")]),
          );
          const accepted = yield* call<PreviewAutomationSignInState>(tabId, "signInState", {});
          // The welcome page echoes the identifier; that is no proof the sign-in worked.
          expect(accepted).toMatchObject({ stage: "site_accepted", submitted: true });
          const threadIdOfTab = ThreadId.make(threadId);
          yield* service.requestHandoff!({
            threadId: threadIdOfTab,
            tabId,
            reason: "Check that you are signed in",
            requestId: "handoff-1",
          });
          yield* service.controlSession({ threadId: threadIdOfTab, tabId, control: "handBack" });
          const confirmed = yield* call<PreviewAutomationSignInState>(tabId, "signInState", {});
          expect(confirmed.stage).toBe("signed_in");
        }).pipe(Effect.provide(layerFor(secrets))),
      );
    },
  );

  it.live("keeps the pixels of a site it filled a password on off, after the field is gone", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, call, fill } = yield* harness;
        const { tabId } = yield* open("https://login.test/form");
        const { ref, value } = secrets.save("https://login.test");
        yield* fill(tabId, { secretRef: ref, selector: "#pw" });
        // The next page of the same site draws the stored password into a canvas.
        yield* call(tabId, "navigate", { url: "https://login.test/welcome" });
        const pictured = yield* call<object>(tabId, "snapshot", { captureImage: true }).pipe(
          Effect.flip,
        );
        expect(JSON.stringify(pictured)).toContain("image snapshots and recordings of it stay off");
        const recording = yield* call<object>(tabId, "recordingStart", {}).pipe(Effect.flip);
        expect(JSON.stringify(recording)).toContain("stay off");
        const text = yield* call<PreviewAutomationSnapshot>(tabId, "snapshot", {
          captureImage: false,
        });
        expect(JSON.stringify(text)).not.toContain(value);
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });
});

describe.skipIf(!chromiumInstalled)("which account a filled password goes to", () => {
  it.live(
    "fills nothing when the account shown changes between finding the field and typing",
    () => {
      let page: Page | undefined;
      const secrets = makeSecrets(async () => {
        await page?.locator("#user").fill("someone-else@example.com");
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const { open, fill } = yield* harness;
          const opened = yield* open("https://login.test/form");
          page = opened.page;
          const { ref } = secrets.save("https://login.test");
          const refused = yield* fill(opened.tabId, { secretRef: ref, selector: "#pw" }).pipe(
            Effect.flip,
          );
          expect(JSON.stringify(refused)).toContain("no longer shows the account");
          expect(yield* Effect.promise(() => fieldValue(opened.page))).toBe("");
        }).pipe(Effect.provide(layerFor(secrets))),
      );
    },
  );

  it.live("fills nothing when the page does not show the expected account", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, fill } = yield* harness;
        const { tabId, page } = yield* open("https://login.test/form");
        const { ref } = secrets.save("https://login.test");
        const refused = yield* fill(tabId, {
          secretRef: ref,
          selector: "#pw",
          expectedAccount: "someone-else@example.com",
        }).pipe(Effect.flip);
        expect(JSON.stringify(refused)).toContain("no longer shows the account");
        expect(yield* Effect.promise(() => fieldValue(page))).toBe("");
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live("names why a secretRef could not be used", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, fill } = yield* harness;
        const { tabId } = yield* open("https://login.test/form");
        const unknownRef = SecretRef.make("secret-ref:" + "0".repeat(32));
        const missing = yield* fill(tabId, { secretRef: unknownRef, selector: "#pw" }).pipe(
          Effect.flip,
        );
        expect(missing).toMatchObject({ secretFailure: "no_candidate", dispatched: false });
        const { ref } = secrets.save("https://other.test");
        const elsewhere = yield* fill(tabId, { secretRef: ref, selector: "#pw" }).pipe(Effect.flip);
        expect(elsewhere).toMatchObject({ secretFailure: "not_permitted", dispatched: false });
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });
});

describe.skipIf(!chromiumInstalled)("what a filled password may never leave behind", () => {
  it.live("fills nothing when the form shows another identifier than the expected account", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, fill } = yield* harness;
        const { tabId, page } = yield* open("https://login.test/mention");
        const { ref } = secrets.save("https://login.test");
        const refused = yield* fill(tabId, {
          secretRef: ref,
          selector: "#pw",
          expectedAccount: "jun@example.com",
        }).pipe(Effect.flip);
        expect(JSON.stringify(refused)).toContain("no longer shows the account");
        expect(yield* Effect.promise(() => fieldValue(page))).toBe("");
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live("keeps the pixels of a tab off after a framed field it filled navigates away", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, call, fill } = yield* harness;
        const { tabId, page } = yield* open("https://login.test/framed");
        yield* Effect.promise(() => page.frameLocator("#auth").locator("#pw").focus());
        const { ref } = secrets.save("https://auth.test");
        yield* fill(tabId, { secretRef: ref });
        // The frame leaves the field behind; the tab's top document never had the password.
        yield* Effect.promise(() =>
          Promise.all([
            page.waitForEvent("framenavigated"),
            page.evaluate("document.querySelector('#auth').src = 'https://other.test/'"),
          ]),
        );
        const pictured = yield* call<object>(tabId, "snapshot", { captureImage: true }).pipe(
          Effect.flip,
        );
        expect(JSON.stringify(pictured)).toContain("stay off");
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live("masks a password in a long site error before cutting it", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, call, fill } = yield* harness;
        const { tabId } = yield* open("https://login.test/echo-error");
        const { ref, value } = secrets.save("https://login.test");
        yield* fill(tabId, { secretRef: ref, selector: "#pw" });
        const state = yield* call<PreviewAutomationSignInState>(tabId, "signInState", {});
        expect(state.validation.length).toBe(1);
        expect(JSON.stringify(state)).not.toContain(value.slice(0, 4));
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live("counts only a request that carried the whole password as a submission", () => {
    const secrets = makeSecrets();
    return Effect.scoped(
      Effect.gen(function* () {
        const { open, call, fill } = yield* harness;
        const { tabId, page } = yield* open("https://login.test/form");
        const { ref, value } = secrets.save("https://login.test");
        yield* fill(tabId, { secretRef: ref, selector: "#pw" });
        // A body ending on the start of the value is not the value.
        const body = JSON.stringify("help " + value.slice(0, 3));
        yield* Effect.promise(() =>
          page.evaluate("fetch('https://login.test/api', { method: 'POST', body: " + body + " })"),
        );
        const state = yield* call<PreviewAutomationSignInState>(tabId, "signInState", {});
        expect(state.submitted).toBe(false);
      }).pipe(Effect.provide(layerFor(secrets))),
    );
  });

  it.live(
    "reports a submission the site refused with an error and no form as a validation error",
    () => {
      const secrets = makeSecrets();
      return Effect.scoped(
        Effect.gen(function* () {
          const { open, call, fill } = yield* harness;
          const { tabId, page } = yield* open("https://login.test/form-denied");
          const { ref } = secrets.save("https://login.test");
          yield* fill(tabId, { secretRef: ref, selector: "#pw" });
          yield* Effect.promise(() =>
            Promise.all([page.waitForURL("https://login.test/denied"), page.click("#go")]),
          );
          const state = yield* call<PreviewAutomationSignInState>(tabId, "signInState", {});
          expect(state.stage).toBe("validation_error");
        }).pipe(Effect.provide(layerFor(secrets))),
      );
    },
  );
});
