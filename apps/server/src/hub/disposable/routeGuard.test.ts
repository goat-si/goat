import { describe, expect, it } from "@effect/vitest";

import type { DisposableRecord } from "./disposableClass.ts";
import { claimedBy, refusalText } from "./routeGuard.ts";

const node = "a".repeat(26);
const record = (overrides: Partial<DisposableRecord> = {}): DisposableRecord => ({
  attachId: "attach-1",
  nodeId: node,
  state: "linked",
  stateSince: "2026-11-14T00:00:00.000Z",
  createdAt: "2026-11-14T00:00:00.000Z",
  provisioner: { kind: "person" },
  final: false,
  environmentId: "env-disposable",
  machineInstallId: null,
  sshdPin: "SHA256:pinned",
  linkId: null,
  conflicts: [],
  penMember: true,
  ...overrides,
});

describe("claimedBy", () => {
  it("names the open record whose Pen alias, environment or sshd key a kept-machine path offers", () => {
    const records = [record()];
    expect(claimedBy(records, { alias: "PEN-" + node })).toMatchObject({ by: "alias" });
    expect(claimedBy(records, { alias: "box", environmentId: "env-disposable" })).toMatchObject({
      attachId: "attach-1",
      by: "environment",
    });
    expect(claimedBy(records, { hostKeyFingerprint: "SHA256:pinned" })).toMatchObject({
      by: "host_key",
    });
  });

  it("leaves a kept machine, an ended record and an empty table (unreadable reads as kept) alone", () => {
    expect(claimedBy([record()], { alias: "cc-01", environmentId: "env-kept" })).toBeUndefined();
    expect(claimedBy([record({ final: true })], { alias: "pen-" + node })).toBeUndefined();
    expect(claimedBy([], { alias: "pen-" + node })).toBeUndefined();
    expect(
      claimedBy([record({ environmentId: null, sshdPin: null })], { environmentId: null }),
    ).toBeUndefined();
  });

  it("says why the path refuses and how a person ends the record first", () => {
    const text = refusalText(claimedBy([record()], { alias: "pen-" + node }), "pen-" + node);
    expect(text).toContain("disposable machine");
    expect(text).toContain("Pen route");
    expect(text).toContain("Detach");
  });
});
