import { AuthSessionId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../auth/SessionStore.ts";

export const probeSessionId = AuthSessionId.make("probe-reviewer");
export const probeClient = Layer.mock(SessionStore.SessionStore)({
  cookieName: "test",
  legacyCookieName: undefined,
  listActive: () =>
    Effect.succeed([
      {
        sessionId: probeSessionId,
        subject: "reviewer",
        method: "browser-session-cookie",
        scopes: ["settings:write"],
        client: { label: "Reviewer", deviceType: "unknown" },
        issuedAt: DateTime.makeUnsafe(0),
        expiresAt: DateTime.makeUnsafe(9999999999999),
        lastConnectedAt: null,
        connected: true,
        current: true,
      },
    ]),
});
