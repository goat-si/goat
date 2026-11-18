import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@goat/contracts";

import { shouldPrepareLegacyImportHandoff } from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});

it("does not send imported history into the same native ACP session", () => {
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      providerThread: {
        driver: ProviderDriverKind.make("acpRegistry"),
        nativeThreadRef: {
          driver: ProviderDriverKind.make("acpRegistry"),
          nativeId: "native",
          strength: "strong",
        },
      },
      hasCompletedRun: false,
      historyOrigin: "v1_import",
      legacyImportItemCount: 3,
    }),
  );
});
