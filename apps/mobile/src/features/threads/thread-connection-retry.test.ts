import { expect, it } from "vite-plus/test";
import { connectionRetryLabel } from "./thread-connection-retry";
import { connectionFloatingStatus } from "./connection-floating-status";

it("presents retry in the thread header until connected", () => {
  expect(connectionRetryLabel({ connectionState: "connecting", connectionError: null })).toBe(
    "Reconnecting…",
  );
  expect(connectionRetryLabel({ connectionState: "reconnecting", connectionError: "lost" })).toBe(
    "Retrying connection…",
  );
  expect(connectionRetryLabel({ connectionState: "connected", connectionError: null })).toBeNull();
});

it("does not place an automatic retry in the composer's floating status", () => {
  expect(
    connectionFloatingStatus({
      connectionState: "reconnecting",
      connectionError: null,
      environmentLabel: "Host",
      onReconnect: () => {},
    }),
  ).toBeNull();
});
