import { describe, expect, it } from "vite-plus/test";
import { verifyDpopProof } from "@goat/shared/dpop";
import {
  acceptsCliApprovalPost,
  createCliApprovalKey,
  createCliApprovalProof,
} from "./CliLinkApproval.ts";

const origin = "https://app.trygoat.ai";
describe("CLI browser approval receiver", () => {
  it("accepts only bounded POSTs from the exact configured hosted origin", () => {
    const request = { method: "POST", origin, expectedOrigin: origin, contentLength: "1000" };
    expect(acceptsCliApprovalPost(request)).toBe(true);
    for (const change of [
      { origin: "https://staging.app.trygoat.ai" },
      { origin: "https://sibling.trygoat.ai" },
      { origin: undefined },
      { method: "GET" },
      { contentLength: "16385" },
      { contentLength: undefined },
      { contentLength: "NaN" },
    ])
      expect(acceptsCliApprovalPost({ ...request, ...change })).toBe(false);
  });
  it("binds the transient approval key to each actual relay request", () => {
    const key = createCliApprovalKey();
    const url = "https://relay.example.test/v1/client/environment-links";
    const proof = createCliApprovalProof(key, url, 1800000000);
    expect(
      verifyDpopProof({
        proof,
        method: "POST",
        url,
        nowEpochSeconds: 1800000000,
        expectedThumbprint: key.thumbprint,
      }).ok,
    ).toBe(true);
    expect(
      verifyDpopProof({
        proof,
        method: "POST",
        url: `${url}/other`,
        nowEpochSeconds: 1800000000,
        expectedThumbprint: key.thumbprint,
      }).ok,
    ).toBe(false);
  });
});
