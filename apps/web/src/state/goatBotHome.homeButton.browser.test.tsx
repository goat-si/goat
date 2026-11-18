import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";

const port = vi.hoisted(() => ({ answer: "confirm" as "confirm" | "fail" }));
// The rest of the app reads the real presentation module; only the machines are the test's.
vi.mock("./presentation", async (importOriginal) => {
  const original = await importOriginal<typeof import("./presentation")>();
  const { Atom: A } = await import("effect/reactivity");
  return {
    ...original,
    environmentPresentations: {
      ...original.environmentPresentations,
      presentationsAtom: A.make(new Map()),
    },
  };
});
vi.mock("./environmentProjection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./environmentProjection")>()),
  projectEnvironmentPresentation: (_environmentId: unknown, presentation: unknown) => presentation,
}));
vi.mock("./primaryEnvironment", async (importOriginal) => {
  const { Atom: A } = await import("effect/reactivity");
  const { EnvironmentId: Id } = await import("@goat/contracts");
  return {
    ...(await importOriginal<typeof import("./primaryEnvironment")>()),
    primaryEnvironmentIdAtom: A.make(Id.make("computer-a")),
  };
});
// The app's one port, answering the chat's ensure as the test decides.
vi.mock("~/components/goatBot/goatBotAppChannelPort", async () => {
  const { EnvironmentId: Id, ProjectId: P, ThreadId: T } = await import("@goat/contracts");
  return {
    goatBotAppChannelPort: {
      ensureBot: async () => {
        if (port.answer === "fail") throw new Error("The bot could not start.");
        return {
          environmentId: Id.make("computer-a"),
          projectId: P.make("p"),
          threadId: T.make("bot"),
        };
      },
      getBotStatus: async () => ({ bot: null, waitingCount: 0 }),
      ingest: async () => {
        throw new Error("not sent");
      },
      listTasks: async () => ({ tasks: [] }),
      useCanSend: () => true,
    },
  };
});
// The chat sees the same machines the Threads atom reads.
vi.mock("~/components/goatBot/goatBotHooks", async () => {
  const { useAtomValue: use } = await import("@effect/atom-react");
  const { EnvironmentId: Id } = await import("@goat/contracts");
  const { environmentPresentations: presentations } = await import("./presentation");
  const { goatBotEnvironmentInputs: inputs } =
    await import("~/components/goatBot/goatBotEnvironmentInputs");
  return {
    useGoatBotEnvironments: () =>
      inputs([...use(presentations.presentationsAtom).values()] as never, Id.make("computer-a")),
    useLegacyGlobalAgentRoute: () => null,
  };
});
// This client cannot write settings, so it never claims an unclaimed Home.
vi.mock("~/components/goatBot/useGoatBotHome", () => ({
  useGoatBotHome: () => undefined,
  useGoatBotHomeSettings: () => ({ moveTarget: null, busy: false, error: null }),
}));
vi.mock("~/components/goatBot/GoatBotModelPicker", () => ({ GoatBotModelPicker: () => null }));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  useThreadShell: () => ({ runtime: { activeRunId: null }, archivedAt: null, deletedAt: null }),
  resolveThreadDetailRef: (ref: unknown) => ref,
  useThreadVisibleTurnItems: () => [],
  useEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));

import { goatBotAppChannelPort } from "~/components/goatBot/goatBotAppChannelPort";
import { GoatBotChatView } from "~/components/goatBot/GoatBotChatView";
import { GoatBotChannelContext } from "~/components/goatBot/goatBotChannelPort";
import { useGoatBotSessions } from "~/components/goatBot/goatBotSessions";
import { useGoatBotSession } from "~/components/goatBot/useGoatBotSession";
import { useGlobalAgentStore } from "~/globalAgentStore";
import { A, B, GOVERNED, hiddenFromThreadsAtom, LEGACY, machine } from "./goatBotHome.test-support";
import { environmentPresentations } from "./presentation";

function setup(answer: "confirm" | "fail") {
  port.answer = answer;
  useGoatBotSessions.setState({ sessions: new Map(), revision: 0 });
  useGlobalAgentStore.setState({ botRef: null });
}

const hiddenAtom = hiddenFromThreadsAtom();

function Chat() {
  const session = useGoatBotSession();
  return <GoatBotChatView {...session} legacyAgentRoute={null} />;
}

/** What Threads hides, read beside the chat from the same registry. */
function HiddenFromThreads() {
  return (
    <output aria-label="Hidden from Threads">
      {[...useAtomValue(hiddenAtom)].toSorted().join(" ")}
    </output>
  );
}

function renderChat(machines: ReturnType<typeof machine>[]) {
  const registry = AtomRegistry.make();
  registry.set(
    environmentPresentations.presentationsAtom as never,
    new Map(machines.map((entry) => [entry.environmentId, entry])),
  );
  return render(
    <RegistryContext.Provider value={registry}>
      <GoatBotChannelContext.Provider value={goatBotAppChannelPort}>
        <Chat />
        <HiddenFromThreads />
      </GoatBotChannelContext.Provider>
    </RegistryContext.Provider>,
    { router: false }, // Only the chat and the hide set render; nothing navigates.
  );
}

const homeButton = () => page.getByRole("button", { name: /home$/ });
const hidden = () => page.getByRole("status", { name: "Hidden from Threads" });

it("hides the coding thread from Threads while the confirmed bot's Home button is enabled", async () => {
  setup("confirm");
  await using _screen = await renderChat([machine(A), machine(B, { home: null })]);
  await expect.element(homeButton()).toBeEnabled();
  await expect.element(hidden()).toHaveTextContent(GOVERNED.join(" "));
});

it("lists the coding thread in Threads when the ensure fails and the Home button stays disabled", async () => {
  setup("fail");
  await using _screen = await renderChat([machine(A), machine(B, { home: null })]);
  await vi.waitFor(() =>
    expect(useGoatBotSessions.getState().sessions.get(A)?.machine.ensure.state).toBe("failed"),
  );
  await expect.element(homeButton()).toBeDisabled();
  await expect.element(hidden()).toHaveTextContent(LEGACY.join(" "));
});

it("lists the coding thread in Threads when the Home is unclaimed and this client cannot claim it", async () => {
  setup("confirm");
  await using _screen = await renderChat([machine(A, { home: null }), machine(B, { home: null })]);
  await expect.element(homeButton()).toBeDisabled();
  await expect.element(hidden()).toHaveTextContent(LEGACY.join(" "));
});
