import { describe, expect, it } from "@effect/vitest";

import type { DisposableRecord } from "./disposableClass.ts";
import { claimedBy, penAliases, refusalText } from "./routeGuard.ts";

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
    // pen revoke never ends a detaching record, and mobile has no Detach.
    expect(text).toContain("Settings → Hub on web or desktop");
    expect(text).not.toContain("pen revoke");
  });
});

// A real ED25519 key and the fingerprint ssh-keygen -E sha256 prints for it.
const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIJqQutSw0XQo7KOx5R7x4wcb2s6h3WPkcz2z6WIeJ3Re";
const KEY_FINGERPRINT = "SHA256:WifIJ3Gg9d1V01c9+p+oi1SGRxLsJBBVzcaovKcEIAM";
const line = (name: string, nodeId: string, type = "ssh-ed25519", key = KEY) =>
  `pen-${name},pen-${nodeId} ${type} ${key}\n`;

describe("Pen's own pen-<name> alias", () => {
  it("is refused while its record has no pin and no environment yet, by the node Pen's known_hosts ties it to, in any case and with a trailing dot", () => {
    const records = [record({ environmentId: null, sshdPin: null })];
    const pen = penAliases(line("cc-07", node));
    for (const alias of ["pen-cc-07", "PEN-CC-07", "pen-cc-07."])
      expect(claimedBy(records, { alias }, pen)).toMatchObject({ by: "alias" });
  });

  it("is refused when the key Pen holds for it is an open record's pin, and a twin name is refused when any member it names is open", () => {
    const rejoined = penAliases(line("cc-08", "b".repeat(26)));
    expect(
      claimedBy([record({ sshdPin: KEY_FINGERPRINT })], { alias: "pen-cc-08" }, rejoined),
    ).toMatchObject({ by: "alias" });
    const twins = penAliases(line("cc", "c".repeat(26)) + line("cc", node, "ssh-rsa", "AAAA"));
    const twin = claimedBy([record({ sshdPin: null })], { alias: "pen-cc" }, twins);
    expect(twin).toMatchObject({
      by: "alias",
    });
    // The kept member under that name is reached by another alias, not by detaching anything.
    const text = refusalText(twin, "pen-cc");
    expect(text).toContain("more than one Pen member");
    expect(text).toContain("pen-" + node);
    expect(text).not.toContain("Detach it");
  });

  it("leaves a kept member's pen-<name>, an ended record's, and a line Pen did not write alone", () => {
    const pen = penAliases(line("cc-09", "d".repeat(26)) + `pen-cc-10 ssh-ed25519 ${KEY}\n`);
    expect(claimedBy([record()], { alias: "pen-cc-09" }, pen)).toBeUndefined();
    expect(
      claimedBy([record({ sshdPin: KEY_FINGERPRINT })], { alias: "pen-cc-10" }, pen),
    ).toBeUndefined();
    const ended = penAliases(line("cc-07", node));
    expect(claimedBy([record({ final: true })], { alias: "pen-cc-07" }, ended)).toBeUndefined();
  });
});
