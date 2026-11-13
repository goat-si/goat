import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewAutomationClickInput,
  PreviewAutomationHistoryInput,
  PreviewAutomationReloadInput,
  PreviewAutomationScrollInput,
  PreviewAutomationWaitForInput,
} from "./previewAutomation.ts";

const decodeHistory = Schema.decodeSync(PreviewAutomationHistoryInput);
const decodeReload = Schema.decodeSync(PreviewAutomationReloadInput);
const decodeUnknownReload = Schema.decodeUnknownSync(PreviewAutomationReloadInput);

it("accepts default history readiness and opt-in reload cache bypass", () => {
  expect(decodeHistory({})).toEqual({});
  expect(
    decodeReload({
      tabId: "tab-1",
      ignoreCache: true,
      readiness: "domContentLoaded",
      timeoutMs: 2_000,
    }),
  ).toEqual({
    tabId: "tab-1",
    ignoreCache: true,
    readiness: "domContentLoaded",
    timeoutMs: 2_000,
  });
});

it("rejects immediate history responses, unbounded timeouts and non-boolean cache bypass", () => {
  for (const input of [
    { readiness: "none" },
    { timeoutMs: 0 },
    { timeoutMs: 60_001 },
    { ignoreCache: "true" },
  ])
    expect(() => decodeUnknownReload(input)).toThrow();
});

describe("PreviewAutomationWaitForInput", () => {
  const decode = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);

  it("accepts a load milestone without a locator", () => {
    expect(decode({ loadState: "domContentLoaded" })).toEqual({ loadState: "domContentLoaded" });
  });

  it.each(["attached", "visible", "hidden", "detached"])("accepts locator state %s", (state) => {
    expect(decode({ locator: "#dialog", state })).toEqual({ locator: "#dialog", state });
  });

  it("keeps existing conjunctions and rejects incomplete or contradictory targets", () => {
    const legacy = { selector: "#done", text: "Done", urlIncludes: "#done" };
    expect(decode(legacy)).toEqual(legacy);
    for (const input of [
      {},
      { state: "hidden", text: "Done" },
      { selector: "#one", locator: "#two" },
      { locator: "#one", state: "missing" },
      { loadState: "commit" },
      { loadState: "load", timeoutMs: 0 },
      { loadState: "networkIdle", timeoutMs: 60_001 },
    ])
      expect(() => decode(input)).toThrow();
    expect(decode({ loadState: "networkIdle", timeoutMs: 60_000 }).timeoutMs).toBe(60_000);
  });

  it("takes a URL glob or a download alone, as conditions on the tab", () => {
    expect(decode({ urlGlob: "**/done*" })).toEqual({ urlGlob: "**/done*" });
    expect(decode({ download: true })).toEqual({ download: true });
    const both = { urlIncludes: "/done", urlGlob: "https://app.test/*", download: true };
    expect(decode(both)).toEqual(both);
    for (const input of [{ download: false }, { urlGlob: " " }, { urlGlob: "x".repeat(2049) }])
      expect(() => decode(input)).toThrow();
  });
});

describe("PreviewAutomationClickInput", () => {
  const decode = Schema.decodeUnknownSync(PreviewAutomationClickInput);

  it("takes a wanted checked state and held modifier keys on an element click", () => {
    const input = { locator: "#terms", checked: true, modifiers: ["Shift", "Meta"] };
    expect(decode(input)).toEqual(input);
    expect(decode({ x: 4, y: 8, modifiers: ["Control"] })).toEqual({
      x: 4,
      y: 8,
      modifiers: ["Control"],
    });
  });

  it("refuses checked without an element or with anything but one left click", () => {
    for (const input of [
      { x: 4, y: 8, checked: true },
      { locator: "#terms", checked: false, button: "right" },
      { locator: "#terms", checked: true, clickCount: 2 },
      { locator: "#terms", checked: "yes" },
      { locator: "#terms", modifiers: ["Super"] },
    ])
      expect(() => decode(input)).toThrow();
  });
});

describe("PreviewAutomationScrollInput", () => {
  const decode = Schema.decodeUnknownSync(PreviewAutomationScrollInput);

  it("takes a locator alone, to bring that element into view", () => {
    expect(decode({ locator: "#footer" })).toEqual({ locator: "#footer" });
    expect(decode({ selector: "#footer", deltaY: 200 })).toEqual({
      selector: "#footer",
      deltaY: 200,
    });
  });

  it("still needs a delta for the page or a point, and one target kind", () => {
    for (const input of [
      {},
      { x: 10, y: 10 },
      { x: 10, deltaY: 5 },
      { locator: "#a", selector: "#b" },
      { locator: "#a", x: 1, y: 2, deltaY: 5 },
    ])
      expect(() => decode(input)).toThrow();
  });
});
