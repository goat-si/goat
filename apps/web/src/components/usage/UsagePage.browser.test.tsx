import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { USAGE_CONTRACT_VERSION, type UsageSummaryInput } from "@goat/contracts";
import { makeWindow } from "@goat/shared/usageFormat";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { act, render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { UsagePage } from "./UsagePage";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";

const fixture = vi.hoisted(() => ({ queries: new Map<string, unknown>(), reads: [] as string[] }));
vi.mock(import("~/state/presentation"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  const presentation = {
    entry: { target: { label: "Test machine" } },
    connection: { phase: "connected" },
    serverConfig: null,
  };
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      presentationsAtom: Atom.make(new Map([["usage-period-test", presentation]])) as never,
    },
  };
});
vi.mock(import("~/state/session"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const actual = await original();
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: ["diagnostics:read"] }),
  );
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => session) as never,
    },
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      usageSummary: (({ input }: { input: UsageSummaryInput }) => {
        let query = fixture.queries.get(input.sinceDay);
        if (!query) {
          query = Atom.make(AsyncResult.initial(true)).pipe(Atom.keepAlive);
          fixture.queries.set(input.sinceDay, query);
          fixture.reads.push(input.sinceDay);
        }
        return query;
      }) as never,
    },
  };
});

function summary(input: UsageSummaryInput, costUsd: number) {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-11-25T00:00:00Z",
    ...input,
    buckets: [
      {
        day: input.sinceDay,
        provider: "codex" as const,
        model: "fixture-model",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        costUsd,
        cacheSavingsUsd: 0,
        costSource: "modelPriced" as const,
        records: 1,
        unpricedRecords: 0,
        sessions: 1,
      },
    ],
    sources: [
      {
        fingerprint: {
          hostId: "fixture",
          provider: "codex" as const,
          resolvedHomePath: "/fixture",
          volumeId: "fixture",
        },
        status: "ok" as const,
        scannedFiles: 1,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: 1,
        message: null,
      },
    ],
    pricing: { status: "unavailable" as const, source: "test", fetchedAt: null, knownModels: 0 },
    scanDurationMs: 0,
  };
}

async function answer(input: UsageSummaryInput, cost: number) {
  await act(() =>
    appAtomRegistry.set(
      fixture.queries.get(input.sinceDay) as never,
      AsyncResult.success(summary(input, cost)) as never,
    ),
  );
}

describe("usage period selection", () => {
  it("retains the answered period through pending, late and failed requests and returns to its cache", async () => {
    fixture.queries.clear();
    fixture.reads.length = 0;
    const preferences = readUsagePagePreferences();
    saveUsagePagePreferences({ metric: "cost", windowDays: 7 });
    const initial = makeWindow(7),
      month = makeWindow(30),
      quarter = makeWindow(90);
    try {
      await using screen = await render(
        <AppAtomRegistryProvider>
          <UsagePage />
        </AppAtomRegistryProvider>,
        { router: "/usage" },
      );
      const dialog = page.getByRole("dialog", { name: "Usage" });
      await expect.poll(() => fixture.queries.has(initial.sinceDay)).toBe(true);
      await answer(initial, 12.34);
      await expect.element(dialog.getByText("$12.34", { exact: true }).first()).toBeVisible();
      const click = (name: string) =>
        act(() => (dialog.getByRole("button", { name }).element() as HTMLElement).click());
      await click("30 days");
      await expect.poll(() => fixture.queries.has(month.sinceDay)).toBe(true);
      await click("90 days");
      await expect.poll(() => fixture.queries.has(quarter.sinceDay)).toBe(true);
      await expect
        .poll(() => dialog.element().querySelector("[role=status]")?.textContent ?? "")
        .toContain("Loading usage");
      // Complete the older request after the new selection has taken effect.
      await answer(month, 56.78);
      await expect.element(dialog.getByText("$12.34", { exact: true }).first()).toBeVisible();
      await expect.element(dialog.getByText("$56.78", { exact: true })).not.toBeInTheDocument();
      await act(() =>
        appAtomRegistry.set(
          fixture.queries.get(quarter.sinceDay) as never,
          AsyncResult.failure(Cause.fail("offline")) as never,
        ),
      );
      await expect
        .poll(() => dialog.element().querySelector("[role=status]")?.textContent ?? "")
        .toContain("Could not load usage");
      await expect.element(dialog.getByText("$12.34", { exact: true }).first()).toBeVisible();
      await click("7 days");
      await expect
        .poll(() => dialog.element().querySelector("[role=status]")?.textContent ?? "")
        .toBe("");
      await expect.element(dialog.getByText("$12.34", { exact: true }).first()).toBeVisible();
      expect(fixture.reads.filter((day) => day === initial.sinceDay)).toHaveLength(1);
      await screen.unmount();
    } finally {
      saveUsagePagePreferences(preferences);
    }
  });
});
