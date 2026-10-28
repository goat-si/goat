import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { RelayDeviceRegistrationRequest, RelayDpopAccessTokenRequest } from "./relay.ts";

const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const decodeDpopRequest = Schema.decodeUnknownExit(RelayDpopAccessTokenRequest);
const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("mobile device platforms", () => {
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});

describe("relay token exchange form", () => {
  const fields = {
    connectAuthPolicyVersion: "1",
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: "session-token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    resource: "https://relay.example.test",
    scope: "environment:connect",
    client_id: "goat-web",
  };
  const decode = Schema.decodeUnknownSync(RelayDpopAccessTokenRequest);
  const encode = Schema.encodeSync(RelayDpopAccessTokenRequest);

  it.each([true, false])(
    "preserves policy and readmission through form encoding (%s)",
    (readmit) => {
      const encoded = { ...fields, readmitClientKey: String(readmit) };
      const decoded = decode(encoded);
      expect(decoded).toEqual({
        ...fields,
        connectAuthPolicyVersion: 1,
        readmitClientKey: readmit,
      });
      expect(encode(decoded)).toEqual(encoded);
    },
  );

  it.each([
    { connectAuthPolicyVersion: "0" },
    { connectAuthPolicyVersion: "2" },
    { connectAuthPolicyVersion: "01" },
    { readmitClientKey: "yes" },
    { readmitClientKey: "0" },
  ])("rejects unsupported policy or malformed readmission %j", (invalid) => {
    expect(decodeDpopRequest({ ...fields, ...invalid })._tag).toBe("Failure");
  });
});
