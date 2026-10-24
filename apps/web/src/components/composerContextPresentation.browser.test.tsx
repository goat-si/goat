import {
  PrimaryConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@goat/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { ThreadContextChip } from "./ThreadContextChip";
import { render } from "../../test/render";
import { threadContextRecord } from "~/lib/composerContextRecords";

const boundary = vi.hoisted(() => ({ phase: "connected" }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => undefined,
  useProject: () => undefined,
}));
vi.mock("~/state/presentation", () => ({ useEnvironmentConnectionPhase: () => boundary.phase }));
vi.mock("~/connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: { catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }) },
  };
});
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./contextChipParts", () => ({
  ContextChipPopover: () => null,
  ContextChipShell: () => null,
  FileChip: () => null,
  ImageChipButton: () => null,
  PULL_REQUEST_CHIP_KINDS: {},
  PullRequestChip: () => null,
  UnresolvedChip: () => null,
}));
vi.mock("./ChatMarkdown", () => ({ default: () => null }));
vi.mock("./files/AttachmentFilePreview", () => ({ ReadOnlySourcePreview: () => null }));

import { environmentCatalog } from "~/connection/catalog";
import {
  ComposerContextActionsContext,
  ComposerContextRecordsContext,
  ComposerContextReferenceChip,
} from "./composerContextPresentation";

function setup() {
  boundary.phase = "connected";
}

it("keeps an SSH thread readable across disconnect and reconnect", async () => {
  setup();
  const previousBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  using _bridge = {
    [Symbol.dispose]() {
      if (previousBridge) Object.defineProperty(window, "desktopBridge", previousBridge);
      else delete window.desktopBridge;
    },
  };
  const local = EnvironmentId.make("desktop");
  const remote = EnvironmentId.make("remote");
  const record = {
    ...threadContextRecord(
      { environmentId: remote, threadId: ThreadId.make("work") },
      "Remote work",
    ),
    host: "stale-alias",
  };
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const entries = new Map<EnvironmentId, ConnectionCatalogEntry>([
    [
      local,
      {
        target: new PrimaryConnectionTarget({
          environmentId: local,
          label: "This computer",
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost",
        }),
        profile: Option.none(),
        enabled: true,
      },
    ],
    [
      remote,
      {
        target: new SshConnectionTarget({
          environmentId: remote,
          connectionId: "ssh",
          label: "Friendly label",
        }),
        profile: Option.some(
          new SshConnectionProfile({
            environmentId: remote,
            connectionId: "ssh",
            label: "Friendly label",
            target: { alias: "build-box", hostname: "example.invalid", username: null, port: null },
          }),
        ),
        enabled: true,
      },
    ],
  ]);
  registry.set(
    environmentCatalog.catalogValueAtom as Atom.Writable<{
      isReady: boolean;
      entries: typeof entries;
    }>,
    { isReady: true, entries },
  );
  const ui = (environmentId = local) => (
    <RegistryContext.Provider value={registry}>
      <ComposerContextActionsContext
        value={{
          environmentId,
          expandImage() {},
          expandVideo() {},
          openFile() {},
          openMention() {},
          openPullRequest() {},
        }}
      >
        <ComposerContextRecordsContext
          value={new Map([[record.contextId, { kind: "thread", record }]])}
        >
          <ComposerContextReferenceChip
            kind="thread"
            contextId={record.contextId}
            label="Remote work"
          />
        </ComposerContextRecordsContext>
      </ComposerContextActionsContext>
    </RegistryContext.Provider>
  );
  await using screen = await render(ui());
  const chip = screen.getByRole("link");
  await expect.element(chip).toMatchTextContent(/build-box/);
  await expect.element(chip).not.toHaveAttribute("data-state", "invalid");
  await expect.element(chip).not.toMatchTextContent(/stale-alias/);
  boundary.phase = "reconnecting";
  await screen.rerender(ui());
  await expect.element(chip).toHaveAttribute("data-state", "unavailable");
  await expect.element(chip).toMatchTextContent(/Host not connected/);
  await chip.hover();
  await expect
    .element(
      page.getByText(
        "Host build-box is not connected. The connection is unavailable or reconnecting; the agent can still try reading it over SSH.",
      ),
    )
    .toBeVisible();
  boundary.phase = "connected";
  await screen.rerender(ui());
  await expect.element(chip).not.toHaveAttribute("data-state", "unavailable");
  await screen.rerender(ui(EnvironmentId.make("unrelated")));
  await expect.element(chip).toHaveAttribute("data-state", "invalid");
  await expect.element(chip).not.toMatchTextContent(/build-box/);
  await screen.rerender(ui());
  registry.set(
    environmentCatalog.catalogValueAtom as Atom.Writable<{
      isReady: boolean;
      entries: typeof entries;
    }>,
    { isReady: true, entries: new Map([[local, entries.get(local)!]]) },
  );
  await expect.element(chip).toHaveAttribute("data-state", "invalid");
  await screen.rerender(
    <ThreadContextChip
      record={{ ...record, host: "build-box" }}
      copyMarkdown="[Remote](goat-context://v1/thread/thread_work)"
    />,
  );
  await expect.element(screen.getByRole("link")).toMatchTextContent(/build-box/);
  await expect.element(screen.getByRole("link")).not.toHaveAttribute("data-state", "invalid");
  await expect
    .element(screen.getByRole("link"))
    .toHaveAttribute("data-markdown-copy", "[Remote](goat-context://v1/thread/thread_work)");
});
