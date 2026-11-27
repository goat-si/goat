import { EnvironmentId, ThreadId } from "@goat/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import "../index.css";
import { filesystemEnvironment } from "../state/filesystem";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
const nativeFileDrag = vi.hoisted(() => ({ enabled: false }));
vi.mock(import("../useNativeFileDrag"), async (original) => {
  const actual = await original();
  return {
    useNativeFileDrag: (...args: Parameters<typeof actual.useNativeFileDrag>) => {
      const drag = actual.useNativeFileDrag(...args);
      return nativeFileDrag.enabled ? { ...drag, draggable: true } : drag;
    },
  };
});
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => noConfig) as never,
    },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@goat/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useRenderedAppearance: () => "light" as const,
}));

import ChatMarkdown from "./ChatMarkdown";

function setup() {
  nativeFileDrag.enabled = false;
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

describe("ChatMarkdown draggable file chip selection", () => {
  it("selects the whole line on triple-click beside a desktop-draggable inline-code file chip", async () => {
    setup();
    // Desktop on macOS and Windows makes local file chips draggable for native file drags.
    nativeFileDrag.enabled = true;
    filesystemMetadata.mockResolvedValue(AsyncResult.success({ entries: [{ kind: "file" }] }));
    await using screen = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text="The template (`config/app.yaml.example`) and two docs still say 5 fps."
        threadRef={{
          environmentId: EnvironmentId.make("workspace"),
          threadId: ThreadId.make("thread"),
        }}
      />,
    );
    await vi.waitFor(() =>
      expect(
        screen.container.querySelector("a.chat-markdown-file-link")?.getAttribute("draggable"),
      ).toBe("true"),
    );
    const paragraph = screen.container.querySelector("p")!;
    const text = [...paragraph.childNodes].find((node) =>
      node.textContent?.includes("and two docs"),
    )!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.indexOf("and"));
    range.setEnd(text, text.textContent!.indexOf("and") + 3);
    const wordBox = range.getBoundingClientRect();
    const paragraphBox = paragraph.getBoundingClientRect();
    await userEvent.tripleClick(paragraph, {
      position: {
        x: wordBox.left - paragraphBox.left + wordBox.width / 2,
        y: wordBox.top - paragraphBox.top + wordBox.height / 2,
      },
    });
    expect(window.getSelection()?.toString().trim()).toBe(paragraph.textContent?.trim());
  });
});
