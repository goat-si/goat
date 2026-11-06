import { expect, it } from "vite-plus/test";
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
