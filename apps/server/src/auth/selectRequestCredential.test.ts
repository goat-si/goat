import { expect, it } from "@effect/vitest";

import { selectRequestCredential } from "./EnvironmentAuth.ts";
import { legacyScopedSessionCookieName } from "./utils.ts";

it("falls back to the scoped legacy cookie when the primary cookie is empty", () => {
  const cookieName = "goat_session_example";
  const credential = selectRequestCredential(
    {
      cookies: { [cookieName]: "", [legacyScopedSessionCookieName(cookieName)]: "scoped-legacy" },
      headers: {},
    } as never,
    cookieName,
    undefined,
  );
  expect(credential).toEqual({ token: "scoped-legacy", source: "legacy-cookie" });
});
