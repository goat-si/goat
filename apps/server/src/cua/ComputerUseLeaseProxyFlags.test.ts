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
    flags.take(update({ shared: true }));
    flags.apply(update({ shared: true }));
    expect(flags.sharedNow()).toBe(true);
    flags.take(update({ shared: true, strictInputGuards: false }));
    flags.apply(update({ shared: true, strictInputGuards: false }));
    expect(flags.sharedNow()).toBe(false);
  });
});
