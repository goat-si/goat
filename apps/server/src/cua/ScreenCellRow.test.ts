import { describe, expect, it } from "@effect/vitest";

import {
  appSubject,
  inputTitle,
  screenCellSummary,
  screenCellTitle,
  shortcutLabel,
  siteSubject,
  type ScreenCellFacts,
} from "./ScreenCellRow.ts";

const facts = (overrides: Partial<ScreenCellFacts>): ScreenCellFacts => ({
  receipts: [],
  keys: new Map(),
  subjects: [],
  subjectCount: 0,
  end: "completed",
  wallMs: 30_000,
  durationMs: 820,
  ...overrides,
});
const receipt = (
  callId: number,
  method: ScreenCellFacts["receipts"][number]["method"],
  category: ScreenCellFacts["receipts"][number]["category"] = "confirmed",
) => ({ callId, method, category });

describe("ScreenCellRow", () => {
  it("names a key press only when it can't be typed text", () => {
    expect(shortcutLabel({ key: "Enter" })).toBe("Enter");
    expect(shortcutLabel({ key: "Tab", modifiers: ["Shift"] })).toBe("shift+Tab");
    expect(shortcutLabel({ key: "a", modifiers: ["Meta"] })).toBe("cmd+a");
    expect(shortcutLabel({ key: "Z", modifiers: ["control", "shift"] })).toBe("ctrl+shift+z");
    expect(shortcutLabel({ key: "ArrowDown" })).toBe("Down");
    for (const press of [
      { key: "a" },
      { key: "a", modifiers: ["shift"] },
      { key: "e", modifiers: ["option"] },
      { key: "e", modifiers: ["control", "option"] },
      { key: "x", modifiers: ["hyper"] },
      "Enter",
    ])
      expect(shortcutLabel(press)).toBeUndefined();
  });

  it("names a page by its registrable domain and nothing it can't prove is one", () => {
    expect(siteSubject("https://docs.github.com/en/x?token=1")).toBe("github.com");
    expect(siteSubject("https://secret.abc.de/")).toBe("abc.de");
    expect(siteSubject("http://127.0.0.1:3000/")).toBe("localhost");
    expect(siteSubject("http://localhost:5173/")).toBe("localhost");
    for (const url of [
      "https://secret.internal/",
      "https://a.b.corp/",
      "https://foo.co.uk/",
      "http://10.0.0.5/",
      "http://intranet/",
      "http://[2001:db8::1]/",
      "not a url",
    ])
      expect(siteSubject(url)).toBe("web page");
  });

  it("keeps an app name on one line and drops one with control characters", () => {
    expect(appSubject({ name: "Kakao\nTalk" })).toBe("Kakao Talk");
    expect(appSubject({ name: "Bad\u0007Name" })).toBe("app");
    expect(appSubject({ name: "/usr/bin/xterm" })).toBe("app");
    expect(appSubject({ bundleId: "com.apple.calculator" })).toBe("com.apple.calculator");
    expect(appSubject({ name: "x".repeat(60) })).toHaveLength(40);
  });

  it("takes a one-line agent title of at most 80 characters", () => {
    expect(inputTitle("  Terminal: run tests ")).toBe("Terminal: run tests");
    for (const title of ["", "  ", "two\nlines", "a\u2028b", "a\u0085b", "x".repeat(81), 42])
      expect(inputTitle(title)).toBeUndefined();
  });

  it("titles a cell by what it touched and did, with verbs counted and capped at three", () => {
    const typed = facts({
      subjects: ["Terminal"],
      subjectCount: 1,
      receipts: [
        receipt(1, "get_window_state"),
        receipt(2, "type_text"),
        receipt(3, "press_key"),
        receipt(4, "press_key"),
        receipt(5, "press_key"),
      ],
      keys: new Map([
        [3, "Enter"],
        [4, "Enter"],
        [5, "Enter"],
      ]),
    });
    expect(screenCellTitle(typed)).toBe("Terminal · type, press Enter ×3");
    expect(
      screenCellTitle(
        facts({
          subjects: ["KakaoTalk"],
          subjectCount: 1,
          receipts: ["click", "type_text", "scroll", "drag"].map((method, index) =>
            receipt(index, method as "click"),
          ),
        }),
      ),
    ).toBe("KakaoTalk · click, type, scroll");
    expect(
      screenCellTitle(
        facts({ subjects: ["github.com"], subjectCount: 1, receipts: [receipt(1, "observe")] }),
      ),
    ).toBe("github.com · observe");
    expect(
      screenCellTitle(
        facts({
          subjects: ["Finder", "TextEdit", "Notes"],
          subjectCount: 3,
          receipts: [receipt(1, "click")],
        }),
      ),
    ).toBe("Finder + TextEdit +1 · click");
    expect(screenCellTitle(facts({}))).toBeUndefined();
    // A key press that could be text is never named.
    expect(
      screenCellTitle(
        facts({ subjects: ["Terminal"], subjectCount: 1, receipts: [receipt(1, "press_key")] }),
      ),
    ).toBe("Terminal · press key");
  });

  it("tags how a cell ended and what it refused", () => {
    const base = {
      subjects: ["Terminal"],
      subjectCount: 1,
      receipts: [receipt(1, "click", "refused")],
    };
    expect(screenCellTitle(facts({ ...base, end: "deadline", wallMs: 20_000 }))).toBe(
      "Terminal · click · deadline 20 s · 1 refused",
    );
    expect(screenCellTitle(facts({ ...base, end: "deadline", wallMs: 1_500 }))).toBe(
      "Terminal · click · deadline 1.5 s · 1 refused",
    );
    expect(screenCellTitle(facts({ ...base, end: "limit" }))).toContain("· limit");
    expect(screenCellTitle(facts({ ...base, end: "stopped" }))).toContain("· stopped");
    expect(screenCellTitle(facts({ ...base, end: "failed" }))).toContain("· failed");
    expect(screenCellTitle(facts({ ...base, end: "unknown" }))).toContain("· unknown outcome");
  });

  it("keeps a long title within 160 characters", () => {
    const label = `${"a".repeat(63)}.com`;
    const title = screenCellTitle(
      facts({
        subjects: [label, `b${label}`],
        subjectCount: 5,
        end: "deadline",
        receipts: ["click", "type_text", "scroll", "click"].map((method, index) =>
          receipt(index, method as "click", "refused"),
        ),
      }),
    );
    expect(title?.length).toBeLessThanOrEqual(160);
    expect(title?.startsWith(`${label} +4 · `)).toBe(true);
  });

  it("summarizes every receipt by outcome, reads included, then the time taken", () => {
    const summary = screenCellSummary(
      facts({
        durationMs: 1234,
        receipts: [
          receipt(1, "observe", "confirmed"),
          receipt(2, "click", "confirmed"),
          receipt(3, "click", "partial"),
          receipt(4, "click", "unverifiable"),
          receipt(5, "click", "suspected_noop"),
          receipt(6, "click", "refused"),
          receipt(7, "click", "unknown_outcome"),
        ],
      }),
    );
    expect(summary).toBe(
      "2 confirmed · 1 partial · 1 unverifiable · 1 no-op · 1 refused · 1 unknown · 1.2 s",
    );
    expect(screenCellSummary(facts({ durationMs: 320 }))).toBe("320 ms");
  });
  it("summarizes window observations separately from driver outcomes", () => {
    const summary = screenCellSummary(
      facts({
        receipts: [
          {
            ...receipt(1, "click", "unverifiable"),
            observedEffect: { state: "change_seen", rows: ['~ AXStaticText = "8"'] },
          },
          {
            ...receipt(2, "click", "unverifiable"),
            observedEffect: { state: "no_change_seen", rows: [] },
          },
        ],
      }),
    );
    expect(summary).toContain("2 unverifiable · 1 window change seen · 1 no window change seen");
  });
});

it("names tab operation receipts without exposing their arguments", () => {
  const actions = [
    ["tab_dialog", "dialog"],
    ["tab_upload", "upload"],
    ["tab_evaluate", "evaluate"],
    ["tab_fill_secret", "fill secret"],
    ["tab_logs", "observe"],
  ] as const;
  for (const [method, verb] of actions)
    expect(
      screenCellTitle(
        facts({ subjects: ["site.test"], subjectCount: 1, receipts: [receipt(1, method)] }),
      ),
    ).toBe(`site.test · ${verb}`);
});
