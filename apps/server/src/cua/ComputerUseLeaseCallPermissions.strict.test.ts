import { describe, expect, it } from "vite-plus/test";

import { parse } from "./ComputerUseLeaseProtocol.ts";
import { proxyCallAdmission } from "./ComputerUseLeaseCallPermissions.ts";
import type { ListedApp } from "./ComputerUseScope.ts";

const PID = 4100;
const CLICK =
  parse(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "click", arguments: { pid: PID, window_id: 9, x: 1, y: 1 } },
    }),
  ) ?? {};
const listed = (app: string) =>
  new Map<number, ListedApp>([[PID, { id: app, bundleId: app, name: "App" }]]);
const admitted = (strictInputGuards?: false) =>
  ({
    status: "admitted",
    reservationId: "reservation:1",
    permissions: {
      apps: ["com.example.Editor"],
      validUntilMillis: 1_000,
      ...(strictInputGuards === undefined ? {} : { strictInputGuards }),
    },
  }) as const;
const refusedAs = (value: unknown) => JSON.stringify(value ?? null);

describe("an admission reply's scope follows the strict input guards it carries", () => {
  it("refuses an app outside the approved list only with strict guards", () => {
    const other = listed("com.example.Other");
    expect(refusedAs(proxyCallAdmission(1, CLICK, admitted(), other, true).refused)).toContain(
      "app_not_approved",
    );
    expect(proxyCallAdmission(1, CLICK, admitted(false), other, true).refused).toBeUndefined();
  });
  it.each([true, false])(
    "keeps protected apps out of reach only under strict guards (%s)",
    (strict) => {
      const refused = proxyCallAdmission(
        1,
        CLICK,
        admitted(strict ? undefined : false),
        listed("com.apple.keychainaccess"),
        true,
      );
      if (strict) expect(refusedAs(refused.refused)).toContain("app_not_allowed");
      else expect(refused.refused).toBeUndefined();
    },
  );
});
