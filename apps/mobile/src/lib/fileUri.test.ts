import { describe, expect, it } from "vite-plus/test";

import { localFileUri } from "./fileUri";

describe("localFileUri", () => {
  it.each([
    ["/data/data/si.goat.mobile/files/SQLite", "file:///data/data/si.goat.mobile/files/SQLite"],
    ["/var/mobile/My Files/#1/a?b%", "file:///var/mobile/My%20Files/%231/a%3Fb%25"],
    ["file:///already/a%20uri", "file:///already/a%20uri"],
  ])("turns %s into a file URI expo-file-system accepts", (input, expected) => {
    expect(localFileUri(input)).toBe(expected);
  });

  it("refuses a relative path", () => {
    expect(() => localFileUri("SQLite/goat-client.db")).toThrow("Not an absolute path");
  });
});
