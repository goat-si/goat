import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import {
  chooseEnvironmentSpeech,
  isEnvironmentSpeechGrantCurrent,
  readEnvironmentSpeechGrant,
} from "./voiceConsent";

it("revokes a recording's consent when the destination is changed or reselected", () => {
  chooseEnvironmentSpeech(null);
  const first = EnvironmentId.make("first");
  chooseEnvironmentSpeech(first);
  const grant = readEnvironmentSpeechGrant();
  if (!grant) throw new Error("Grant was not stored");
  expect(isEnvironmentSpeechGrantCurrent(grant)).toBe(true);
  chooseEnvironmentSpeech(EnvironmentId.make("second"));
  expect(isEnvironmentSpeechGrantCurrent(grant)).toBe(false);
  chooseEnvironmentSpeech(first);
  expect(isEnvironmentSpeechGrantCurrent(grant)).toBe(false);
  const replacement = readEnvironmentSpeechGrant();
  if (!replacement) throw new Error("Grant was not stored");
  expect(isEnvironmentSpeechGrantCurrent(replacement)).toBe(true);
  chooseEnvironmentSpeech(null);
  expect(isEnvironmentSpeechGrantCurrent(replacement)).toBe(false);
});

it("stops using a revoked grant in this tab when storage cannot save the change", () => {
  const items = new Map<string, string>();
  let failing = false;
  const fail = () => {
    if (failing) throw new Error("storage unavailable");
  };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => (fail(), items.set(key, value)),
      removeItem: (key: string) => (fail(), items.delete(key)),
    },
  });
  using _log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(chooseEnvironmentSpeech(EnvironmentId.make("first"))).toBe("saved");
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    failing = true;
    expect(chooseEnvironmentSpeech(null)).toBe("unsaved");
    expect(isEnvironmentSpeechGrantCurrent(grant)).toBe(false);
    expect(readEnvironmentSpeechGrant()).toBeNull();
    expect(chooseEnvironmentSpeech(EnvironmentId.make("second"))).toBe("unsaved");
    expect(readEnvironmentSpeechGrant()).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});

const revocationChannel = "goat:environment-voice-grant:v1:revoked";

it("tells other open tabs to drop a revoked grant", async () => {
  chooseEnvironmentSpeech(EnvironmentId.make("first"));
  const grant = readEnvironmentSpeechGrant();
  if (!grant) throw new Error("Grant was not stored");
  const otherTab = new BroadcastChannel(revocationChannel);
  try {
    const received = new Promise<unknown>((resolve) => {
      otherTab.onmessage = (event) => resolve(event.data);
    });
    chooseEnvironmentSpeech(null);
    expect(await received).toBe(grant.id);
  } finally {
    otherTab.close();
  }
});

it("drops a grant that another tab revoked", async () => {
  chooseEnvironmentSpeech(EnvironmentId.make("first"));
  const grant = readEnvironmentSpeechGrant();
  if (!grant) throw new Error("Grant was not stored");
  const otherTab = new BroadcastChannel(revocationChannel);
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel takes no origin
    otherTab.postMessage(grant.id);
    await vi.waitFor(() => expect(isEnvironmentSpeechGrantCurrent(grant)).toBe(false));
  } finally {
    otherTab.close();
    chooseEnvironmentSpeech(null);
  }
});

it("refuses environment dictation where a revocation cannot reach other tabs", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.resetModules();
  try {
    const isolated = await import("./voiceConsent");
    expect(isolated.chooseEnvironmentSpeech(EnvironmentId.make("first"))).toBe("unsupported");
    expect(isolated.readEnvironmentSpeechGrant()).toBeNull();
    expect(isolated.chooseEnvironmentSpeech(null)).toBe("saved");
  } finally {
    vi.unstubAllGlobals();
  }
  vi.resetModules();
  const reloaded = await import("./voiceConsent");
  expect(reloaded.readEnvironmentSpeechGrant()).toBeNull();
});

it("distinguishes an explicit off choice from a first run", async () => {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    },
  });
  try {
    const { readEnvironmentSpeechChoice } = await import("./voiceConsent");
    expect(readEnvironmentSpeechChoice()).toBeNull();
    expect(chooseEnvironmentSpeech(null)).toBe("saved");
    expect(readEnvironmentSpeechChoice()).toBe("off");
    expect(chooseEnvironmentSpeech(EnvironmentId.make("local"))).toBe("saved");
    expect(readEnvironmentSpeechChoice()).toMatchObject({ environmentId: "local" });
  } finally {
    vi.unstubAllGlobals();
  }
});
