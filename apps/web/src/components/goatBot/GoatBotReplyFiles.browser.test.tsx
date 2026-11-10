import type { GoatBotRow } from "@goat/client-runtime/goatBot";
import { EnvironmentId } from "@goat/contracts";
import * as Base64 from "effect/encoding/Base64";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({ listed: 0, reads: [] as Array<string> }));
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
              artifacts: [
                {
                  relativePath: "reports/summary.md",
                  size: 30,
                  modifiedAt: "2026-11-07T10:00:00.000Z",
                },
              ],
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
      const bytes = new TextEncoder().encode("# Weekly summary\nThree merged.");
      return {
        _tag: "Success",
        value: {
          status: "chunk",
          relativePath: input.relativePath,
          mimeType: "text/markdown",
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
  await expect.element(card.getByText(/Three merged/)).toBeInTheDocument();
  await userEvent.click(card);
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ relativePath: "reports/summary.md" }),
  );
  expect(state.reads).toEqual(["reports/summary.md"]);
  expect(state.listed).toBeGreaterThan(0);
});

it("a reply whose code names no file asks the server for nothing", async () => {
  state.listed = 0;
  state.reads = [];
  await using screen = await render(
    <GoatBotOpenFileContext value={{ environmentId: EnvironmentId.make("env"), open: () => {} }}>
      <GoatBotTimeline rows={[reply("plain", "Run `vp test` next.")]} onRetry={() => {}} />
    </GoatBotOpenFileContext>,
    { router: false }, // This reply has no links.
  );
  await expect.element(screen.getByText(/next\./)).toBeVisible();
  expect(state.listed).toBe(0);
  expect(state.reads).toEqual([]);
});
