import { expect, it } from "@effect/vitest";

import { ocxMessage } from "./ocxMessage.ts";

it("names a refused link add the way OpenCodex printed it (G6)", () => {
  expect(
    ocxMessage("⚠️  catalog stale\nError: Remote Link failed during Child restart preflight\n"),
  ).toBe("Remote Link failed during Child restart preflight");
});

it("drops the remote hint after a known phase, so the Child's text never passes through", () => {
  expect(
    ocxMessage(
      "Error: Remote Link failed during Child relay verification: token=s3cr3t-value https://user:pw@host/x. Run ocx disconnect and ocx restart on the Child before retrying.",
    ),
  ).toBe(
    "Remote Link failed during Child relay verification. Run ocx disconnect and ocx restart on the Child before retrying.",
  );
});

it("passes a desktop-owned restart refusal through, even wrapped in terminal colours", () => {
  expect(
    ocxMessage(
      "\u001b[31mRestart not performed; the running client runtime was kept. The OpenCodex desktop app owns it: restart it from the app.\u001b[0m",
    ),
  ).toBe(
    "Restart not performed; the running client runtime was kept. The OpenCodex desktop app owns it: restart it from the app.",
  );
});

it("passes a known disconnect code and refuses unknown text, codes and secrets", () => {
  expect(ocxMessage("Error: client_catalog_ownership_changed")).toBe(
    "client_catalog_ownership_changed",
  );
  expect(ocxMessage("Error: client_new_unknown_code")).toBeUndefined();
  expect(ocxMessage("Error: pairing ocx_pair_ABCDEFGHIJKLMNOPQRSTUV failed")).toBeUndefined();
  expect(ocxMessage("Error: Remote Link failed during something invented")).toBeUndefined();
  expect(ocxMessage("")).toBeUndefined();
});
