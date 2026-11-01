import type { EnvironmentId, ThreadId } from "@goat/contracts";
import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/MemorySettings", () => ({ MemorySettingsEntry: () => null }));
// The notes button has its own tests; its data layer stays out of the header render.
vi.mock("../../notes/ThreadNotesButton", () => ({ ThreadNotesButton: () => null }));
vi.mock("../preview/sessions/AgentScreenCardsToggle", () => ({
  AgentScreenCardsToggle: () => null,
}));

vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => () => Promise.resolve({ _tag: "Success" }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => () => Promise.resolve({ _tag: "Success" }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => undefined,
}));
vi.mock("../ProjectFavicon", () => ({
  ProjectFavicon: () => null,
}));
vi.mock("../goatBot/GoatBotModeButton", () => ({
  GoatBotModeButton: () => null,
}));

import { ChatHeader } from "./ChatHeader";

const project = {
  title: "No project",
  workspaceRoot: "/tmp/scratch",
} as unknown as EnvironmentProject;

function renderHeader(input: { globalAgent: boolean }) {
  return renderToStaticMarkup(
    <ChatHeader
      activeThreadEnvironmentId={"environment:local" as EnvironmentId}
      activeThreadId={"thread:global" as ThreadId}
      activeThreadTitle="Casual greeting"
      displayTitle={input.globalAgent ? "Global agent" : undefined}
      globalAgent={input.globalAgent}
      isServerThread
      activeProject={project}
      parentThreadLink={null}
      onOpenThread={() => {}}
      rightPanelOpen={false}
      onNewThreadInProject={() => {}}
    />,
  );
}

describe("ChatHeader global agent", () => {
  it("shows the global agent without the no-project crumb", () => {
    const markup = renderHeader({ globalAgent: true });
    expect(markup).not.toContain("New thread in No project");
    expect(markup).toContain("data-global-agent-mark");
    expect(markup).toContain("Global agent");
    expect(markup).not.toContain("Casual greeting");
  });

  it("keeps the project crumb for an ordinary thread", () => {
    const markup = renderHeader({ globalAgent: false });
    expect(markup).toContain("New thread in No project");
    expect(markup).not.toContain("data-global-agent-mark");
    expect(markup).toContain("Casual greeting");
  });
});
