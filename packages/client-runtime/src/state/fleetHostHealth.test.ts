import type { HostStorageHealth } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  formatHealthDuration,
  formatStorageBytes,
  plainHostFailure,
  presentConnectionWait,
  presentHostResponsiveness,
  presentHostStorage,
  presentHostStrays,
  SLOW_ANSWER_MS,
  SLOW_CONNECT_MS,
} from "./fleetHostHealth.ts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const NOW = Date.parse("2026-10-22T12:00:00.000Z");

const storage = (overrides: Partial<HostStorageHealth> = {}): HostStorageHealth => ({
  databaseBytes: 961 * MB,
  memoryBytes: 12 * MB,
  historyBytes: 900 * MB,
  reclaimableBytes: 0,
  measuredAt: "2026-10-22T11:59:00.000Z",
  ...overrides,
});

describe("formatting", () => {
  it("keeps durations and sizes short", () => {
    expect(formatHealthDuration(8_400)).toBe("8s");
    expect(formatHealthDuration(72_000)).toBe("1m 12s");
    expect(formatHealthDuration(27 * 3_600_000)).toBe("27h 0m");
    expect(formatHealthDuration(63 * 3_600_000)).toBe("2d 15h");
    expect(formatStorageBytes(12 * MB)).toBe("12 MB");
    expect(formatStorageBytes(6.7 * GB)).toBe("6.7 GB");
  });
});

describe("presentConnectionWait", () => {
  it("shows elapsed time and the step, then says it is slow", () => {
    expect(
      presentConnectionWait({ step: "Opening connection", sinceMs: NOW - 12_000, nowMs: NOW }),
    ).toEqual({ slow: false, text: "Connecting · 12s · Opening connection" });
    expect(
      presentConnectionWait({
        step: "Connecting",
        sinceMs: NOW - SLOW_CONNECT_MS - 42_000,
        nowMs: NOW,
      }),
    ).toEqual({ slow: true, text: "Still connecting · 1m 12s" });
  });
});

describe("presentHostStorage", () => {
  it("is quiet within budget and names both parts", () => {
    const view = presentHostStorage(storage(), NOW);
    expect(view.level).toBe("ok");
    expect(view.alert).toBeNull();
    expect(view.summary).toBe("History 900 MB of 2 GB · memory 12 MB of 100 MB");
    const approaching = presentHostStorage(storage({ historyBytes: 1.6 * GB }), NOW);
    expect(approaching).toMatchObject({ level: "approaching", tone: "muted", alert: null });
    // Memory approaches at the memory store's own target, half its budget.
    expect(presentHostStorage(storage({ memoryBytes: 60 * MB }), NOW)).toMatchObject({
      level: "approaching",
      alert: null,
    });
  });

  it("alerts when history passes its budget, and says it slows the host at 3x", () => {
    const over = presentHostStorage(storage({ historyBytes: 2.5 * GB }), NOW);
    expect(over).toMatchObject({ level: "over", tone: "warning", action: "compact" });
    expect(over.alert).toBe("Thread history is 2.5 GB, over its 2 GB budget");
    const critical = presentHostStorage(storage({ historyBytes: 6.7 * GB }), NOW);
    expect(critical).toMatchObject({ level: "critical", tone: "destructive", action: "compact" });
    expect(critical.alert).toBe(
      "Thread history is 6.7 GB, 3.4× its 2 GB budget; this slows GOAT down there",
    );
  });

  it("sends an oversized memory store to its settings instead of compacting history", () => {
    const view = presentHostStorage(storage({ memoryBytes: 150 * MB }), NOW);
    expect(view).toMatchObject({ level: "over", action: "memory_settings" });
    expect(view.alert).toBe("Memory store is 150 MB, over its 100 MB budget");
  });

  it("reports compaction progress and its result", () => {
    const running = presentHostStorage(
      storage({ historyBytes: 6.7 * GB, compactingSince: "2026-10-22T11:59:46.000Z" }),
      NOW,
    );
    expect(running.compactingMs).toBe(14_000);
    const done = presentHostStorage(
      storage({
        lastCompaction: {
          finishedAt: "2026-10-22T11:59:00.000Z",
          removedEvents: 1_204_311,
          freedBytes: 0,
          needsOfflineCompaction: true,
        },
      }),
      NOW,
    );
    expect(done.lastResult).toBe(
      "Removed 1,204,311 old events; the file shrinks after goat doctor runs on that machine",
    );
  });
});

describe("presentHostResponsiveness", () => {
  const stall = {
    detectedAt: "2026-10-22T11:58:00.000Z",
    durationMs: 19_000,
    loadAverage: 23,
    cpuCount: 10,
  };

  it("is null for a host that answers", () => {
    expect(
      presentHostResponsiveness({
        pendingSinceMs: NOW - 2_000,
        stall: undefined,
        storage: null,
        nowMs: NOW,
      }),
    ).toBeNull();
  });

  it("says a host is not answering and blames oversized storage first", () => {
    const view = presentHostResponsiveness({
      pendingSinceMs: NOW - SLOW_ANSWER_MS - 8_000,
      stall,
      storage: presentHostStorage(storage({ historyBytes: 6.7 * GB }), NOW),
      nowMs: NOW,
    });
    expect(view).toMatchObject({
      kind: "not_answering",
      label: "Not answering · 18s",
      tone: "destructive",
      compact: true,
    });
    expect(view?.cause).toContain("Thread history is 6.7 GB");
  });

  it("reports a recent freeze with the CPU load that explains it", () => {
    expect(
      presentHostResponsiveness({ pendingSinceMs: null, stall, storage: null, nowMs: NOW }),
    ).toEqual({
      kind: "froze",
      label: "Froze for 19s",
      cause: "Its CPU is overloaded (load 23 on 10 cores).",
      tone: "warning",
      compact: false,
    });
    expect(
      presentHostResponsiveness({
        pendingSinceMs: null,
        stall,
        storage: null,
        nowMs: NOW + 3_600_000,
      }),
    ).toBeNull();
  });
});

describe("presentHostStrays", () => {
  it("summarizes strays in one line and lists each for the tooltip", () => {
    const view = presentHostStrays(
      {
        scannedAt: "2026-10-22T11:59:00.000Z",
        processes: [
          {
            pid: 72341,
            startedAt: "2026-10-19T21:00:00.000Z",
            kind: "orphaned_server",
            reason: "home_deleted",
            baseDir: "/private/tmp/goat-test-7kyqAJ/.goat",
          },
          {
            pid: 80111,
            startedAt: "2026-10-22T09:00:00.000Z",
            kind: "orphaned_server",
            reason: "temporary_home",
            baseDir: "/tmp/goat-switch/.goat",
          },
        ],
      },
      NOW,
    );
    expect(view?.detail).toBe("2 stray GOAT servers · oldest 2d 15h");
    expect(view?.lines[0]).toBe(
      "PID 72341 · 2d 15h · home deleted: /private/tmp/goat-test-7kyqAJ/.goat",
    );
    expect(presentHostStrays({ scannedAt: "x", processes: [] }, NOW)).toBeNull();
  });
});

describe("plainHostFailure", () => {
  it("rewords what older servers send", () => {
    expect(plainHostFailure("mac-studio", "GOAT on mac-studio is unavailable: fetch failed")).toBe(
      "GOAT on mac-studio did not answer; the connection failed before a reply.",
    );
    expect(plainHostFailure("mac-studio", "host_unavailable")).toBe(
      "GOAT on mac-studio did not answer; the connection failed before a reply.",
    );
    expect(
      plainHostFailure("mac-studio", "mac-studio did not answer goat_host_status within 10s."),
    ).toBe("GOAT on mac-studio is reachable but too busy to answer in time.");
  });

  it("keeps a current server's plain sentence", () => {
    const sentence =
      "mac-studio cannot be reached on the network. Check that it is awake and online.";
    expect(plainHostFailure("mac-studio", sentence)).toBe(sentence);
  });
});
