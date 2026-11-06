import { EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Minted = { relativeUrl: string; expiresAt: number };
// A fixed clock: renewals depend on how close a URL is to expiring.
const NOW = 1_800_000_000_000;
const state = vi.hoisted(() => ({
  phase: "connected" as string,
  calls: [] as Array<{ path: string; settle: (outcome: unknown) => void }>,
  opened: [] as Array<{ uri: string; name: string; mimeType: string }>,
  external: [] as string[],
}));
vi.mock("../../state/session", () => ({
  usePreparedConnection: () => Option.some({ httpBaseUrl: "https://hub.example" }),
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ presentation: { connection: { phase: state.phase } } }),
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: () => null } }));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => (target: { input: { resource: { path: string } } }) =>
    new Promise((settle) => state.calls.push({ path: target.input.resource.path, settle })),
}));
vi.mock("../../lib/attachmentDownload", () => ({
  openAttachmentInViewer: async (input: {
    uri: string;
    attachment: { name: string; mimeType: string };
  }) => {
    state.opened.push({ uri: input.uri, ...input.attachment });
  },
}));
vi.mock("../../lib/openExternalUrl", () => ({
  tryOpenExternalUrl: async (url: string) => {
    state.external.push(url);
    return true;
  },
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: () => {} }));

import {
  noteFileMimeType,
  useNoteImageResolver,
  useNoteImageSource,
  useOpenNoteLink,
  type NoteImageUrls,
} from "./useNoteFiles";

const environmentId = EnvironmentId.make("env");
const succeed = (minted: Minted) => ({ _tag: "Success", value: minted });
const fail = (tag: string) => ({ _tag: "Failure", cause: Cause.fail({ _tag: tag }) });
const href = (index: number) => `/.attachments/${index.toString(16).padStart(16, "0")}.png`;

type Hooks = {
  resolve: (hrefs: ReadonlyArray<string>, renew: boolean) => void;
  source: ReturnType<typeof useNoteImageSource>;
  open: (href: string) => void;
};

async function setup(phase = "connected") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.phase = phase;
  state.calls = [];
  state.opened = [];
  state.external = [];
  const sent: NoteImageUrls[] = [];
  let hooks: Hooks | null = null;
  const capture = (next: Hooks) => {
    hooks = next;
  };
  function Probe(props: { capture: (hooks: Hooks) => void }) {
    props.capture({
      resolve: useNoteImageResolver(environmentId, "plan.md", (message) => sent.push(message)),
      source: useNoteImageSource(environmentId, "plan.md"),
      open: useOpenNoteLink(environmentId, "plan.md"),
    });
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<Probe capture={capture} />));
  return {
    sent,
    hooks: () => hooks!,
    rerender: () => act(async () => root.render(<Probe capture={capture} />)),
    [Symbol.asyncDispose]: async () => {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
}

const settleAll = async (outcome: (path: string) => unknown) => {
  for (const call of state.calls.splice(0)) call.settle(outcome(call.path));
  await act(async () => {});
};

it("mints at most four images at once and each image once", async () => {
  await using page = await setup();
  page.hooks().resolve([1, 2, 3, 4, 5, 6].map(href), false);
  page.hooks().resolve([href(1)], false);
  expect(state.calls).toHaveLength(4);
  await settleAll(() =>
    succeed({ relativeUrl: "/api/assets/t/x.png", expiresAt: NOW + 3_600_000 }),
  );
  expect(state.calls).toHaveLength(2);
  await settleAll(() =>
    succeed({ relativeUrl: "/api/assets/t/x.png", expiresAt: NOW + 3_600_000 }),
  );
  expect(page.sent.flatMap((message) => Object.keys(message.urls))).toHaveLength(6);
});

it("ignores renewals until a URL nears expiry", async () => {
  await using page = await setup();
  page.hooks().resolve([href(1)], false);
  await settleAll(() => succeed({ relativeUrl: "/a", expiresAt: NOW + 3_600_000 }));
  for (let attempt = 0; attempt < 3; attempt++) page.hooks().resolve([href(1)], true);
  expect(state.calls).toHaveLength(0);
  page.hooks().resolve([href(2)], false);
  await settleAll(() => succeed({ relativeUrl: "/b", expiresAt: NOW + 60_000 }));
  page.hooks().resolve([href(2)], true);
  expect(state.calls.map((call) => call.path)).toEqual([href(2).slice(1)]);
});

it("reports permanent failures and retries the rest when the connection returns", async () => {
  await using page = await setup();
  page.hooks().resolve(["images/x.png", href(1), href(2)], false);
  expect(page.sent[0]).toEqual({ type: "imageUrls", urls: {}, missing: ["images/x.png"] });
  await settleAll((path) =>
    path.endsWith("1.png") ? fail("AssetWorkspaceAssetNotFoundError") : fail("RpcClientError"),
  );
  expect(page.sent.at(-1)).toEqual({ type: "imageUrls", urls: {}, missing: [href(1)] });
  state.phase = "reconnecting";
  await page.rerender();
  state.phase = "connected";
  await page.rerender();
  expect(state.calls.map((call) => call.path)).toEqual([href(2).slice(1)]);
});

it("settles read-view images that will never load and throws while offline", async () => {
  {
    await using page = await setup();
    expect(await page.hooks().source({ href: "images/x.png", alt: null, title: null })).toBeNull();
    const video = { href: "/.attachments/00000000000000aa.mp4", alt: null, title: null };
    expect(await page.hooks().source(video)).toBeNull();
    expect(state.calls).toEqual([]);
    const pending = page.hooks().source({ href: href(1), alt: null, title: null });
    await settleAll(() => fail("AssetWorkspaceAssetNotFoundError"));
    expect(await pending).toBeNull();
  }
  await using offline = await setup("offline");
  await expect(offline.hooks().source({ href: href(1), alt: null, title: null })).rejects.toThrow();
});

it("opens attachments in the app's viewer and other links outside", async () => {
  await using page = await setup();
  page.hooks().open("https://example.com");
  expect(state.external).toEqual(["https://example.com"]);
  page.hooks().open("/.attachments/0123456789abcdef.pdf");
  await settleAll(() => succeed({ relativeUrl: "/api/assets/t/f.pdf", expiresAt: 0 }));
  await act(async () => {});
  expect(state.opened).toEqual([
    {
      uri: "https://hub.example/api/assets/t/f.pdf",
      name: "0123456789abcdef.pdf",
      mimeType: "application/pdf",
    },
  ]);
});

it("hands back a working URL instead of minting, and mints afresh after a reconnect", async () => {
  await using page = await setup();
  page.hooks().resolve([href(1)], false);
  await settleAll(() => succeed({ relativeUrl: "/a", expiresAt: NOW + 3_600_000 }));
  page.hooks().resolve([href(1)], true);
  expect(state.calls).toHaveLength(0);
  expect(page.sent.at(-1)).toEqual({
    type: "imageUrls",
    urls: { [href(1)]: "https://hub.example/a" },
    missing: [],
  });
  state.phase = "reconnecting";
  await page.rerender();
  state.phase = "connected";
  await page.rerender();
  expect(state.calls.map((call) => call.path)).toEqual([href(1).slice(1)]);
});

it("retries a mint that failed across a reconnect once the connection is back", async () => {
  await using page = await setup();
  page.hooks().resolve([href(1)], false);
  state.phase = "reconnecting";
  await page.rerender();
  state.phase = "connected";
  await page.rerender();
  await settleAll(() => fail("RpcClientError"));
  expect(state.calls.map((call) => call.path)).toEqual([href(1).slice(1)]);
  await settleAll(() => fail("RpcClientError"));
  expect(state.calls).toHaveLength(0);
});

it("gives viewers a real type for plain files", () => {
  expect(noteFileMimeType("0123456789abcdef.txt")).toBe("text/plain");
  expect(noteFileMimeType("0123456789abcdef.pdf")).toBe("application/pdf");
  expect(noteFileMimeType("0123456789abcdef.m4a")).toMatch(/^audio\//);
  expect(noteFileMimeType("0123456789abcdef.bin")).toBe("application/octet-stream");
});
