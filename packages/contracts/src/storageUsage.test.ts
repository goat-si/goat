import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { StorageItem } from "./storageUsage.ts";

const group = {
  id: "rotated_logs:/logs",
  kind: "rotated_logs",
  path: "/logs",
  label: "2 rotated log files",
  bytes: 7,
  state: "removable",
  selected: true,
  reason: "Expired",
  token: "token",
} as const;

it("round trips storage groups with and without individual file paths and sizes", () => {
  const codec = Schema.fromJsonString(StorageItem);
  const old = Schema.decodeSync(codec)(JSON.stringify(group));
  expect(old.files).toBeUndefined();
  const files = [
    { path: "/logs/a", bytes: 3 },
    { path: "/logs/b", bytes: 4 },
  ];
  const decoded = Schema.decodeSync(codec)(JSON.stringify({ ...group, files }));
  expect(decoded.files).toEqual(files);
  expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(decoded)).files).toEqual(files);
});
