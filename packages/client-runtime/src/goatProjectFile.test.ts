import { ProjectReadFileError } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { goatProjectFileReadPath } from "./goatProjectFile.ts";

const encodeReadError = Schema.encodeSync(ProjectReadFileError);
const decodeReadError = Schema.decodeUnknownSync(ProjectReadFileError);

function readError(
  code: string,
  operation: "realpath-target" | "realpath-workspace-root" = "realpath-target",
) {
  return new ProjectReadFileError({
    cwd: "/repo",
    relativePath: "goat.json",
    failure: "operation_failed",
    operation,
    cause: new Error("Workspace operation failed", {
      cause: Object.assign(new Error(`${code}: file operation failed`), { code }),
    }),
  });
}

describe("project file choice", () => {
  it("prefers an existing goat.json even when it is invalid or truncated", () => {
    expect(goatProjectFileReadPath({ contents: "{ invalid", truncated: false }, null)).toBe(
      "goat.json",
    );
    expect(goatProjectFileReadPath({ contents: "", truncated: true }, readError("ENOENT"))).toBe(
      "goat.json",
    );
  });

  it("falls back only after a missing-file read settles", () => {
    expect(goatProjectFileReadPath(null, readError("ENOENT"))).toBe(LEGACY_PROJECT_FILE_NAME);
    expect(goatProjectFileReadPath(null, readError("ENOENT"), true)).toBe("goat.json");
    expect(goatProjectFileReadPath(null, null)).toBe("goat.json");
  });

  it("recognizes missing-file causes after the older server's wire serialization", () => {
    const encoded = encodeReadError(readError("ENOENT"));
    const decoded = decodeReadError(JSON.parse(JSON.stringify(encoded)));
    expect(goatProjectFileReadPath(null, decoded)).toBe(LEGACY_PROJECT_FILE_NAME);
  });

  it("does not fall back for permissions, a directory, or a missing workspace", () => {
    expect(goatProjectFileReadPath(null, readError("EACCES"))).toBe("goat.json");
    expect(goatProjectFileReadPath(null, readError("ENOENT", "realpath-workspace-root"))).toBe(
      "goat.json",
    );
    expect(
      goatProjectFileReadPath(
        null,
        new ProjectReadFileError({
          cwd: "/repo",
          relativePath: "goat.json",
          failure: "path_not_file",
        }),
      ),
    ).toBe("goat.json");
  });
});
