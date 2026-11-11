import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId } from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({
  listed: 0,
  reads: [] as Array<string>,
  // Saved files by path: their type and contents; summary.md unless a test sets others.
  files: new Map<string, { readonly mimeType: string; readonly text: string }>(),
  // The listing's artifacts folder; undefined is an older server that does not send it.
  root: undefined as string | undefined,
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
vi.mock("~/state/channels", async (original) => {
  const real = await original<typeof import("~/state/channels")>();
  return {
    ...real,
    channelEnvironment: { ...real.channelEnvironment, listBotArtifacts: () => "artifacts" },
  };
});
vi.mock("~/state/query", async (original) => ({
  ...(await original<typeof import("~/state/query")>()),
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === "artifacts") state.listed += 1;
    return {
      data:
        atom === "artifacts"
          ? {
              ...(state.root === undefined ? {} : { root: state.root }),
              artifacts: (state.files.size === 0
                ? ["reports/summary.md"]
                : [...state.files.keys()]
              ).map((relativePath) => ({
                relativePath,
                size: 30,
                modifiedAt: "2026-11-07T10:00:00.000Z",
              })),
              truncated: false,
            }
          : null,
      failure: null,
      error: null,
      isPending: false,
      isSuccess: true,
      refresh: () => {},
    };
  },
}));
vi.mock("~/state/use-atom-command", async (original) => ({
  ...(await original<typeof import("~/state/use-atom-command")>()),
  useAtomCommand:
    () =>
    async ({ input }: { input: { relativePath: string } }) => {
      state.reads.push(input.relativePath);
      const file = state.files.get(input.relativePath) ?? SUMMARY;
      const bytes = new TextEncoder().encode(file.text);
      return {
        _tag: "Success",
        value: {
          status: "chunk",
          relativePath: input.relativePath,
          mimeType: file.mimeType,
          size: bytes.length,
          offset: 0,
          bytesBase64: Base64.encode(bytes),
          version: "v1",
          done: true,
        },
      };
    },
}));
import { GoatBotOpenFileContext } from "./GoatBotReplyFiles";
import { GoatBotTimeline } from "./GoatBotTimeline";

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
  state.listed = 0;
  state.reads = [];
  state.files = new Map();
  const open = vi.fn();
  await using screen = await render(
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open }}>
      <GoatBotTimeline
        rows={[
          reply("plain", "Run `vp test` next."),
          reply("saved", "I saved the summary as `reports/summary.md`."),
        ]}
        onRetry={() => {}}
      />
    </GoatBotOpenFileContext>,
    { router: false }, // These replies have no links.
  );
  const card = screen.getByRole("button", { name: "Open summary.md" });
  await expect.element(card).toBeVisible();
  await expect.element(screen.getByText(/Three merged/)).toBeInTheDocument();
  await userEvent.click(card);
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ relativePath: "reports/summary.md" }),
  );
  expect(state.reads).toEqual(["reports/summary.md"]);
  expect(state.listed).toBeGreaterThan(0);
});

it("a reply whose code no listed file can match asks the server for nothing", async () => {
  state.listed = 0;
  state.reads = [];
  state.files = new Map();
  await using screen = await render(
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
      <GoatBotTimeline
        rows={[reply("plain", "Set `HOST:PORT` in `.env` next.")]}
        onRetry={() => {}}
      />
    </GoatBotOpenFileContext>,
    { router: false }, // This reply has no links.
  );
  await expect.element(screen.getByText(/next\./)).toBeVisible();
  expect(state.listed).toBe(0);
  expect(state.reads).toEqual([]);
});

const ROOT = "/srv/goat/userdata/goat-bot/artifacts";

it("a full path gets a card only when it is inside this server's artifacts folder", async () => {
  state.listed = 0;
  state.reads = [];
  state.files = new Map();
  state.root = ROOT;
  await using screen = await render(
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
      <GoatBotTimeline
        rows={[
          reply("other", "The other machine wrote `/other/artifacts/reports/summary.md`."),
          reply("climb", `Also \`${ROOT}/../../x/artifacts/reports/summary.md\`.`),
          reply("own", `I saved \`${ROOT}/reports/summary.md\`.`),
        ]}
        onRetry={() => {}}
      />
    </GoatBotOpenFileContext>,
    { router: false }, // These replies have no links.
  );
  await expect.element(screen.getByRole("button", { name: "Open summary.md" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open summary.md" }).elements()).toHaveLength(1);
  expect(state.reads).toEqual(["reports/summary.md"]);
});

it("an older server's listing keeps cards for relative names, extensionless too, and none for full paths", async () => {
  state.listed = 0;
  state.reads = [];
  state.files = new Map([
    ["README", { mimeType: "application/octet-stream", text: "read me" }],
    ["reports/summary.md", SUMMARY],
  ]);
  state.root = undefined;
  await using screen = await render(
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
      <GoatBotTimeline
        rows={[
          reply("full", `Saved \`${ROOT}/reports/summary.md\`.`),
          reply("bare", "Saved `README`."),
        ]}
        onRetry={() => {}}
      />
    </GoatBotOpenFileContext>,
    { router: false }, // These replies have no links.
  );
  await expect.element(screen.getByRole("button", { name: "Open README" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open summary.md" }).elements()).toHaveLength(0);
  expect(state.reads).toEqual(["README"]);
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
  state.listed = 0;
  state.reads = [];
  state.files = new Map([
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
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
      <GoatBotTimeline rows={[reply("saved", "Saved `reports/tracked.md`.")]} onRetry={() => {}} />
    </GoatBotOpenFileContext>,
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
  state.listed = 0;
  state.reads = [];
  state.files = new Map([
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
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
      <GoatBotTimeline rows={[reply("saved", "Saved `charts/plot.svg`.")]} onRetry={() => {}} />
    </GoatBotOpenFileContext>,
    { router: false }, // This reply has no links.
  );
  const card = screen.getByRole("button", { name: "Open plot.svg" }).element().parentElement;
  if (card === null) throw new Error("expected the file card");
  await vi.waitFor(() => expect(card.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/));
  const image = card.querySelector("img");
  await vi.waitFor(() => expect(image?.complete).toBe(true));
  // The file is never put in the page as markup: only the card's own icon is an svg.
  expect(card.querySelector("[inert] svg, script")).toBeNull();
  expect(document.title).toBe(title);
  expect(fetchedFrom(card)).toEqual({ elements: [], requests: [] });
});
