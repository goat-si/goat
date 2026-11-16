import type { EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";
import { EnvironmentId } from "@goat/contracts";
import type { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const page = vi.hoisted(() => ({ cookie: true }));

vi.mock("../../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null) };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
vi.mock("./auth", () => ({
  isPrimaryAuthGateAuthenticated: () => page.cookie,
  probePrimarySession: () => Promise.resolve("revoked"),
}));
vi.mock("./httpLayer", () => ({ isSameOriginBrowserPrimary: () => true }));
vi.mock("../../lib/documentActivity", () => ({
  getDocumentActivity: () => ({ visible: true }),
  subscribeDocumentActivity: () => () => {},
}));

type Connection = Pick<EnvironmentConnectionPresentation, "phase" | "failure">;

const STUDIO = EnvironmentId.make("studio");
const LAPTOP = EnvironmentId.make("laptop");
const connected: Connection = { phase: "connected" };
const retrying: Connection = { phase: "connecting" };
const dropped: Connection = {
  phase: "reconnecting",
  failure: { kind: "retrying", reason: "transport", detail: "Socket closed" },
};
const refused = (reason: "authentication" | "permission"): Connection => ({
  phase: "error",
  failure: {
    kind: "blocked",
    reason,
    detail: "This browser is no longer signed in to Mac Studio.",
  },
});

/** This tab's real check, reading its own server's connection from the app's atoms. */
async function setup({ cookie = true }: { cookie?: boolean } = {}) {
  vi.resetModules();
  page.cookie = cookie;
  const { appAtomRegistry } = await import("../../rpc/atomRegistry");
  const { primaryEnvironmentIdAtom } = await import("../../state/primaryEnvironment");
  const { environmentPresentations } = await import("../../state/presentation");
  const { primarySessionCheck } = await import("./sessionCheck");
  const show = (environmentId: EnvironmentId, connection: Connection) => {
    appAtomRegistry.set(
      primaryEnvironmentIdAtom as unknown as Atom.Writable<EnvironmentId | null>,
      environmentId,
    );
    appAtomRegistry.set(
      environmentPresentations.presentationsAtom as unknown as Atom.Writable<
        ReadonlyMap<EnvironmentId, { readonly connection: Connection }>
      >,
      new Map([[environmentId, { connection }]]),
    );
  };
  let notified = 0;
  primarySessionCheck.subscribe(() => {
    notified += 1;
  });
  return { revoked: primarySessionCheck.revoked, show, notified: () => notified };
}

it("a cookie tab refused by its own server stays refused through Retry and a later transport failure until it connects (#3473, steady refusal)", async () => {
  const tab = await setup();
  tab.show(STUDIO, connected);
  expect(tab.revoked()).toBe(false);
  tab.show(STUDIO, refused("authentication"));
  expect(tab.revoked()).toBe(true);
  // Retry clears the connection's failure for the new attempt.
  tab.show(STUDIO, retrying);
  expect(tab.revoked()).toBe(true);
  tab.show(STUDIO, dropped);
  expect(tab.revoked()).toBe(true);
  tab.show(STUDIO, connected);
  expect(tab.revoked()).toBe(false);
  expect(tab.notified()).toBe(2);
});

it.each([
  ["a tab not signed in by cookie", { cookie: false }, "authentication"],
  ["a permission refusal", {}, "permission"],
] as const)("%s is never held (#3473, guard)", async (_case, options, reason) => {
  const tab = await setup(options);
  tab.show(STUDIO, refused(reason));
  tab.show(STUDIO, retrying);
  expect(tab.revoked()).toBe(false);
});

it("a new primary does not inherit the refusal (#3499, guard)", async () => {
  const tab = await setup();
  tab.show(STUDIO, refused("authentication"));
  expect(tab.revoked()).toBe(true);
  tab.show(LAPTOP, retrying);
  expect(tab.revoked()).toBe(false);
});
