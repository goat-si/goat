import { RegistryContext, scheduleTask } from "@effect/atom-react";
import { EnvironmentId } from "@goat/contracts";
import type { Option as SessionOption } from "effect/Option";
import { AtomRegistry } from "effect/reactivity";
import type { SubscriptionRef as SessionRef } from "effect/SubscriptionRef";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

/** What the server end of the fake connection does for one test, and what it saw. */
interface ServerRecord {
  mode: "serve" | "refuse" | "defect";
  opened: number;
  closed: number;
  onClosed: () => void;
  /** Replaces the connection's session, as a reconnect does. */
  newSession: () => void;
}
// Each test gets its own record; a stream a previous test left behind counts against that test.
const server = vi.hoisted(() => ({ current: null as unknown as ServerRecord }));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: { environment: { capabilities: { goatBotTaskChanges: true } } },
  }),
}));
// The real channel atoms over a fake environment, so sharing, idle close and refusal are the
// runtime's own. Only the read grant is fixed.
vi.mock("~/state/channels", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const RpcClientError = await import("effect/rpc/RpcClientError");
  const contracts = await import("@goat/contracts");
  const connection = await import("@goat/client-runtime/connection");
  const { createChannelEnvironmentAtoms } = await import("@goat/client-runtime/state/channels");
  const makeClient = (record: ServerRecord) => ({
    [contracts.CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges]: () => {
      record.opened += 1;
      if (record.mode === "refuse")
        return Stream.fail(new contracts.ChannelGatewayError({ reason: "stream_unavailable" }));
      const after =
        record.mode === "defect"
          ? Stream.fail(
              new RpcClientError.RpcClientError({
                reason: new RpcClientError.RpcClientDefect({
                  message: "decode failed",
                  cause: new Error("decode failed"),
                }),
              }),
            )
          : Stream.never;
      return Stream.make({ revision: 0 }).pipe(
        Stream.concat(after),
        Stream.ensuring(
          Effect.sync(() => {
            record.closed += 1;
            record.onClosed();
          }),
        ),
      );
    },
  });
  const makeSession = (record: ServerRecord) => ({
    client: makeClient(record),
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  });
  const target = new connection.PrimaryConnectionTarget({
    environmentId: contracts.EnvironmentId.make("env"),
    label: "Test",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  // Each call of record.newSession replaces the session, for as long as the stream runs.
  const reconnects = (session: SessionRef<SessionOption<unknown>>, record: ServerRecord) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          record.newSession = resolve;
        }),
    ).pipe(
      Effect.andThen(SubscriptionRef.set(session, Option.some(makeSession(record)))),
      Effect.forever,
    );
  const registry = {
    followStream: (_id: unknown, stream: Parameters<typeof Stream.provideService>[0]) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const record = server.current;
          const session = yield* SubscriptionRef.make<SessionOption<unknown>>(
            Option.some(makeSession(record)),
          );
          const supervisor = {
            target,
            state: yield* SubscriptionRef.make(connection.AVAILABLE_CONNECTION_STATE),
            session,
            prepared: yield* SubscriptionRef.make(Option.none()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          };
          return Stream.merge(
            Stream.provideService(
              stream,
              connection.EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor as never,
            ),
            Stream.fromEffect(reconnects(session, record)).pipe(Stream.drain),
          );
        }),
      ),
  };
  const atoms = createChannelEnvironmentAtoms(
    Atom.runtime(
      Layer.succeed(connection.EnvironmentRegistry.EnvironmentRegistry, registry as never),
    ),
  );
  return { channelEnvironment: { ...atoms, taskChangesPermission: () => Atom.make(true) } };
});
import { useGoatBotTaskChanges } from "./useGoatBotTaskChanges";

const environmentId = EnvironmentId.make("env");

/**
 * A fresh fake server and atom registry for one test. `closed` settles when the server first
 * closes a stream; disposing the test closes whatever is still open.
 */
function setup(mode: ServerRecord["mode"]) {
  let closedOnce = (): void => {};
  const closed = new Promise<void>((resolve) => {
    closedOnce = resolve;
  });
  const record: ServerRecord = {
    mode,
    opened: 0,
    closed: 0,
    onClosed: () => closedOnce(),
    newSession: () => {
      throw new Error("No stream was opened yet.");
    },
  };
  server.current = record;
  const registry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });
  return {
    server: record,
    closed,
    wrap: (ui: ReactNode) => (
      <RegistryContext.Provider value={registry}>{ui}</RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

function Probe({ name }: { readonly name: string }) {
  return <span data-testid={name}>{useGoatBotTaskChanges(environmentId)}</span>;
}

// Nothing here links anywhere, so no test needs the router.
const noRouter = { router: false } as const;
/** Waits for a subscription's revision 0; the signal may also name the subscription. */
const acknowledged = (locator: { element: () => Element }) =>
  vi.waitFor(() => expect(locator.element().textContent).toMatch(/^stream:(\d+:)?0$/));

it("shares one stream between views and closes it soon after the last one unmounts", async () => {
  using test = setup("serve");
  {
    await using screen = await render(
      test.wrap(
        <>
          <Probe name="strip" />
          <Probe name="machines" />
        </>,
      ),
      noRouter,
    );
    await acknowledged(screen.getByTestId("strip"));
    await acknowledged(screen.getByTestId("machines"));
    expect(test.server.opened).toBe(1);
  }
  // Both views are gone; the stream closes once the short idle window passes.
  expect(test.server.closed).toBe(0);
  await test.closed;
  expect(test.server.closed).toBe(1);
});

it("keeps the one stream when a view comes back inside the idle period", async () => {
  using test = setup("serve");
  {
    await using screen = await render(test.wrap(<Probe name="strip" />), noRouter);
    await acknowledged(screen.getByTestId("strip"));
  }
  {
    await using screen = await render(test.wrap(<Probe name="strip" />), noRouter);
    await acknowledged(screen.getByTestId("strip"));
    expect(test.server.opened).toBe(1);
    expect(test.server.closed).toBe(0);
  }
  await test.closed;
  expect(test.server.closed).toBe(1);
});

it("reads again on window focus once the server refuses the stream, without asking again", async () => {
  using test = setup("refuse");
  await using screen = await render(test.wrap(<Probe name="strip" />), noRouter);
  await expect.element(screen.getByTestId("strip")).toHaveTextContent("visit:0");
  window.dispatchEvent(new Event("focus"));
  await expect.element(screen.getByTestId("strip")).toHaveTextContent("visit:1");
  expect(test.server.opened).toBe(1);
});

it("asks again when a new session starts after a refusal", async () => {
  using test = setup("refuse");
  await using screen = await render(test.wrap(<Probe name="strip" />), noRouter);
  await expect.element(screen.getByTestId("strip")).toHaveTextContent("visit:0");
  test.server.mode = "serve";
  test.server.newSession();
  await acknowledged(screen.getByTestId("strip"));
  expect(test.server.opened).toBe(2);
});

it("reads again on window focus once the stream fails on the client side", async () => {
  using test = setup("defect");
  await using screen = await render(test.wrap(<Probe name="strip" />), noRouter);
  await expect.element(screen.getByTestId("strip")).toHaveTextContent("visit:0");
  window.dispatchEvent(new Event("focus"));
  await expect.element(screen.getByTestId("strip")).toHaveTextContent("visit:1");
  expect(test.server.opened).toBe(1);
});

it("gives a new session's first revision a new signal, so views read again after a reconnect", async () => {
  using test = setup("serve");
  await using screen = await render(test.wrap(<Probe name="strip" />), noRouter);
  const strip = screen.getByTestId("strip");
  await acknowledged(strip);
  const first = strip.element().textContent ?? "";
  test.server.newSession();
  await vi.waitFor(() => expect(test.server.opened).toBe(2));
  await expect.element(strip).not.toHaveTextContent(first);
  await acknowledged(strip);
});
