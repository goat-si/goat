import { describe, expect, it } from "vite-plus/test";
import vector from "../vectors/service.json" with { type: "json" };
import { decodeKey32, parseServiceHello, serviceAnswer, verifyServiceIdentity } from "./service.ts";

const bytes = (text: string) => Buffer.from(text, "utf8");
const key = (text: string) => {
  const k = decodeKey32(text);
  if (k === null) throw new Error("vector key " + text);
  return k;
};
const pin = {
  key: key(vector.key),
  name: vector.name,
  nd: key(vector.nd),
  ng: key(vector.ng),
  mesh: vector.mesh,
  self: vector.self,
};

describe("service vectors (CONTRACT Services v1.2)", () => {
  it("the program side reads line 1, answers line 2 and verifies line 3 exactly as vectors/service.json", () => {
    expect(Buffer.from(parseServiceHello(bytes(vector.line1))).toString("base64url")).toBe(
      vector.nd,
    );
    expect(Buffer.from(serviceAnswer(pin.key, pin.name, pin.nd, pin.ng)).toString("utf8")).toBe(
      vector.line2,
    );
    const identity = verifyServiceIdentity(bytes(vector.line3), pin);
    expect(identity.caller).toEqual(vector.caller);
    expect(identity.stream).toBe("goat");
  });

  it("every malformed line 1 is refused", () => {
    for (const reject of vector.rejectLine1) {
      expect(() => parseServiceHello(bytes(reject.line)), reject.why).toThrow();
    }
  });

  it("every malformed or misdirected line 3 is refused; all but the wrong-MAC case carry a MAC right for their bytes", () => {
    for (const reject of vector.rejectLine3) {
      expect(() => verifyServiceIdentity(bytes(reject.line), pin), reject.why).toThrow();
    }
  });

  it("a key that is not canonical base64url is no key", () => {
    const flipped = vector.key.slice(0, 42) + "F";
    expect(decodeKey32(flipped)).toBeNull();
    expect(decodeKey32(vector.key + "=")).toBeNull();
  });
});
