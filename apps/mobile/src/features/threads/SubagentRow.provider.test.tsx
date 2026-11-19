import { ThreadId, ProviderInstanceId, ProviderDriverKind } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  nativeEnv,
} from "../../testing/memoryNativeHarness";

vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <span>icon:{props.name}</span>,
}));
vi.mock("../../components/ProviderIcon", () => ({
  ProviderIcon: (props: { provider: string }) => <span>provider:{props.provider}</span>,
  ProviderInstanceIcon: () => <span>instance</span>,
}));
vi.mock("./SubagentStatusDot", () => ({
  SubagentStatusDot: () => null,
  SUBAGENT_TONE_TEXT_CLASS: {},
}));
import { SubagentRow } from "./SubagentRow";

it("uses a neutral glyph when a remote child's provider is unknown", async () => {
  const h = createNativeMemoryHarness();
  const subagent = {
    threadId: ThreadId.make("parent"),
    childThreadId: null,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("unknown-remote"),
    title: "Remote task",
    prompt: "Inspect",
    status: "running" as const,
    result: null,
    model: null,
    remote: { host: "box", threadId: ThreadId.make("remote-child"), correlationId: "rr-A" },
  };
  const view = renderNative(
    h,
    <SubagentRow environmentId={nativeEnv} subagent={subagent} elapsed={null} />,
  );
  try {
    await view.render();
    expect(view.container.textContent).toContain("icon:robot");
    expect(view.container.textContent).not.toContain("provider:codex");
  } finally {
    await view.unmount();
    h.dispose();
  }
});
