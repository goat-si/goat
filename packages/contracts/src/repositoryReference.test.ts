import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { RepositoryReferenceRequest, RepositoryReferences } from "./repositoryReference.ts";

const decode = Schema.decodeUnknownSync(RepositoryReferenceRequest, { onExcessProperty: "error" });
const decodeBrief = Schema.decodeUnknownSync(RepositoryReferences, { onExcessProperty: "error" });
const reference = {
  mode: "snapshot",
  repositoryKey: "example.test/owner/repo",
  files: ["src/index.ts"],
};

it("admits only bounded explicit snapshot references, never runtime path or write grants", () => {
  expect(decode(reference)).toEqual(reference);
  for (const input of [
    { ...reference, mode: "read-only-root" },
    { ...reference, access: "write" },
    { ...reference, revision: "HEAD; touch /tmp/never" },
    { ...reference, files: [] },
    { ...reference, files: Array(9).fill("src/index.ts") },
    ...["../secret", "/secret", "a/../../secret", ".git/config", "C:\\secret", "a\0b"].map(
      (path) => ({ ...reference, files: [path] }),
    ),
  ])
    expect(() => decode(input)).toThrow();
  expect(() => decodeBrief(Array.from({ length: 5 }, () => ({ ...reference })))).toThrow();
});
