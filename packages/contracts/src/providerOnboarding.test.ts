import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId } from "./providerInstance.ts";
import { redactProviderAuthState } from "./providerOnboarding.ts";
import type { ProviderAuthState } from "./providerSetup.ts";

const SECRET = "sk-live-SECRET-0123456789";
const base: ProviderAuthState = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  phase: "waiting",
  flowId: "flow-1",
  authorizationUrl: `https://auth.example.com/authorize?state=${SECRET}`,
  expiresAt: null,
  message: null,
  interaction: null,
  credentialOwner: "provider",
};

describe("redactProviderAuthState", () => {
  it("keeps a device code and its verification URL", () => {
    const flow = redactProviderAuthState({
      ...base,
      interaction: {
        type: "deviceCode",
        id: "device",
        url: "https://auth.example.com/device",
        userCode: "ABCD-EFGH",
      },
    });
    expect(flow.continueIn).toBe("device");
    expect(flow.deviceCode).toEqual({
      url: "https://auth.example.com/device",
      userCode: "ABCD-EFGH",
    });
  });

  it("drops a device URL that is not plain https", () => {
    const flow = redactProviderAuthState({
      ...base,
      interaction: {
        type: "deviceCode",
        id: "device",
        url: `https://user:${SECRET}@auth.example.com/device`,
        userCode: "ABCD",
      },
    });
    expect(flow.deviceCode).toBeNull();
    expect(JSON.stringify(flow)).not.toContain(SECRET);
  });

  it.each([
    {
      type: "browser",
      id: "b",
      url: `https://auth.example.com/cb?code=${SECRET}`,
      requiresConsent: true,
    },
    { type: "terminal", id: "t", output: `Paste this: ${SECRET}` },
    { type: "credentials", id: "c", fields: [{ name: SECRET, label: "API key", secret: true }] },
  ] as const)("never serializes $type interaction data", (interaction) => {
    const flow = redactProviderAuthState({ ...base, interaction });
    expect(flow.continueIn).toBe("app");
    expect(flow.deviceCode).toBeNull();
    expect(JSON.stringify(flow)).not.toContain(SECRET);
  });

  it("keeps only the user code in a device URL query", () => {
    const flow = redactProviderAuthState({
      ...base,
      interaction: {
        type: "deviceCode",
        id: "device",
        url: `https://auth.example.com/device?user_code=ABCD&code=${SECRET}#${SECRET}`,
        userCode: "ABCD",
      },
    });
    expect(flow.deviceCode?.url).toBe("https://auth.example.com/device?user_code=ABCD");
  });

  it("replaces driver message text with fixed phase text", () => {
    const flow = redactProviderAuthState({
      ...base,
      phase: "failed",
      message: `Callback failed: https://localhost/cb?code=${SECRET}`,
    });
    expect(flow.message).not.toContain(SECRET);
  });

  it("reports no continuation once the flow has ended", () => {
    expect(redactProviderAuthState({ ...base, phase: "succeeded" }).continueIn).toBeNull();
  });
});
