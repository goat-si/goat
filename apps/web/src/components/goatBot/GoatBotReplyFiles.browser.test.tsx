import { RegistryContext, scheduleTask } from "@effect/atom-react";
import type { EnvironmentRegistry } from "@goat/client-runtime/connection";
import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId } from "@goat/contracts";
import { AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const server = vi.hoisted(() => ({
  /** Listing and read requests the fake server answered. */
  listed: 0,
  reads: [] as Array<string>,
  /** Saved files by path: their type and contents. */
  files: new Map<string, { readonly mimeType: string; readonly text: string }>(),
  // The listing's artifacts folder; undefined is an older server that does not send it.
  root: undefined as string | undefined,
  /** While set, a listing read waits for it; it still lists the files saved when it started. */
  gate: null as Promise<void> | null,
  /** The next listing read fails. */
  failNext: false,
}));
const SUMMARY = { mimeType: "text/markdown", text: "# Weekly summary\nThree merged." };
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  usePrimarySettings: () => "system",
}));
vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
vi.mock("./GoatBotTaskChip", () => ({ GoatBotTaskChip: () => null }));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<typeof import("~/state/entities")>()),
  useServerConfigs: () =>
    new Map([["env", { environment: { capabilities: { goatBotLibrary: true } } }]]),
}));
// The real channel atoms over one connected fake environment, so the listing's caching and the
// reads are the runtime's own; only the server's answers are the test's.
vi.mock("~/state/channels", async (original) => {
  const [real, Effect, Layer, Option, Stream, SubscriptionRef, Base64, reactivity, http] =
    await Promise.all([
      original<typeof import("~/state/channels")>(),
      import("effect/Effect"),
      import("effect/Layer"),
      import("effect/Option"),
      import("effect/Stream"),
      import("effect/SubscriptionRef"),
      import("effect/encoding/Base64"),
      import("effect/reactivity"),
      import("effect/http"),
    ]);
  const [contracts, connection, channels] = await Promise.all([
    import("@goat/contracts"),
    import("@goat/client-runtime/connection"),
    import("@goat/client-runtime/state/channels"),
  ]);
  const methods = contracts.CHANNEL_GATEWAY_WS_METHODS;
  const client = {
    [methods.listBotArtifacts]: () =>
      Effect.gen(function* () {
        server.listed += 1;
        const saved = [...server.files.keys()];
        const root = server.root;
        const fail = server.failNext;
        server.failNext = false;
        const gate = server.gate;
        if (gate !== null) yield* Effect.promise(() => gate);
        if (fail) return yield* Effect.die(new Error("The listing read failed."));
        return {
          ...(root === undefined ? {} : { root }),
          artifacts: saved.map((relativePath) => ({
            relativePath,
            size: 30,
            modifiedAt: "2026-11-07T10:00:00.000Z",
          })),
          truncated: false,
        };
      }),
    [methods.readBotArtifact]: (input: { readonly relativePath: string }) =>
      Effect.sync(() => {
        server.reads.push(input.relativePath);
        const file = server.files.get(input.relativePath);
        if (file === undefined) return { status: "changed" as const };
        const bytes = new TextEncoder().encode(file.text);
        return {
          status: "chunk" as const,
          relativePath: input.relativePath,
          mimeType: file.mimeType,
          size: bytes.length,
          offset: 0,
          bytesBase64: Base64.encode(bytes),
          version: "v1",
          done: true,
        };
      }),
  };
  const target = new connection.PrimaryConnectionTarget({
    environmentId: contracts.EnvironmentId.make("env"),
    label: "Test",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  const Supervisor = connection.EnvironmentSupervisor.EnvironmentSupervisor;
  const unknown = (environmentId: unknown) => new Error(`No environment ${String(environmentId)}`);
  // Built with each atom registry, so every test starts from a new connection.
  const registry = Effect.gen(function* () {
    const supervisor = {
      target,
      state: yield* SubscriptionRef.make({
        ...connection.AVAILABLE_CONNECTION_STATE,
        desired: true,
        network: "online" as const,
        phase: "connected" as const,
        attempt: 1,
        generation: 1,
      }),
      session: yield* SubscriptionRef.make(
        Option.some({
          client,
          initialConfig: Effect.never,
          subscribeServerConfig: () => Stream.never,
          ready: Effect.void,
          probe: Effect.void,
          inboundFrames: Effect.succeed(0),
          closed: Effect.never,
        }),
      ),
      prepared: yield* SubscriptionRef.make(
        Option.some({
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: target.wsBaseUrl,
          httpAuthorization: null,
          target,
        }),
      ),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    };
    type Service = EnvironmentRegistry.EnvironmentRegistry["Service"];
    const run: Service["run"] = (environmentId, effect) =>
      environmentId === target.environmentId
        ? Effect.provideService(effect, Supervisor, supervisor as never)
        : Effect.die(unknown(environmentId));
    const followStream: Service["followStream"] = (environmentId, stream) =>
      environmentId === target.environmentId
        ? Stream.provideService(stream, Supervisor, supervisor as never)
        : Stream.die(unknown(environmentId));
    return {
      run,
      followStream,
      stateChanges: () => SubscriptionRef.changes(supervisor.state),
    } as unknown as Service;
  });
  // A signed-in browser with the standard grants, which reading the Library needs.
  const fetchSession: typeof fetch = async (input) =>
    new URL(input instanceof Request ? input.url : String(input)).pathname === "/api/auth/session"
      ? Response.json({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "goat_session",
          },
          scopes: contracts.AuthStandardClientScopes,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2099-01-01T00:00:00.000Z",
        })
      : new Response("{}", { status: 404 });
  const runtime = reactivity.Atom.runtime(
    Layer.mergeAll(
      Layer.effect(connection.EnvironmentRegistry.EnvironmentRegistry, registry),
      http.FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(http.FetchHttpClient.Fetch, fetchSession)),
      ),
    ),
  );
  return { ...real, channelEnvironment: channels.createChannelEnvironmentAtoms(runtime) };
});
import { GoatBotOpenFileContext } from "./GoatBotReplyFiles";
import { GoatBotTimeline } from "./GoatBotTimeline";

/** A fresh server and atom registry: the Library holds `files` (summary.md unless given). */
function setup(
  files: ReadonlyArray<readonly [string, { readonly mimeType: string; readonly text: string }]> = [
    ["reports/summary.md", SUMMARY],
  ],
  root?: string,
) {
  server.listed = 0;
  server.reads = [];
  server.files = new Map(files);
  server.root = root;
  server.gate = null;
  server.failNext = false;
  const registry = AtomRegistry.make({ scheduleTask });
  return {
    wrap: (ui: ReactNode) => (
      <RegistryContext.Provider value={registry}>{ui}</RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

const reply = (id: string, text: string): GoatBotRow => ({
  kind: "bot",
  id,
  text,
  createdAt: "2026-11-07T10:00:00.000Z",
  tone: "reply",
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single",
});

it("a reply naming a saved file shows its card with a preview, which opens the file", async () => {
  using test = setup();
  const open = vi.fn();
  await using screen = await render(
    test.wrap(
      <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open }}>
        <GoatBotTimeline
          rows={[
            reply("plain", "Run `vp test` next."),
            reply("saved", "I saved the summary as `reports/summary.md`."),
          ]}
          onRetry={() => {}}
        />
      </GoatBotOpenFileContext>,
    ),
    { router: false }, // These replies have no links.
  );
  const card = screen.getByRole("button", { name: "Open summary.md" });
  await expect.element(card).toBeVisible();
  await expect.element(screen.getByText(/Three merged/)).toBeInTheDocument();
  await userEvent.click(card);
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ relativePath: "reports/summary.md" }),
  );
  expect(server.reads).toEqual(["reports/summary.md"]);
  expect(server.listed).toBe(1);
});

it("a reply whose code no listed file can match asks the server for nothing", async () => {
  using test = setup();
  await using screen = await render(
    test.wrap(
      <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
        <GoatBotTimeline
          rows={[reply("plain", "Set `HOST:PORT` in `.env` next.")]}
          onRetry={() => {}}
        />
      </GoatBotOpenFileContext>,
    ),
    { router: false }, // This reply has no links.
  );
  await expect.element(screen.getByText(/next\./)).toBeVisible();
  expect(server.listed).toBe(0);
  expect(server.reads).toEqual([]);
});

const ROOT = "/srv/goat/userdata/goat-bot/artifacts";

it("a reply naming a file saved after the listing was read still gets its card, from one more read", async () => {
  using test = setup();
  const view = (rows: ReadonlyArray<GoatBotRow>) =>
    test.wrap(
      <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
        <GoatBotTimeline rows={rows} onRetry={() => {}} />
      </GoatBotOpenFileContext>,
    );
  const first = reply("first", "Saved `reports/summary.md`.");
  await using screen = await render(view([first]), { router: false }); // No links here.
  await expect.element(screen.getByRole("button", { name: "Open summary.md" })).toBeVisible();
  expect(server.listed).toBe(1);
  server.files.set("reports/plan.md", { mimeType: "text/markdown", text: "# Plan" });
  server.files.set("reports/notes.md", { mimeType: "text/markdown", text: "# Notes" });
  // Two replies that arrive together share the one read.
  await screen.rerender(
    view([
      first,
      reply("plan", "Then I saved `reports/plan.md`."),
      reply("notes", "And `reports/notes.md`."),
    ]),
  );
  await expect.element(screen.getByRole("button", { name: "Open plan.md" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Open notes.md" })).toBeVisible();
  expect(server.listed).toBe(2);
});

const libraryView = (test: ReturnType<typeof setup>) => (rows: ReadonlyArray<GoatBotRow>) =>
  test.wrap(
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
      <GoatBotTimeline rows={rows} onRetry={() => {}} />
    </GoatBotOpenFileContext>,
  );

it("a reply arriving while a reread is out gets one follow-up read when it settles", async () => {
  using test = setup();
  const view = libraryView(test);
  const first = reply("first", "Saved `reports/summary.md`.");
  await using screen = await render(view([first]), { router: false }); // No links here.
  await expect.element(screen.getByRole("button", { name: "Open summary.md" })).toBeVisible();
  let release = () => {};
  server.gate = new Promise<void>((resolve) => (release = resolve));
  server.files.set("reports/plan.md", { mimeType: "text/markdown", text: "# Plan" });
  const plan = reply("plan", "Then I saved `reports/plan.md`.");
  await screen.rerender(view([first, plan]));
  await vi.waitFor(() => expect(server.listed).toBe(2));
  // Saved after the reread started, so only a follow-up read can list it.
  server.files.set("reports/notes.md", { mimeType: "text/markdown", text: "# Notes" });
  await screen.rerender(view([first, plan, reply("notes", "And `reports/notes.md`.")]));
  server.gate = null;
  release();
  await expect.element(screen.getByRole("button", { name: "Open plan.md" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Open notes.md" })).toBeVisible();
  expect(server.listed).toBe(3);
});

it("after a reread fails, a later reply naming a file reads the listing again", async () => {
  using test = setup();
  const view = libraryView(test);
  const first = reply("first", "Saved `reports/summary.md`.");
  await using screen = await render(view([first]), { router: false }); // No links here.
  await expect.element(screen.getByRole("button", { name: "Open summary.md" })).toBeVisible();
  server.files.set("reports/plan.md", { mimeType: "text/markdown", text: "# Plan" });
  server.failNext = true;
  const failed = reply("failed", "Then I saved `reports/plan.md`.");
  await screen.rerender(view([first, failed]));
  await vi.waitFor(() => expect(server.listed).toBe(2));
  await screen.rerender(view([first, failed, reply("again", "It is `reports/plan.md`.")]));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Open plan.md" }).elements()).toHaveLength(2),
  );
  expect(server.listed).toBe(3);
});

it("a reply whose text comes to name a file after it was drawn reads the listing again", async () => {
  using test = setup();
  const view = libraryView(test);
  const first = reply("first", "Saved `reports/summary.md`.");
  await using screen = await render(view([first, reply("later", "Working on it.")]), {
    router: false, // No links here.
  });
  await expect.element(screen.getByRole("button", { name: "Open summary.md" })).toBeVisible();
  server.files.set("reports/plan.md", { mimeType: "text/markdown", text: "# Plan" });
  await screen.rerender(view([first, reply("later", "Saved `reports/plan.md`.")]));
  await expect.element(screen.getByRole("button", { name: "Open plan.md" })).toBeVisible();
  expect(server.listed).toBe(2);
});

it("a full path gets a card only when it is inside this server's artifacts folder", async () => {
  using test = setup(undefined, ROOT);
  await using screen = await render(
    test.wrap(
      <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
        <GoatBotTimeline
          rows={[
            reply("other", "The other machine wrote `/other/artifacts/reports/summary.md`."),
            reply("climb", `Also \`${ROOT}/../../x/artifacts/reports/summary.md\`.`),
            reply("link", `Through a link: \`${ROOT}/link/../reports/summary.md\`.`),
            reply("own", `I saved \`${ROOT}/reports/summary.md\`.`),
          ]}
          onRetry={() => {}}
        />
      </GoatBotOpenFileContext>,
    ),
    { router: false }, // These replies have no links.
  );
  await expect.element(screen.getByRole("button", { name: "Open summary.md" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open summary.md" }).elements()).toHaveLength(1);
  expect(server.reads).toEqual(["reports/summary.md"]);
});

it("an older server's listing keeps cards for relative names, extensionless too, and none for full paths", async () => {
  using test = setup([
    ["README", { mimeType: "application/octet-stream", text: "read me" }],
    ["reports/summary.md", SUMMARY],
  ]);
  await using screen = await render(
    test.wrap(
      <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
        <GoatBotTimeline
          rows={[
            reply("full", `Saved \`${ROOT}/reports/summary.md\`.`),
            reply("bare", "Saved `README`."),
          ]}
          onRetry={() => {}}
        />
      </GoatBotOpenFileContext>,
    ),
    { router: false }, // These replies have no links.
  );
  await expect.element(screen.getByRole("button", { name: "Open README" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open summary.md" }).elements()).toHaveLength(0);
  expect(server.reads).toEqual(["README"]);
});

const remote = "https://tracker.example.com";

/** Every element that would fetch something, and every resource the page requested from there. */
function fetchedFrom(card: Element) {
  const elements = [
    ...card.querySelectorAll("img, video, audio, source, iframe, object, embed, picture, image, a"),
  ].filter((element) => !(element.getAttribute("src") ?? "").startsWith("blob:"));
  const requests = performance
    .getEntriesByType("resource")
    .filter((entry) => entry.name.startsWith(remote));
  return { elements: elements.map((element) => element.outerHTML), requests };
}

it("a saved file's preview loads nothing the file names, only its words", async () => {
  using test = setup([
    [
      "reports/tracked.md",
      {
        mimeType: "text/markdown",
        text: [
          "# Tracked report",
          "",
          `![tracking pixel](${remote}/pixel.png)`,
          "",
          `<img src="${remote}/raw.png" alt="raw">`,
          "",
          `See [the vendor site](${remote}/page) and ![chart][c].`,
          "",
          `![clip](${remote}/clip.mp4)`,
          "",
          `[c]: ${remote}/chart.png`,
        ].join("\n"),
      },
    ],
  ]);
  await using screen = await render(
    test.wrap(
      <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
        <GoatBotTimeline
          rows={[reply("saved", "Saved `reports/tracked.md`.")]}
          onRetry={() => {}}
        />
      </GoatBotOpenFileContext>,
    ),
    { router: false }, // The reply has no links; the file's links must not become any.
  );
  await expect.element(screen.getByText("Tracked report")).toBeInTheDocument();
  const card = screen.getByRole("button", { name: "Open tracked.md" }).element().parentElement;
  if (card === null) throw new Error("expected the file card");
  expect(card.textContent).toContain("tracking pixel");
  expect(card.textContent).toContain("See the vendor site and chart.");
  expect(card.textContent).not.toContain("<img");
  expect(fetchedFrom(card)).toEqual({ elements: [], requests: [] });
});

it("an SVG preview is drawn as an image, so its scripts and external references never run", async () => {
  using test = setup([
    [
      "charts/plot.svg",
      {
        mimeType: "image/svg+xml",
        text: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="${remote}/svg.png" width="10" height="10"/><script>document.title = "ran"</script></svg>`,
      },
    ],
  ]);
  const title = document.title;
  await using screen = await render(
    test.wrap(
      <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
        <GoatBotTimeline rows={[reply("saved", "Saved `charts/plot.svg`.")]} onRetry={() => {}} />
      </GoatBotOpenFileContext>,
    ),
    { router: false }, // This reply has no links.
  );
  const opener = screen.getByRole("button", { name: "Open plot.svg" });
  await expect.element(opener).toBeVisible();
  const card = opener.element().parentElement;
  if (card === null) throw new Error("expected the file card");
  await vi.waitFor(() => expect(card.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
  const image = card.querySelector("img");
  await vi.waitFor(() => expect(image?.complete).toBe(true));
  // The file is never put in the page as markup: only the card's own icon is an svg.
  expect(card.querySelector("[inert] svg, script")).toBeNull();
  expect(document.title).toBe(title);
  expect(fetchedFrom(card)).toEqual({ elements: [], requests: [] });
});
