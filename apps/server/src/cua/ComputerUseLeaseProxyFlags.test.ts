import { describe, expect, it } from "vite-plus/test";
import { makeLeaseFlags } from "./ComputerUseLeaseProxyFlags.ts";

const update = (fields: { readonly strictInputGuards?: false; readonly shared?: true }) =>
  ({
    state: "active",
    controlId: "control",
    expiresAt: "2026-11-01T00:00:00Z",
    ...fields,
  }) as const;

describe("the proxy's lease flags", () => {
  it("start strict, so an older server never loosens the proxy", () => {
    expect(makeLeaseFlags().strict()).toBe(true);
  });
  it("loosen only once an update without strict guards is applied", () => {
    const flags = makeLeaseFlags();
    flags.take(update({ strictInputGuards: false }));
    expect(flags.strict()).toBe(true);
    flags.apply(update({ strictInputGuards: false }));
    expect(flags.strict()).toBe(false);
  });
  it("tighten as soon as a strict update is received", () => {
    const flags = makeLeaseFlags();
    flags.take(update({ strictInputGuards: false }));
    flags.apply(update({ strictInputGuards: false }));
    flags.take(update({}));
    expect(flags.strict()).toBe(true);
  });
  it("deny a shared screen only with strict guards", () => {
    const flags = makeLeaseFlags();
    const strictShared = update({ shared: true });
    flags.take(strictShared);
    flags.apply(strictShared);
    expect(flags.sharedNow()).toBe(true);
    const relaxedShared = update({ shared: true, strictInputGuards: false });
    flags.take(relaxedShared);
    flags.apply(relaxedShared);
    expect(flags.sharedNow()).toBe(false);
  });

  it("keep a received strict update until it is applied, whatever arrives after it", () => {
    const flags = makeLeaseFlags();
    const off = update({ strictInputGuards: false });
    flags.take(off);
    flags.apply(off);
    const strict = update({});
    const laterOff = update({ strictInputGuards: false });
    flags.take(strict);
    flags.take(laterOff);
    expect(flags.strict()).toBe(true);
    flags.apply(strict);
    expect(flags.strict()).toBe(true);
    flags.apply(laterOff);
    expect(flags.strict()).toBe(false);
  });
});
