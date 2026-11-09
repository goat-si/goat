import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@goat/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const codex = ProviderInstanceId.make("codex");
const state = vi.hoisted(() => ({
  supported: true,
  permitted: true,
  run: vi.fn(async (..._args: unknown[]) => ({ _tag: "Success" as string })),
  alert: vi.fn(),
}));
const provider: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [
    { slug: "luna", name: "GPT-6-Luna", isCustom: false, isDefault: true, capabilities: null },
    { slug: "astra", name: "GPT-6-Astra", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.permitted }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/channels", () => ({
  channelEnvironment: { updateBot: { permissionAtom: () => "permission" } },
}));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  runAtomCommand: state.run,
  squashAtomCommandFailure: () => new Error("The bot is gone."),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    presentationById: new Map([
      [
        "env",
        {
          serverConfig: {
            environment: { capabilities: { goatBotMemberModelEdit: state.supported } },
          },
        },
      ],
    ]),
  }),
}));
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: { instanceId: codex, model: "luna" },
    },
    providers: [provider],
  }),
}));
import {
  useMobileGoatBotMemberModelMenu,
  type MobileGoatBotMemberModelMenu,
} from "./useMobileGoatBotMemberModel";

const research = {
  botId: "research",
  environmentId: "env",
  name: "Research",
  defaultModelSelection: null,
} as unknown as Parameters<typeof useMobileGoatBotMemberModelMenu>[0];

async function menuOf(): Promise<MobileGoatBotMemberModelMenu> {
  let menu: MobileGoatBotMemberModelMenu | null = null;
  function Probe(props: { readonly onRead: (value: typeof menu) => void }) {
    props.onRead(useMobileGoatBotMemberModelMenu(research, "Goaty"));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe onRead={(value) => (menu = value)} />));
  await act(async () => root.unmount());
  if (menu === null) throw new Error("The menu did not render.");
  return menu;
}

it("sends a member's new model where the server takes it, and says when that failed", async () => {
  state.supported = true;
  state.permitted = true;
  state.run.mockClear();
  const menu = await menuOf();
  expect(menu).toMatchObject({ label: "GPT-6-Luna", canChange: true, title: "Research's model" });
  menu.select("same");
  expect(state.run).not.toHaveBeenCalled();
  state.run.mockResolvedValueOnce({ _tag: "Failure" });
  await act(async () => menu.select("codex:astra"));
  expect(state.run).toHaveBeenCalledWith({}, expect.anything(), {
    environmentId: "env",
    input: { botId: "research", defaultModelSelection: { instanceId: codex, model: "astra" } },
  });
  expect(state.alert).toHaveBeenCalledWith("Couldn't change Research's model", expect.any(String));
});

it("shows the model read-only, with the reason, on an older server or without permission", async () => {
  state.run.mockClear();
  state.supported = false;
  const older = await menuOf();
  expect(older).toMatchObject({
    label: "GPT-6-Luna",
    canChange: false,
    title: "Update GOAT on Research's computer to change its model",
  });
  older.select("codex:astra");
  state.supported = true;
  state.permitted = false;
  const viewer = await menuOf();
  expect(viewer).toMatchObject({ canChange: false, title: "You can't change Research's model" });
  viewer.select("codex:astra");
  expect(state.run).not.toHaveBeenCalled();
  state.permitted = true;
});
