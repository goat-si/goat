import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  armConnectFlowResume,
  cancelConnectFlowResume,
  CONNECT_FLOW_RESUME_TTL_MS,
  finishConnectFlowResume,
  peekConnectFlowResume,
  requestConnectFlowResume,
} from "./connectFlowResume";

const NOW = Date.UTC(2026, 9, 30, 12);
const PREVIOUS_LAUNCH = "previous-renderer-load";

beforeEach(() => {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  } satisfies Storage;
  vi.stubGlobal("window", { localStorage: storage });
  cancelConnectFlowResume();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not resume in the launch that armed it, so a relaunch that never happens cannot fire", () => {
  requestConnectFlowResume("phone-qr");
  armConnectFlowResume(NOW);
  expect(peekConnectFlowResume(NOW)).toBeNull();
});

it("resumes the requested flow in the next launch until that flow finishes", () => {
  requestConnectFlowResume("phone-qr");
  armConnectFlowResume(NOW, PREVIOUS_LAUNCH);
  expect(peekConnectFlowResume(NOW + 5_000)).toBe("phone-qr");
  finishConnectFlowResume("pairing-link");
  expect(peekConnectFlowResume(NOW + 5_000)).toBe("phone-qr");
  finishConnectFlowResume("phone-qr");
  expect(peekConnectFlowResume(NOW + 5_000)).toBeNull();
});

it("returns to Connections after the plain switch and after a cancelled flow", () => {
  armConnectFlowResume(NOW, PREVIOUS_LAUNCH);
  expect(peekConnectFlowResume(NOW)).toBe("connections");
  requestConnectFlowResume("pairing-link");
  cancelConnectFlowResume();
  armConnectFlowResume(NOW, PREVIOUS_LAUNCH);
  expect(peekConnectFlowResume(NOW)).toBe("connections");
});

it("ignores a note older than the resume window", () => {
  requestConnectFlowResume("pairing-link");
  armConnectFlowResume(NOW, PREVIOUS_LAUNCH);
  expect(peekConnectFlowResume(NOW + CONNECT_FLOW_RESUME_TTL_MS + 1)).toBeNull();
});
