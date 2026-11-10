import { describe, expect, it } from "vite-plus/test";
import login from "../vectors/login.json" with { type: "json" };
import { fromHex, toHex } from "./identity.ts";
import {
  type Assertion,
  checkAssertion,
  forgetProofMessage,
  fromBase64url,
  pollProofMessage,
  startProofMessage,
} from "./login.ts";
import { buildLoginVector } from "./loginVectors.ts";

describe("login vectors (CONTRACT Accounts v1.1)", () => {
  it("proofs, the login key's kid and the assertion recomputed from fixed keys match vectors/login.json", async () => {
    expect(await buildLoginVector()).toEqual(login);
  });

  it("proof messages are the contract's ASCII prefix followed by the named fields, ts as u64 big-endian ms", () => {
    const signPub = fromBase64url(login.node.signPub);
    const noisePub = fromBase64url(login.node.noisePub);
    const start = startProofMessage(signPub, noisePub, "box-1");
    expect(new TextDecoder().decode(start.slice(0, 17))).toBe("pen-login/1 start");
    expect(toHex(start.slice(17, 49))).toBe(toHex(signPub));
    expect(toHex(start.slice(49, 81))).toBe(toHex(noisePub));
    expect(new TextDecoder().decode(start.slice(81))).toBe("box-1");

    const poll = pollProofMessage(fromBase64url(login.poll.deviceCode));
    expect(toHex(poll)).toBe(login.poll.message);
    expect(new TextDecoder().decode(poll.slice(0, 16))).toBe("pen-login/1 poll");
    expect(poll.length).toBe(16 + 32);

    const forget = forgetProofMessage("aaaaaaaaaaaaaaaaaaaaaaaaaa", 0x0102030405);
    expect(new TextDecoder().decode(forget.slice(0, 18 + 26))).toBe(
      "pen-login/1 forgetaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(toHex(forget.slice(44))).toBe("0000000102030405");
  });

  it("each assertion check case gives its expected outcome", async () => {
    for (const check of login.checks) {
      const keys = [{ kid: login.loginKey.kid, pub: login.loginKey.pub }];
      const result = await checkAssertion(check.assertion as Assertion, { keys, ...check.context });
      expect({ name: check.name, ok: result.ok, reason: result.ok ? null : result.reason }).toEqual(
        {
          name: check.name,
          ok: check.ok,
          reason: check.reason,
        },
      );
    }
  });

  it("base64url decoding refuses padding, the standard alphabet and stray characters", () => {
    expect(toHex(fromBase64url("AQID"))).toBe("010203");
    for (const bad of ["AQI=", "AQ+/", "AQ D", "A"]) expect(() => fromBase64url(bad)).toThrow();
    expect(fromHex(login.loginKey.seed).length).toBe(32);
  });
});
