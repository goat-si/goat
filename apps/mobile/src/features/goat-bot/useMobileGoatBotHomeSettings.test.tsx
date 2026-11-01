import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import { EnvironmentId, ProjectId, ThreadId, AuthSettingsWriteScope } from "@goat/contracts";
import type { GoatBotEnvironmentInput } from "@goat/client-runtime/goatBot";
import type { Preferences } from "../../persistence/mobile-preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<GoatBotEnvironmentInput>,
  permitted: true,
  run: vi.fn(),
  readScope: vi.fn(),
  preferences: null as AsyncResult.AsyncResult<Preferences> | null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => harness.preferences ?? AsyncResult.initial(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "claim" }));
vi.mock("@goat/client-runtime/state/runtime", () => ({ runAtomCommand: harness.run }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: "registry" }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "updateSettings" } }));
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => new Set(harness.environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: (id: EnvironmentId, scope: string) => {
    harness.readScope(id, scope);
    return harness.permitted;
  },
}));
vi.mock("./useMobileGoatBotEnvironments", () => ({
  useMobileGoatBotEnvironments: () => harness.environments,
}));
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";
import { MobileGoatBotHomeWorker } from "./MobileGoatBotHomeWorker";

const id = EnvironmentId.make("A");
const claim = { environmentId: id, claimedAt: 10, claimId: "claim" };
let root: Root | null = null;
let settings: ReturnType<typeof useMobileGoatBotHomeSettings>;
function Consumer() {
  const value = useMobileGoatBotHomeSettings();
  useLayoutEffect(() => {
    settings = value;
  }, [value]);
  return null;
}
async function render(worker = false) {
  root ??= createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(
      <>
        <Consumer />
        {worker && <MobileGoatBotHomeWorker />}
      </>,
    );
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.environments = [
    {
      environmentId: id,
      connected: true,
      primary: false,
      supportsChannelLedger: true,
      homeTarget: {
        environmentId: id,
        connected: true,
        supportsHome: true,
        supportsBot: true,
        settingsLoaded: true,
        home: null,
      },
    },
  ];
  harness.permitted = true;
  harness.preferences = AsyncResult.success({});
  harness.run.mockReset().mockResolvedValue({ _tag: "Success" });
  harness.readScope.mockClear();
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
});
describe("mobile GOAT Bot home settings writes", () => {
  it("waits for preferences before claiming the stored bot's B home", async () => {
    const b = EnvironmentId.make("B");
    const a = harness.environments[0]!;
    harness.environments = [
      a,
      { ...a, environmentId: b, homeTarget: { ...a.homeTarget!, environmentId: b } },
    ];
    harness.preferences = AsyncResult.initial();
    await render(true);
    expect(harness.run).not.toHaveBeenCalled();

    harness.preferences = AsyncResult.success({
      goatBotRef: {
        environmentId: b,
        projectId: ProjectId.make("project"),
        threadId: ThreadId.make("bot"),
      },
    });
    await render(true);
    expect(harness.run).toHaveBeenCalledTimes(2);
    for (const environmentId of [id, b]) {
      expect(harness.run).toHaveBeenCalledWith("registry", "updateSettings", {
        environmentId,
        input: { patch: { goatBotHome: expect.objectContaining({ environmentId: b }) } },
      });
    }
  });
  it("checks settings scope at execution even after the rendered writable set granted it", async () => {
    await render();
    expect(settings.writableIds.has(id)).toBe(true);
    harness.permitted = false;
    expect(await settings.write(id, claim)).toBe(false);
    expect(harness.readScope).toHaveBeenCalledWith(id, AuthSettingsWriteScope);
    expect(harness.run).not.toHaveBeenCalled();
  });
  it("uses the server patch command and acknowledges only Success", async () => {
    await render();
    expect(await settings.write(id, claim)).toBe(true);
    expect(harness.run).toHaveBeenCalledWith("registry", "updateSettings", {
      environmentId: id,
      input: { patch: { goatBotHome: claim } },
    });
    harness.run.mockResolvedValue({ _tag: "Failure" });
    expect(await settings.write(id, claim)).toBe(false);
    harness.run.mockRejectedValue(new Error("offline"));
    expect(await settings.write(id, claim)).toBe(false);
  });
  it("never writes to a disconnected or unsupported target", async () => {
    for (const patch of [{ connected: false }, { supportsHome: false }]) {
      harness.environments = harness.environments.map((entry) => ({
        ...entry,
        homeTarget: { ...entry.homeTarget!, ...patch },
      }));
      await render();
      expect(await settings.write(id, claim)).toBe(false);
    }
    expect(harness.run).not.toHaveBeenCalled();
  });
});
