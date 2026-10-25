import { describe, expect, it } from "@effect/vitest";
import {
  COMPUTER_USE_METHODS,
  computerUseReady,
  ComputerUseGrant,
  ComputerUseCapabilities,
  type ComputerUseMethod,
  ComputerUseReadiness,
  CuaHostStatus,
  CuaToolsAvailability,
} from "@goat/contracts";

import { COMPUTER_USE_PLATFORM_PARITY, computerUseReadinessSteps } from "./readinessSteps.ts";

const ready: ComputerUseReadiness = {
  grants: { accessibility: "granted", screenCapture: "granted" },
  helper: "authenticated",
  capture: "ready",
  tree: "ready",
  input: "background",
  blockers: [],
  reasons: [],
};
const platforms = CuaHostStatus.fields.platform.literals.filter((platform) => platform !== "other");
const view = (
  readiness: ComputerUseReadiness | undefined,
  platform: (typeof platforms)[number] = "darwin",
  ...tools: [] | [CuaToolsAvailability | undefined]
) =>
  computerUseReadinessSteps({ readiness, platform, tools: tools.length ? tools[0] : "available" });

it.each(ComputerUseGrant.literals)(
  "distinguishes the %s grant state and chooses only the next grant action",
  (state) => {
    const result = view({ ...ready, grants: { accessibility: state, screenCapture: "denied" } });
    const row = result.steps[0]?.grants[0];
    const expected = {
      granted: ["ok", "granted"],
      pending: ["pending", "Waiting for your answer"],
      denied: ["blocked", "denied"],
      abandoned: ["blocked", "closed without an answer"],
      unknown: ["unknown", "not been checked"],
    } as const;
    expect(row?.status).toBe(expected[state][0]);
    expect(row?.detail.join(" ")).toContain(expected[state][1]);
    expect(
      result.steps[0]?.grants.filter((grant) => grant.isCurrent).map((grant) => grant.grant),
    ).toEqual([state === "granted" ? "screenCapture" : "accessibility"]);
    expect(result.ready).toBe(false);
  },
);

it("gives a Linux host its setup guide, with the commands a person runs at that machine", () => {
  const result = computerUseReadinessSteps({
    readiness: { ...ready, tree: "unavailable", platform: { linux: { displayServer: "x11" } } },
    platform: "linux",
    tools: "available",
    machine: "lab-box",
  });
  expect(result.linuxSetup?.steps[0]?.detail).toContain("lab-box");
  expect(
    result.linuxSetup?.steps.find((step) => step.id === "accessibility")?.guidance,
  ).toContainEqual({
    kind: "command",
    text: "gsettings set org.gnome.desktop.interface toolkit-accessibility true",
  });
  // Other platforms, and a Linux host whose helper has not reported, have no guide to show.
  expect(view(ready, "darwin").linuxSetup).toBeUndefined();
  expect(view(undefined, "linux").linuxSetup).toBeUndefined();
});

it("uses typed readiness and server tools only, independently of reasons and optional detection signals", () => {
  expect(view(ready).ready).toBe(true);
  expect(view({ ...ready, reasons: ["An informational warning."] }).ready).toBe(true);
  expect(view({ ...ready, input: "foregroundOnly" }).ready).toBe(true);
  expect(view({ ...ready, capture: "blank", reasons: [] }).ready).toBe(false);
  expect(view({ ...ready, helper: "unauthenticated", reasons: ["Ready!"] }).ready).toBe(false);
  for (const tools of [...CuaToolsAvailability.literals, undefined]) {
    expect(view(ready, "darwin", tools).ready).toBe(tools === "available");
  }
  expect(
    computerUseReadinessSteps({
      readiness: ready,
      platform: "darwin",
      tools: "available",
      signals: { humanInput: "unsupported", privateMode: "unsupported" },
    }).ready,
  ).toBe(true);
  expect(view(ready).steps[0]?.grants.every((grant) => !grant.isCurrent)).toBe(true);
});

it.each(ComputerUseReadiness.fields.blockers.value.literals)(
  "gives %s a typed remedy on the matching step",
  (id) => {
    const result = view({ ...ready, blockers: [id] });
    const blocker = result.blockers[0];
    const remedies = {
      screenLocked: "Unlock the screen",
      userIntervened: "person's input ends",
      noInteractiveDesktop: "Windows Session 0",
      otherUserAtConsole: "Another user",
      restartRequired: "Restart the helper or GOAT",
    } as const;
    expect(blocker?.id).toBe(id);
    expect(blocker?.remedy).toContain(remedies[id]);
    const step = result.steps.find((candidate) => candidate.id === blocker?.step);
    expect(step?.state).toBe("blocked");
    expect(step?.detail).toContain(blocker?.remedy);
    expect(result.ready).toBe(false);
  },
);

it("keeps missing helper reports and older server tools unknown instead of inferring readiness", () => {
  const result = view(undefined);
  expect(result.report).toBe("notReported");
  expect(result.ready).toBe(false);
  for (const step of result.steps.slice(0, 3)) {
    expect(step.state).toBe("unknown");
    expect(step.detail).toContain("The helper has not reported readiness yet.");
  }
  expect(view(ready, "linux", undefined).steps[3]?.state).toBe("unknown");
  expect(result.steps[0]?.grants.map((grant) => grant.state)).toEqual(["unknown", "unknown"]);
  expect(result.steps[0]?.grants[0]?.detail).toContain(
    "The helper has not reported readiness yet.",
  );
});

it("says which macOS grant keeps agents without tools, and only while the tools are unavailable (#1399)", () => {
  const block = {
    reason: "permissionsNotGranted",
    missing: ["screenRecording"],
    holder: "helper",
  } as const;
  const steps = (tools: CuaToolsAvailability) =>
    computerUseReadinessSteps({ readiness: ready, platform: "darwin", tools, block }).steps.find(
      (step) => step.id === "tools",
    );
  expect(steps("unavailable")).toMatchObject({
    state: "blocked",
    detail: [
      "Computer use cannot start: macOS has not allowed GOAT Computer Use in Screen & System Audio Recording. A person turns it on in System Settings > Privacy & Security.",
    ],
  });
  // Turned off, or running again after the grant: the old reason no longer explains anything.
  expect(steps("off")?.state).toBe("blocked");
  expect(steps("off")?.detail[0]).toContain("Computer use is off");
  expect(steps("available")?.state).toBe("ok");
});

it("places reasons under their not-ready steps without changing those states", () => {
  const result = view({
    ...ready,
    grants: { accessibility: "denied", screenCapture: "granted" },
    helper: "unauthenticated",
    capture: "blank",
    reasons: [
      "Grant explanation.",
      "Helper explanation.",
      "Capture explanation.",
      "More capture detail.",
    ],
  });
  expect(result.steps[0]?.detail).toContain("Grant explanation.");
  expect(result.steps[1]?.detail).toContain("Helper explanation.");
  expect(result.steps[2]?.detail).toEqual(
    expect.arrayContaining(["Capture explanation.", "More capture detail."]),
  );
  expect(result.steps[3]?.detail).not.toContain("Capture explanation.");
  const restart = view({
    ...ready,
    blockers: ["restartRequired"],
    reasons: ["New grant needs restart."],
  });
  expect(restart.steps[0]?.detail).toContain("New grant needs restart.");
});

it("keeps Linux probe explanations with capture and tree even while portal consent is pending", () => {
  const result = view(
    {
      ...ready,
      grants: { accessibility: "granted", screenCapture: "pending" },
      capture: "pending",
      tree: "unavailable",
      reasons: ["AT-SPI did not answer.", "Waiting for portal capture consent."],
    },
    "linux",
  );
  expect(result.steps[0]?.detail).not.toContain("AT-SPI did not answer.");
  expect(result.steps[2]?.detail).toEqual(
    expect.arrayContaining(["AT-SPI did not answer.", "Waiting for portal capture consent."]),
  );
});

it("tells Windows users about the security prompt, administrator apps and a blocked helper", () => {
  const locked = view({ ...ready, blockers: ["screenLocked"] }, "win32");
  expect(locked.steps[2]?.state).toBe("blocked");
  expect(locked.steps[2]?.detail.join(" ")).toContain(
    "Windows security prompt (User Account Control)",
  );
  expect(view({ ...ready, blockers: ["screenLocked"] }).steps[2]?.detail.join(" ")).not.toContain(
    "User Account Control",
  );
  const healthy = view(ready, "win32");
  expect(healthy.ready).toBe(true);
  expect(healthy.steps[2]?.detail.join(" ")).toContain(
    "Apps running as administrator stay out of reach",
  );
  expect(healthy.steps[1]?.detail.join(" ")).not.toContain("Smart App Control");
  const blocked = {
    ...ready,
    helper: "unauthenticated",
    capture: "unavailable",
    tree: "unavailable",
  } as const;
  expect(view(blocked, "win32").steps[1]?.detail.join(" ")).toContain("Smart App Control");
  // Stopped after reading a real window: it ran, so nothing blocked it.
  expect(
    view({ ...ready, helper: "unauthenticated" }, "win32").steps[1]?.detail.join(" "),
  ).not.toContain("Smart App Control");
  expect(view(ready, "darwin").steps[2]?.detail.join(" ")).not.toContain("administrator");
});

it("calls an unchecked Windows desktop not checked, not unsupported or waiting for consent (#1520)", () => {
  // What the Windows helper reports after it authenticated but before a check read a window.
  const unchecked = { ...ready, capture: "pending", tree: "unavailable" } as const;
  const step = view(unchecked, "win32").steps[2];
  expect(step?.state).toBe("pending");
  expect(step?.detail.join(" ")).not.toContain("consent");
  expect(step?.detail.join(" ")).not.toContain("Check accessibility access");
  expect(step?.detail.join(" ")).toContain("Turning computer use on here");
  // A tree that a check really could not read still says so.
  expect(view({ ...ready, tree: "unavailable" }, "win32").steps[2]?.state).toBe("unsupported");
  // macOS keeps its consent wording.
  expect(view(unchecked, "darwin").steps[2]?.detail.join(" ")).toContain("consent");
});

it("uses host-specific names and reports the Linux display server", () => {
  expect(view(ready).steps[0]?.grants[1]?.title).toBe("Screen & System Audio Recording");
  expect(view(ready, "win32").steps[0]?.grants[0]?.title).toBe("UI Automation");
  expect(view(ready, "linux").steps[0]?.grants[0]?.title).toBe("AT-SPI");
  for (const displayServer of ComputerUseReadiness.fields.platform.schema.fields.linux.schema.fields
    .displayServer.literals) {
    const result = view({ ...ready, platform: { linux: { displayServer } } }, "linux");
    expect(result.steps[2]?.detail).toContain(`Linux display server: ${displayServer}.`);
  }
});

it("shows detection support separately and explains the unattended requirement", () => {
  for (const support of ComputerUseCapabilities.fields.signals.fields.humanInput.literals) {
    const result = computerUseReadinessSteps({
      readiness: ready,
      platform: "linux",
      tools: "available",
      signals: { humanInput: support, privateMode: support },
    });
    expect(result.steps[1]?.detail).toEqual(
      expect.arrayContaining([
        `Human input detection: ${support}.`,
        `Private mode detection: ${support}.`,
      ]),
    );
    expect(result.steps[1]?.detail.join(" ")).toContain("Unattended turns require both signals");
    expect(result.ready).toBe(true);
  }
  expect(view(ready).steps[1]?.detail).toContain("Human input detection: not reported.");
});

describe.each(platforms)("%s platform parity", (platform) => {
  it("names every runtime protocol method, including a reason for each typed unsupported method", () => {
    const methods: Record<ComputerUseMethod, "supported" | { readonly unsupported: string }> =
      COMPUTER_USE_PLATFORM_PARITY[platform];
    expect(Object.keys(methods).sort()).toEqual([...COMPUTER_USE_METHODS].sort());
    for (const method of COMPUTER_USE_METHODS) {
      const support: "supported" | { readonly unsupported: string } = methods[method];
      if (support !== "supported") expect(support.unsupported.trim()).not.toBe("");
    }
  });

  it("renders all protocol readiness states with a non-empty title and explanation", () => {
    const variants: ComputerUseReadiness[] = [ready];
    for (const state of ComputerUseGrant.literals) {
      for (const grant of ["accessibility", "screenCapture"] as const) {
        variants.push({ ...ready, grants: { ...ready.grants, [grant]: state } });
      }
    }
    for (const key of ["helper", "capture", "tree", "input"] as const) {
      for (const state of ComputerUseReadiness.fields[key].literals)
        variants.push({ ...ready, [key]: state });
    }
    for (const blocker of ComputerUseReadiness.fields.blockers.value.literals)
      variants.push({ ...ready, blockers: [blocker] });
    for (const displayServer of ComputerUseReadiness.fields.platform.schema.fields.linux.schema
      .fields.displayServer.literals) {
      variants.push({ ...ready, platform: { linux: { displayServer } } });
    }
    const states = new Set<string>();
    for (const readiness of [...variants, undefined]) {
      for (const tools of [...CuaToolsAvailability.literals, undefined]) {
        const result = view(readiness, platform, tools);
        expect(result.ready).toBe(
          readiness !== undefined && computerUseReady(readiness) && tools === "available",
        );
        expect(result.steps.map((step) => step.id)).toEqual([
          "grants",
          "helper",
          "capture",
          "tools",
        ]);
        for (const step of result.steps) {
          states.add(step.state);
          expect(step.title.trim()).not.toBe("");
          expect(step.detail.length).toBeGreaterThan(0);
          expect(
            step.detail.every((line) => typeof line === "string" && line.trim().length > 0),
          ).toBe(true);
          for (const row of step.grants) {
            expect(row.title.trim()).not.toBe("");
            expect(
              row.detail.every((line) => typeof line === "string" && line.trim().length > 0),
            ).toBe(true);
          }
        }
      }
    }
    expect([...states].sort()).toEqual(["blocked", "ok", "pending", "unknown", "unsupported"]);
  });
});

it("on Linux, unproven Wayland capture does not claim a consent prompt is waiting", () => {
  // The Linux helper reports pending both before consent and when the compositor cannot
  // capture one window, so neither the steps nor the guide promise a prompt.
  const unproven = computerUseReadinessSteps({
    readiness: {
      ...ready,
      grants: { accessibility: "granted", screenCapture: "pending" },
      capture: "pending",
      input: "foregroundOnly",
      platform: { linux: { displayServer: "wayland" } },
    },
    platform: "linux",
    tools: "available",
  });
  const words = [
    ...unproven.steps.flatMap((step) => [
      ...step.detail,
      ...step.grants.flatMap((row) => row.detail),
    ]),
    ...(unproven.linuxSetup?.steps ?? []).flatMap((step) => [
      step.detail,
      ...step.guidance.map((line) => line.text),
    ]),
  ].join(" ");
  expect(words).not.toContain("Waiting for your answer");
  expect(words).not.toContain("Waiting for screen capture consent");
  // macOS still waits on its prompt.
  const mac = view({
    ...ready,
    grants: { accessibility: "granted", screenCapture: "pending" },
    capture: "pending",
  });
  expect(mac.steps[0]?.grants[1]?.detail.join(" ")).toContain("Waiting for your answer");
});

it("does not call input unsupported while the helper has not confirmed itself yet", () => {
  const unconfirmed = view({
    ...ready,
    helper: "unauthenticated",
    capture: "pending",
    tree: "unavailable",
    input: "unavailable",
  });
  const capture = unconfirmed.steps[2];
  expect(capture?.state).not.toBe("unsupported");
  expect(capture?.detail.join(" ")).not.toContain("Input is unavailable");
  expect(unconfirmed.steps[1]?.detail.join(" ")).toContain("Run the readiness check");
  // A confirmed helper in a session without input still says so.
  expect(view({ ...ready, input: "unavailable" }).steps[2]?.state).toBe("unsupported");
});
