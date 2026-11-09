import { RegistryContext } from "@effect/atom-react";
import { BearerConnectionTarget, SshConnectionTarget } from "@goat/client-runtime/connection";
import { type AssetCreateUrlResult, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

const mint = vi.hoisted(() => vi.fn<() => Promise<AssetCreateUrlResult>>());
const state = vi.hoisted(() => ({
  connection: { httpBaseUrl: "https://host.test" } as { httpBaseUrl: string; target?: unknown },
  previewAllowed: false,
  openPreview: vi.fn<(url: string) => Promise<unknown>>(),
  openExternal: vi.fn<(url: string) => Promise<void>>(),
}));
// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// Keep the real query runner and registry: refreshes during waiting requests are skipped.
vi.mock(import("../state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const family = Atom.family((_key: string) =>
    Atom.make(Effect.tryPromise(() => mint())).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: (target) => family(JSON.stringify(target)),
    },
  };
});
vi.mock(import("../state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => false,
  useEnvironmentScope: () => state.previewAllowed,
  readPreparedConnection: (() => state.connection) as never,
  usePreparedConnection: (() => ({ _tag: "Some", value: state.connection })) as never,
}));
vi.mock(import("../browser/previewRuntime"), async (original) => ({
  ...(await original()),
  isPreviewAvailableFor: () => state.previewAllowed,
}));
vi.mock(import("../browser/openFileInPreview"), async (original) => ({
  ...(await original()),
  openUrlInPreview: ((input: { url: string }) => state.openPreview(input.url)) as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({ shell: { openExternal: state.openExternal } })) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const remoteEnvironment = EnvironmentId.make("remote-environment");
const remoteTarget = { environmentId: remoteEnvironment, label: "Build box" };
const tailnetConnection = () => ({
  httpBaseUrl: "http://100.65.180.100:3773",
  target: new BearerConnectionTarget({ ...remoteTarget, connectionId: "saved:box" }),
});
const sshConnection = () => ({
  httpBaseUrl: "http://127.0.0.1:41234",
  target: new SshConnectionTarget({ ...remoteTarget, connectionId: "ssh:box" }),
});

function setup(input: { connection: typeof state.connection; previewAllowed?: boolean }) {
  state.connection = input.connection;
  state.previewAllowed = input.previewAllowed ?? false;
  // The preview refuses, so a fallback to the system browser would show up as an openExternal call.
  state.openPreview
    .mockReset()
    .mockImplementation(async () =>
      AsyncResult.failure(Cause.fail(new Error("Preview is unavailable."))),
    );
  state.openExternal.mockReset().mockResolvedValue(undefined);
  mint.mockReset();
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

// The test device reaches neither address, so a load fails and unmounts the <img>; keep every address it asked for.
function recordImageSources() {
  const sources = new Set<string>();
  const record = (node: Node) => {
    if (!(node instanceof Element)) return;
    for (const image of [node, ...node.querySelectorAll("img")]) {
      const src = image instanceof HTMLImageElement ? image.getAttribute("src") : null;
      if (src) sources.add(src);
    }
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      record(mutation.target);
      mutation.addedNodes.forEach(record);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributeFilter: ["src"] });
  return { sources, [Symbol.dispose]: () => observer.disconnect() };
}

async function renderRemoteMarkdown(
  registry: AtomRegistry.AtomRegistry,
  text: string,
  onImageExpand?: () => void,
) {
  return render(
    <RegistryContext.Provider value={registry}>
      <ChatMarkdown
        cwd="/repo"
        threadRef={{ environmentId: remoteEnvironment, threadId: ThreadId.make("remote-thread") }}
        text={text}
        onImageExpand={onImageExpand}
      />
    </RegistryContext.Provider>,
  );
}

// Port 1 is one Chromium refuses to load, so these images fail at once.
const PAGE_IMAGE = "http://localhost:1/w";

it("loads a remote environment's localhost image from the environment's address (regression: loaded this device's localhost)", async () => {
  using test = setup({ connection: tailnetConnection() });
  using images = recordImageSources();
  await using _screen = await renderRemoteMarkdown(
    test.registry,
    "![shot](http://localhost:5173/shot.png)",
  );
  await vi.waitFor(() => expect(images.sources.size).toBeGreaterThan(0));
  expect([...images.sources]).toEqual(["http://100.65.180.100:5173/shot.png"]);
});

it("explains a remote localhost image this device cannot reach instead of loading its own localhost", async () => {
  using test = setup({ connection: sshConnection() });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    "![shot](http://localhost:5173/shot.png)",
  );
  await vi.waitFor(() =>
    expect(screen.container.textContent).toContain("localhost:5173 is on Build box"),
  );
  expect(screen.container.querySelector("img")).toBeNull();
});

it("offers a failed page image in the preview sidebar and never in the system browser", async () => {
  using test = setup({ connection: tailnetConnection(), previewAllowed: true });
  await using screen = await renderRemoteMarkdown(test.registry, `![page](${PAGE_IMAGE})`);
  const openPage = screen.getByRole("button", { name: "Open page" });
  await expect.element(openPage).toBeInTheDocument();
  await openPage.click();
  await vi.waitFor(() => expect(state.openPreview).toHaveBeenCalledWith(PAGE_IMAGE));
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("offers no page to a client without preview access", async () => {
  using test = setup({ connection: tailnetConnection() });
  await using screen = await renderRemoteMarkdown(test.registry, `![page](${PAGE_IMAGE})`);
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Image unavailable"));
  expect(screen.container.querySelector("button")).toBeNull();
});

it("offers a linked image's own page beside the link, leaving the link's target alone", async () => {
  using test = setup({ connection: tailnetConnection(), previewAllowed: true });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    `[![page](${PAGE_IMAGE})](https://example.test/other)`,
  );
  const openPage = screen.getByRole("button", { name: "Open page" });
  await expect.element(openPage).toBeInTheDocument();
  expect(openPage.element().closest("a")).toBeNull();
  expect(screen.container.querySelector('a[href="https://example.test/other"]')).not.toBeNull();
  await openPage.click();
  await vi.waitFor(() => expect(state.openPreview).toHaveBeenCalledWith(PAGE_IMAGE));
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("expands a remote environment's localhost image link at the environment's address", async () => {
  using test = setup({ connection: tailnetConnection() });
  const onImageExpand = vi.fn();
  await using screen = await renderRemoteMarkdown(
    test.registry,
    "[full](http://localhost:5173/full.png)",
    onImageExpand,
  );
  const link = screen.container.querySelector<HTMLAnchorElement>("a");
  await act(async () => link!.click());
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "http://100.65.180.100:5173/full.png" })],
      }),
    ),
  );
});

it("opens host media through server authorization before the client grant loads", async () => {
  using test = setup({ connection: { httpBaseUrl: "https://host.test" } });
  mint.mockResolvedValue({ relativeUrl: "/api/assets/image.png", expiresAt: 1 });
  const onImageExpand = vi.fn();
  await using screen = await render(
    <RegistryContext.Provider value={test.registry}>
      <ChatMarkdown
        cwd="/repo"
        threadRef={{
          environmentId: EnvironmentId.make("media-environment"),
          threadId: ThreadId.make("media-thread"),
        }}
        text="[Open image](/tmp/image.png)"
        onImageExpand={onImageExpand}
      />
    </RegistryContext.Provider>,
  );
  const link = screen.container.querySelector<HTMLAnchorElement>('a[href="/tmp/image.png"]');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  await vi.waitFor(() =>
    expect(onImageExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ src: "https://host.test/api/assets/image.png" })],
      }),
    ),
  );
  const [preview] = onImageExpand.mock.calls[0]!;
  expect(preview.images[0].actionsSource.onOpenFile).toBeTypeOf("function");
});
it("offers a captioned linked image's page beside the link", async () => {
  using test = setup({ connection: tailnetConnection(), previewAllowed: true });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    `[Caption ![page](${PAGE_IMAGE})](https://example.test/)`,
  );
  const openPage = screen.getByRole("button", { name: "Open page" });
  await expect.element(openPage).toBeInTheDocument();
  expect(openPage.element().closest("a")).toBeNull();
  await openPage.click();
  await vi.waitFor(() => expect(state.openPreview).toHaveBeenCalledWith(PAGE_IMAGE));
  expect(state.openExternal).not.toHaveBeenCalled();
});
it("offers the page of a web image nested in a link beside its file images", async () => {
  using test = setup({ connection: sshConnection(), previewAllowed: true });
  mint.mockResolvedValue({ relativeUrl: "/api/assets/thumb.png", expiresAt: 1 });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    `[![thumb](/repo/thumb.png) *![page](${PAGE_IMAGE})*](https://example.test/)`,
  );
  const openPage = screen.getByRole("button", { name: "Open page" });
  await expect.element(openPage).toBeInTheDocument();
  expect(openPage.element().closest("a")).toBeNull();
  await openPage.click();
  await vi.waitFor(() => expect(state.openPreview).toHaveBeenCalledWith(PAGE_IMAGE));
});

it("drops a playing localhost video's old address when a reconnect leaves it out of reach", async () => {
  using test = setup({ connection: tailnetConnection() });
  const markdown = () => (
    <RegistryContext.Provider value={test.registry}>
      <ChatMarkdown
        cwd="/repo"
        threadRef={{ environmentId: remoteEnvironment, threadId: ThreadId.make("remote-thread") }}
        text="![clip](http://localhost:5173/clip.mp4)"
      />
    </RegistryContext.Provider>
  );
  await using screen = await render(markdown());
  const routed = "http://100.65.180.100:5173/clip.mp4";
  await vi.waitFor(() =>
    expect(screen.container.querySelector("video")?.getAttribute("src")).toBe(routed),
  );
  await act(async () => screen.container.querySelector("video")!.dispatchEvent(new Event("play")));
  state.connection = sshConnection();
  await screen.rerender(markdown());
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Video unavailable"));
  expect(screen.container.querySelector(`video[src="${routed}"]`)).toBeNull();
});
it("offers the page of every image in a link that fails", async () => {
  using test = setup({ connection: sshConnection(), previewAllowed: true });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    "[![one](http://localhost:1/one) ![two](http://localhost:1/two)](https://example.test/)",
  );
  await vi.waitFor(() => expect(screen.container.querySelectorAll("button")).toHaveLength(2));
  for (const button of screen.container.querySelectorAll("button")) {
    await act(async () => button.click());
  }
  await vi.waitFor(() =>
    expect(state.openPreview.mock.calls.map(([url]) => url)).toEqual([
      "http://localhost:1/one",
      "http://localhost:1/two",
    ]),
  );
});
it("withdraws a linked image's page once the image loads after a reconnect", async () => {
  using test = setup({ connection: tailnetConnection(), previewAllowed: true });
  const markdown = () => (
    <RegistryContext.Provider value={test.registry}>
      <ChatMarkdown
        cwd="/repo"
        threadRef={{ environmentId: remoteEnvironment, threadId: ThreadId.make("remote-thread") }}
        text={`[![page](${PAGE_IMAGE})](https://example.test/)`}
      />
    </RegistryContext.Provider>
  );
  await using screen = await render(markdown());
  const buttons = () => screen.container.querySelectorAll("button");
  await vi.waitFor(() => expect(buttons()).toHaveLength(1));
  state.connection = sshConnection();
  await screen.rerender(markdown());
  state.connection = tailnetConnection();
  await screen.rerender(markdown());
  const image = screen.container.querySelector("img");
  expect(image).not.toBeNull();
  await act(async () => image!.dispatchEvent(new Event("load")));
  await vi.waitFor(() => expect(buttons()).toHaveLength(0));
});
it("keeps an image that labels a file link, with its page", async () => {
  using test = setup({ connection: tailnetConnection(), previewAllowed: true });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    `[![page](${PAGE_IMAGE})](README.md)`,
  );
  await expect.element(screen.getByRole("button", { name: "Open page" })).toBeInTheDocument();
});
it("keeps an image nested in a file link's label", async () => {
  using test = setup({ connection: tailnetConnection(), previewAllowed: true });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    `[README.md *![page](${PAGE_IMAGE})*](README.md)`,
  );
  await expect.element(screen.getByRole("button", { name: "Open page" })).toBeInTheDocument();
});
it("offers the page of a linked picture's theme source", async () => {
  using test = setup({ connection: sshConnection(), previewAllowed: true });
  await using screen = await renderRemoteMarkdown(
    test.registry,
    `<a href="https://example.test/"><picture><source media="(prefers-color-scheme: light)" srcset="${PAGE_IMAGE}"><source media="(prefers-color-scheme: dark)" srcset="${PAGE_IMAGE}"><img alt="page" src="shots/page.png"></picture></a>`,
  );
  const openPage = screen.getByRole("button", { name: "Open page" });
  await expect.element(openPage).toBeInTheDocument();
  await openPage.click();
  await vi.waitFor(() => expect(state.openPreview).toHaveBeenCalledWith(PAGE_IMAGE));
});
