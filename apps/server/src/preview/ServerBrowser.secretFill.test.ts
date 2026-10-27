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
const makeSecrets = () => {
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
      Effect.suspend(() => {
        const entry = saved.get(input.ref);
        if (entry === undefined)
          return Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }));
        if (entry.origin !== input.origin)
          return Effect.fail(new SecretRequestError({ reason: "origin_mismatch" }));
        saved.delete(input.ref);
        consumed.push(input.ref);
        return Effect.succeed(entry.value);
      }),
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
        Layer.succeed(PreviewBrowser.PreviewBrowser, {
          executable: Effect.die("unused executable"),
          installed: Effect.die("unused executable"),
        }),
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
        expect(result).toEqual({ filled: true, origin: "https://login.test", privateMode: false });
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
