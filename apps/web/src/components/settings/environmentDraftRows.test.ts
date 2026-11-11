import type { ProviderInstanceEnvironmentVariable } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeEnvironmentDraftRow,
  nextEnvironmentVariableDraftId,
  reseedEnvironmentRows,
} from "./environmentDraftRows";

const variable = (name: string, value: string): ProviderInstanceEnvironmentVariable =>
  ({ name, value, sensitive: false }) as ProviderInstanceEnvironmentVariable;
const draft = (name: string, value: string) => ({
  id: nextEnvironmentVariableDraftId(),
  name,
  value,
  sensitive: true,
});

describe("reseedEnvironmentRows", () => {
  it("keeps an unpublished row that duplicates a published name across a re-delivery", () => {
    const published = [variable("API_KEY", "one")];
    const typed = draft("API_KEY", "two");
    const rows = [...published.map(makeEnvironmentDraftRow), typed];
    const next = reseedEnvironmentRows(published, published)(rows);
    expect(next).toContainEqual(typed);
  });

  it("drops only as many typed rows as the delivery newly published", () => {
    const first = draft("TOKEN", "a");
    const second = draft("TOKEN", "b");
    const next = reseedEnvironmentRows([variable("TOKEN", "a")], [])([first, second]);
    expect(next.filter((row) => row.name === "TOKEN")).toHaveLength(2);
    expect(next).toContainEqual(second);
    expect(next).not.toContainEqual(first);
  });
});
