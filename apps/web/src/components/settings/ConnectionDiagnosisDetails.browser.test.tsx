import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  type ConnectionDiagnosis,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import type { EnvironmentPresentation } from "~/state/environments";

const catalog = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => catalog.state },
}));
vi.mock("~/state/environments", () => ({
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ useCopyToClipboard: vi.fn() }));
vi.mock("../ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: {} }));

import {
  ConnectionDiagnosisHeadline,
  ConnectionDiagnosisSummary,
} from "./ConnectionDiagnosisDetails";

const diagnosis: ConnectionDiagnosis = {
  headline: "Cannot reach the environment",
  hops: [],
  steps: [],
  facts: [],
  moreInfoUrl: null,
};
const summary = (retryAt: number) => (
  <ConnectionDiagnosisSummary
    diagnosis={diagnosis}
    retryAt={retryAt}
    attempt={1}
    expanded={false}
    onToggle={() => {}}
  />
);

it("stops its countdown timer at the retry deadline while the summary remains mounted", async () => {
  await using screen = await render(null, {
    // The diagnostics summary has no navigation or router context.
    router: false,
  });
  using _timers = fakeTimers();
  vi.setSystemTime(0);
  await screen.rerender(summary(2_500));
  await act(() => vi.advanceTimersByTime(2_500));
  expect(vi.getTimerCount()).toBe(0);
  await expect.element(screen.container).toMatchTextContent(/retrying(?! in)/);
});

it("restarts the countdown for a new deadline and leaves expired deadlines idle", async () => {
  await using screen = await render(null, {
    // The diagnostics summary has no navigation or router context.
    router: false,
  });
  using _timers = fakeTimers();
  vi.setSystemTime(10_000);
  await screen.rerender(summary(9_000));
  expect(vi.getTimerCount()).toBe(0);
  await screen.rerender(summary(12_000));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  await act(() => vi.advanceTimersByTime(2_000));
  expect(vi.getTimerCount()).toBe(0);
  await expect.element(screen.container).toMatchTextContent(/retrying(?! in)/);
});

const STUDIO = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("studio"),
  label: "Studio",
  httpBaseUrl: "http://localhost:6277",
  wsBaseUrl: "ws://localhost:6277",
});
const STEP = "Reload this page, then pair this browser again.";

/** This page's own server, blocked for authentication, with or without the ended-session marker. */
function refusedOwnServer(sessionEnded: boolean): EnvironmentPresentation {
  const state: SupervisorConnectionState = {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "blocked",
    lastFailure: new ConnectionBlockedError({
      reason: "authentication",
      detail: "This browser is no longer signed in to Studio.",
      hop: "server",
      via: "direct",
      ...(sessionEnded ? { sessionEnded } : {}),
    }),
  };
  catalog.state = Atom.make(AsyncResult.success(state));
  return {
    environmentId: STUDIO.environmentId,
    label: "Studio",
    entry: { target: STUDIO, profile: Option.none(), enabled: true },
    connection: { phase: "error", error: null, traceId: null },
    serverConfig: null,
  } as unknown as EnvironmentPresentation;
}

it("a browser whose own server ended its session reads the way back under the headline (#3473, access)", async () => {
  const environment = refusedOwnServer(true);
  // The headline reads only its atoms.
  await using screen = await render(<ConnectionDiagnosisHeadline environment={environment} />, {
    router: false,
  });
  await expect.element(screen.getByText(STEP, { exact: true })).toBeVisible();
  expect(screen.container.textContent).toBe(`GOAT on Studio did not accept this device${STEP}`);
});

it("a bearer refusal shows the headline alone (#3473, guard)", async () => {
  const environment = refusedOwnServer(false);
  // The headline reads only its atoms.
  await using screen = await render(<ConnectionDiagnosisHeadline environment={environment} />, {
    router: false,
  });
  await expect.element(screen.getByText("GOAT on Studio did not accept this device")).toBeVisible();
  expect(screen.container.textContent).not.toContain(STEP);
});
