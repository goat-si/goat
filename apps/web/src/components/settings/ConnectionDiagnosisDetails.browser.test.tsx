import type { ConnectionDiagnosis } from "@goat/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

vi.mock("~/connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("~/state/environments", () => ({ useRelayEnvironmentDiscovery: vi.fn() }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ useCopyToClipboard: vi.fn() }));
vi.mock("../ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: {} }));

import { ConnectionDiagnosisSummary } from "./ConnectionDiagnosisDetails";

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
