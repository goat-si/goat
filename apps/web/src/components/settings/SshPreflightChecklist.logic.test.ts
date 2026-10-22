import { SSH_PREFLIGHT_STEP_ORDER, type SshPreflightReport } from "@goat/contracts";
import type { ConnectionCatalogEntry } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import {
  parseDesktopSshTarget,
  sshPreflightAction,
  sshPreflightFlow,
  unsavedManagedSshAlias,
} from "./SshPreflightChecklist.logic";

const ready: SshPreflightReport = {
  host: "box",
  destination: { alias: "box", hostname: "box.local", user: "dev", port: 22 },
  steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({ id, state: "passed", summary: "Passed" })),
  ready: true,
};
const withStep = (
  id: string,
  state: "warning" | "failed" | "needs_review",
): SshPreflightReport => ({
  ...ready,
  ready: state === "warning",
  steps: ready.steps.map((step) => (step.id === id ? { ...step, state } : step)),
});
const action = (report: SshPreflightReport | null, overrides = {}) =>
  sshPreflightAction({
    report,
    checking: false,
    busy: false,
    reviewing: false,
    allowed: true,
    hasHost: true,
    ...overrides,
  });

describe("SSH preflight actions", () => {
  it("checks before connecting, and permits a ready report with warnings", () => {
    expect(sshPreflightFlow(null)).toBe("check");
    expect(action(null)).toEqual({ label: "Check", disabled: false });
    expect(sshPreflightFlow(withStep("runtime", "warning"))).toBe("connect");
    expect(action(ready)).toEqual({ label: "Connect", disabled: false });
  });

  it("reviews only the host key, and never connects after failed or unresolved checks", () => {
    expect(sshPreflightFlow(withStep("host_key", "needs_review"))).toBe("review");
    expect(action(withStep("host_key", "needs_review")).disabled).toBe(true);
    expect(sshPreflightFlow(withStep("runtime", "failed"))).toBe("blocked");
    expect(sshPreflightFlow(withStep("key_auth", "needs_review"))).toBe("blocked");
    const failedWithReview = withStep("host_key", "needs_review");
    expect(
      sshPreflightFlow({
        ...failedWithReview,
        steps: failedWithReview.steps.map((step) =>
          step.id === "reachability" ? { ...step, state: "failed" } : step,
        ),
      }),
    ).toBe("blocked");
    expect(action(withStep("key_auth", "failed")).disabled).toBe(true);
  });

  it("prevents dispatch while checking, connecting, reviewing, missing a host or without permission", () => {
    expect(action(ready, { checking: true })).toEqual({ label: "Checking…", disabled: true });
    expect(action(ready, { busy: true })).toEqual({ label: "Connecting…", disabled: true });
    for (const overrides of [{ reviewing: true }, { allowed: false }, { hasHost: false }]) {
      expect(action(ready, overrides).disabled).toBe(true);
    }
  });
});

describe("desktop SSH destination", () => {
  it("keeps aliases free of overrides, and normalizes typed user and IPv6 addresses", () => {
    expect(parseDesktopSshTarget({ host: "box", username: "", port: "" })).toEqual({
      alias: "box",
      hostname: "box",
      username: null,
      port: null,
    });
    expect(
      parseDesktopSshTarget({ host: "dev@[2001:db8::1]:2222", username: "", port: "" }),
    ).toEqual({ alias: "2001:db8::1", hostname: "2001:db8::1", username: "dev", port: 2222 });
    expect(
      parseDesktopSshTarget({ host: "dev@box:2222", username: "owner", port: "2200" }),
    ).toEqual({ alias: "box", hostname: "box", username: "owner", port: 2200 });
  });

  it("rejects partially numeric and out-of-range ports before a request", () => {
    for (const port of ["22oops", "2.5", "0", "65536"]) {
      expect(() => parseDesktopSshTarget({ host: "box", username: "", port })).toThrow(
        "SSH port must be between 1 and 65535.",
      );
    }
  });
});

describe("unsavedManagedSshAlias", () => {
  const sshRoute = (alias: string) => ({
    target: { _tag: "SshConnectionTarget" },
    profile: Option.some({
      _tag: "SshConnectionProfile",
      target: { alias, hostname: alias, username: null, port: null },
    }),
  });
  // Only the route fields the function reads; a full catalog entry carries much more.
  const entry = (aliases: ReadonlyArray<string>) => {
    const [first, ...rest] = aliases.map(sshRoute);
    return { ...first, alternateRoutes: rest } as unknown as ConnectionCatalogEntry;
  };
  const pinned = (alias: string, managed: boolean): SshPreflightReport => ({
    ...withStep("key_auth", "failed"),
    destination: {
      alias,
      hostname: "box.local",
      user: "dev",
      port: 22,
      ...(managed ? { managed: true } : {}),
    },
  });

  it("returns a pinned alias that no saved connection uses", () => {
    expect(unsavedManagedSshAlias(pinned("goat-box-1", true), [entry(["other"])])).toBe(
      "goat-box-1",
    );
  });

  it("never offers a person's own config alias", () => {
    expect(unsavedManagedSshAlias(pinned("devbox", false), [])).toBeNull();
    expect(unsavedManagedSshAlias(null, [])).toBeNull();
  });

  it("keeps a pinned alias saved on any route, including a second SSH route", () => {
    expect(
      unsavedManagedSshAlias(pinned("goat-a", true), [entry(["goat-a", "goat-b"])]),
    ).toBeNull();
    expect(
      unsavedManagedSshAlias(pinned("goat-b", true), [entry(["goat-a", "goat-b"])]),
    ).toBeNull();
  });
});
