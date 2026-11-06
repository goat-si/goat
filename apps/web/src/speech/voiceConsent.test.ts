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
    expect(chooseEnvironmentSpeech(EnvironmentId.make("first"))).toBe(true);
    const grant = readEnvironmentSpeechGrant();
    if (!grant) throw new Error("Grant was not stored");
    failing = true;
    expect(chooseEnvironmentSpeech(null)).toBe(false);
    expect(isEnvironmentSpeechGrantCurrent(grant)).toBe(false);
    expect(readEnvironmentSpeechGrant()).toBeNull();
    expect(chooseEnvironmentSpeech(EnvironmentId.make("second"))).toBe(false);
    expect(readEnvironmentSpeechGrant()).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
