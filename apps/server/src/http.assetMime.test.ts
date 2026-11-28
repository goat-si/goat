import { it, expect } from "vitest";
import { assetResponseHeaders } from "./http.ts";

it("chooses the sandbox from the same type it serves", () => {
  for (const name of ["page.html", "page.HTM", "page.shtml"]) {
    expect(assetResponseHeaders(`/workspace/${name}`)).toMatchObject({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups allow-downloads",
    });
  }
  expect(assetResponseHeaders("/workspace/page.xhtml")).toMatchObject({
    "Content-Type": "application/xhtml+xml",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  expect(assetResponseHeaders("/workspace/report.docx")).toHaveProperty(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  expect(assetResponseHeaders("/attachments/upload.bin")).toHaveProperty(
    "Content-Type",
    "application/octet-stream",
  );
});
