import { it } from "@effect/vitest";
import { acpMemoryDelivery } from "./memoryDelivery.testkit.ts";

it.live.each(["before", "after"] as const)(
  "counts memory once only if the ACP peer sent output before disconnecting (%s)",
  (crash) => acpMemoryDelivery("acp", false, crash),
);
