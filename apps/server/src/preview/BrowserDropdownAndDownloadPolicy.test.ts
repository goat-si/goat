import { describe, expect, it } from "vite-plus/test";

import {
  checkSpecialElementClickGuard,
  classifyNetworkDownloadCandidate,
  verifySelectOptionStickiness,
} from "./BrowserDropdownAndDownloadPolicy.ts";

describe("checkSpecialElementClickGuard", () => {
  it.each(["SELECT", " select "])(
    "refuses a %s click and points to goat_preview_select",
    (tagName) => {
      const result = checkSpecialElementClickGuard({ tagName });
      expect(result).toEqual({
        ok: false,
        reason: "select_element",
        message: expect.any(String),
        nothingSent: true,
      });
      if (!result.ok) {
        expect(result.message).toContain("goat_preview_select");
        expect(result.message).not.toContain("(ref ");
        expect(result.message.endsWith("Nothing was clicked.")).toBe(true);
      }
    },
  );

  it("refuses a file input and includes ref 0 and upload guidance", () => {
    const result = checkSpecialElementClickGuard({
      tagName: "input",
      inputType: "FILE",
      selectorIndex: 0,
    });
    expect(result).toEqual({
      ok: false,
      reason: "file_input",
      message:
        "Cannot click a file input (ref 0). Supply its files with goat_preview_upload (tab.upload in screen code) instead. Nothing was clicked.",
      nothingSent: true,
    });
  });

  it.each([{ tagName: "input", inputType: "text" }, { tagName: "button" }, { tagName: "input" }])(
    "allows ordinary element %j",
    (input) => {
      expect(checkSpecialElementClickGuard(input)).toEqual({ ok: true });
    },
  );
});

describe("verifySelectOptionStickiness", () => {
  it.each([
    ["value", "value", 2],
    ["", "", 0],
    ["CA", "CA", 2],
  ])(
    "accepts matching option value %j at index %s",
    (requestedValue, observedValue, observedSelectedIndex) => {
      expect(
        verifySelectOptionStickiness({ requestedValue, observedValue, observedSelectedIndex }),
      ).toEqual({ ok: true });
    },
  );

  it.each([
    ["requested", "changed", 2],
    ["Canada", "CA", 2],
    ["same", "same", -1],
    ["same", "same", 1.5],
    ["same", "same", NaN],
  ])(
    "reports reverted selection for requested %j, observed %j, index %s",
    (requestedValue, observedValue, observedSelectedIndex) => {
      const result = verifySelectOptionStickiness({
        requestedValue,
        observedValue,
        observedSelectedIndex,
      });
      expect(result).toEqual({
        ok: false,
        reason: "select_value_reverted",
        message: expect.any(String),
        requestedValue,
        observedValue,
      });
      expect(result).not.toHaveProperty("nothingSent");
    },
  );
});

describe("classifyNetworkDownloadCandidate", () => {
  const candidate = (
    contentDisposition?: string,
    contentType = "application/octet-stream",
    url = "https://example.com/export",
  ) => ({ url, contentType, contentDisposition });

  it.each(["ftp://example.com/file", "data:text/plain,hello", "not a url"])(
    "rejects non-HTTP or malformed URL %s",
    (url) => {
      expect(
        classifyNetworkDownloadCandidate(candidate(undefined, "application/pdf", url)),
      ).toEqual({ download: false, reason: "not_http" });
    },
  );

  it("downloads PDF MIME types without a disposition", () => {
    expect(
      classifyNetworkDownloadCandidate(candidate(undefined, "application/pdf; charset=binary")),
    ).toEqual({ download: true, reason: "pdf", filename: null });
  });

  it("downloads an inline PDF under its disposition filename", () => {
    expect(
      classifyNetworkDownloadCandidate(
        candidate('inline; filename="Q1 Statement.pdf"', "Application/PDF"),
      ),
    ).toEqual({ download: true, reason: "pdf", filename: "Q1 Statement.pdf" });
  });

  it.each([undefined, "inline", 'inline; note="attachment"'])(
    "rejects a non-attachment disposition %j",
    (contentDisposition) => {
      expect(classifyNetworkDownloadCandidate(candidate(contentDisposition))).toEqual({
        download: false,
        reason: "not_attachment",
      });
    },
  );

  it("preserves the case of an attachment filename", () => {
    expect(
      classifyNetworkDownloadCandidate(candidate('attachment; filename="Report Q1.PDF"')),
    ).toEqual({ download: true, reason: "attachment", filename: "Report Q1.PDF" });
  });

  it("prefers a UTF-8 extended filename over filename", () => {
    expect(
      classifyNetworkDownloadCandidate(
        candidate("attachment; filename=fallback.csv; filename*=UTF-8''%E2%82%AC%20rates.csv"),
      ),
    ).toEqual({ download: true, reason: "attachment", filename: "€ rates.csv" });
  });

  it.each([
    "ISO-8859-1''rates.csv",
    "US-ASCII''rates.csv",
    "UTF-8rates.csv",
    "UTF-8''%FF",
    "UTF-8''%E2%8",
    "UTF-8''",
  ])("falls back to filename when filename* is invalid or unsupported: %s", (extended) => {
    expect(
      classifyNetworkDownloadCandidate(
        candidate(`attachment; filename=fallback.csv; filename*=${extended}`),
      ),
    ).toEqual({ download: true, reason: "attachment", filename: "fallback.csv" });
  });

  it("parses semicolons and escaped quotes inside a quoted filename", () => {
    expect(
      classifyNetworkDownloadCandidate(candidate('attachment; filename="report; \\"Q1\\".csv"')),
    ).toEqual({ download: true, reason: "attachment", filename: 'report; "Q1".csv' });
  });

  it("extracts a basename from slash and backslash paths", () => {
    expect(
      classifyNetworkDownloadCandidate(candidate('attachment; filename="a/b\\\\c.zip"')),
    ).toEqual({ download: true, reason: "attachment", filename: "c.zip" });
  });

  it("uses the suggested filename when filename is empty", () => {
    expect(
      classifyNetworkDownloadCandidate({
        ...candidate('attachment; filename=""'),
        suggestedFilename: "suggested.csv",
      }),
    ).toEqual({ download: true, reason: "attachment", filename: "suggested.csv" });
  });

  it.each([
    ["data.json", "application/json"],
    ["callback.txt", "text/plain"],
    ["download", "application/json"],
  ])("rejects generic text attachment %s with MIME %s", (filename, contentType) => {
    expect(
      classifyNetworkDownloadCandidate(candidate(`attachment; filename=${filename}`, contentType)),
    ).toEqual({ download: false, reason: "generic_text_attachment" });
  });

  it("downloads generic text filenames when the URL has a recognized extension", () => {
    expect(
      classifyNetworkDownloadCandidate(
        candidate(
          "attachment; filename=data.json",
          "application/json",
          "https://example.com/export/data.json",
        ),
      ),
    ).toEqual({ download: true, reason: "attachment", filename: "data.json" });
  });

  it.each([
    ["report.json", "application/json"],
    ["image.png", "image/png"],
  ])("downloads non-generic attachment %s with MIME %s", (filename, contentType) => {
    expect(
      classifyNetworkDownloadCandidate(candidate(`attachment; filename=${filename}`, contentType)),
    ).toEqual({ download: true, reason: "attachment", filename });
  });

  it("returns a null filename when none is available", () => {
    expect(classifyNetworkDownloadCandidate(candidate("attachment"))).toEqual({
      download: true,
      reason: "attachment",
      filename: null,
    });
  });
});
