import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  resolveGoatBotHome,
  type GoatBotHomeResolution,
  type GoatBotHomeTarget,
} from "@goat/client-runtime/goatBot/home";
import { EnvironmentId, type GoatBotHomeClaim } from "@goat/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  home: {
    supported: true,
    preferencesLoaded: true,
    targets: [] as ReadonlyArray<GoatBotHomeTarget>,
    resolution: { state: "unclaimed" } as GoatBotHomeResolution,
    candidateId: null as EnvironmentId | null,
    writableIds: new Set<EnvironmentId>(),
    write: vi.fn<(id: EnvironmentId, claim: GoatBotHomeClaim) => Promise<boolean>>(),
  },
  reads: 0,
  randomId: vi.fn(() => "claim"),
}));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => {
    harness.reads++;
    return harness.home;
  },
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: harness.randomId }));
import { MobileGoatBotHomeWorker } from "./MobileGoatBotHomeWorker";

let root: Root | null;
const id = EnvironmentId.make("A");
async function render() {
  if (root === null) root = createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(
      <StrictMode>
        <MobileGoatBotHomeWorker />
      </StrictMode>,
    );
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(100);
  harness.randomId.mockClear();
  harness.home = {
    supported: true,
    preferencesLoaded: true,
    targets: [
      {
        environmentId: id,
        connected: true,
        supportsHome: true,
        supportsBot: true,
        settingsLoaded: true,
        home: null,
      },
    ],
    resolution: { state: "unclaimed" },
    candidateId: id,
    writableIds: new Set([id]),
    write: vi.fn(async () => true),
  };
  harness.reads = 0;
  root = null;
});
afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  vi.useRealTimers();
});
describe("mobile GOAT Bot home worker lifetime", () => {
  it("claims once through Strict Mode and ignores completion after cleanup", async () => {
    let resolve!: (success: boolean) => void;
    harness.home.write.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render();
    expect(harness.home.write).toHaveBeenCalledTimes(1);
    expect(harness.randomId).toHaveBeenCalledTimes(1);
    await act(async () => {
      root!.unmount();
    });
    root = null;
    const reads = harness.reads;
    await act(async () => {
      resolve(false);
    });
    expect(harness.reads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps retries alive on reactivation and clears its backoff timer on unmount", async () => {
    harness.home.write.mockResolvedValue(false);
    await render();
    expect(harness.home.write).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(harness.home.write.mock.calls.length).toBeGreaterThan(1);
    await act(async () => {
      root!.unmount();
    });
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries with the latest writer when foreground reconnects during backoff", async () => {
    harness.home.write.mockResolvedValue(false);
    await render();
    const nextWrite = vi.fn(async () => true);
    const disconnected = harness.home.targets.map((target) => ({ ...target, connected: false }));
    harness.home = {
      ...harness.home,
      targets: disconnected,
      resolution: resolveGoatBotHome({ targets: disconnected }),
      write: nextWrite,
    };
    await render();
    const connected = disconnected.map((target) => ({ ...target, connected: true }));
    harness.home = {
      ...harness.home,
      targets: connected,
      resolution: resolveGoatBotHome({ targets: connected }),
    };
    await render();
    expect(nextWrite).toHaveBeenCalledTimes(1);
    expect(harness.randomId).toHaveBeenCalledTimes(1);
  });
});
