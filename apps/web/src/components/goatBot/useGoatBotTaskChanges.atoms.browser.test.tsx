import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

// The server end of one fake connection: how many streams it opened and closed.
const server = vi.hoisted(() => ({
  refuse: false,
  opened: 0,
  closed: 0,
  onClosed: (): void => {},
}));
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
  const contracts = await import("@goat/contracts");
  const connection = await import("@goat/client-runtime/connection");
  const { createChannelEnvironmentAtoms } = await import("@goat/client-runtime/state/channels");
  const client = {
    [contracts.CHANNEL_GATEWAY_WS_METHODS.subscribeTaskChanges]: () => {
      server.opened += 1;
      if (server.refuse)
        return Stream.fail(new contracts.ChannelGatewayError({ reason: "stream_unavailable" }));
      return Stream.make({ revision: 0 }).pipe(
        Stream.concat(Stream.never),
        Stream.ensuring(
          Effect.sync(() => {
            server.closed += 1;
            server.onClosed();
          }),
        ),
      );
    },
  };
  const session = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const target = new connection.PrimaryConnectionTarget({
    environmentId: contracts.EnvironmentId.make("env"),
    label: "Test",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  const registry = {
    followStream: (_id: unknown, stream: Parameters<typeof Stream.provideService>[0]) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = {
            target,
            state: yield* SubscriptionRef.make(connection.AVAILABLE_CONNECTION_STATE),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          };
          return Stream.provideService(
            stream,
            connection.EnvironmentSupervisor.EnvironmentSupervisor,
            supervisor as never,
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

function setup(refuse: boolean) {
  server.refuse = refuse;
  server.opened = 0;
  server.closed = 0;
  return new Promise<void>((resolve) => {
    server.onClosed = resolve;
  });
}

function Probe({ name }: { readonly name: string }) {
  return <span data-testid={name}>{useGoatBotTaskChanges(environmentId)}</span>;
}

it("shares one stream between views and closes it soon after the last one unmounts", async () => {
  const closed = setup(false);
  {
    await using screen = await render(
      <>
        <Probe name="strip" />
        <Probe name="machines" />
      </>,
      { router: false }, // Nothing here links anywhere.
    );
    await expect.element(screen.getByTestId("strip")).toHaveTextContent("stream:0");
    await expect.element(screen.getByTestId("machines")).toHaveTextContent("stream:0");
    expect(server.opened).toBe(1);
  }
  // Both views are gone; the stream closes once the short idle window passes.
  expect(server.closed).toBe(0);
  await closed;
  expect(server.closed).toBe(1);
});

it("reads again on window focus once the server refuses the stream, without asking again", async () => {
  void setup(true);
  await using screen = await render(<Probe name="strip" />, { router: false }); // No links.
  await expect.element(screen.getByTestId("strip")).toHaveTextContent("visit:0");
  window.dispatchEvent(new Event("focus"));
  await expect.element(screen.getByTestId("strip")).toHaveTextContent("visit:1");
  expect(server.opened).toBe(1);
});
