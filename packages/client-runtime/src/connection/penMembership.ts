import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { DesktopPenMember, DesktopPenMembersState } from "@goat/contracts";
import { PenMembersGateway, type PenMembersInput } from "../platform/capabilities.ts";
import { ConnectionBlockedError } from "./model.ts";

type Owner = { readonly meshId: string; readonly nodeId: string };
export class PenMembership extends Context.Service<
  PenMembership,
  {
    readonly latest: SubscriptionRef.SubscriptionRef<Option.Option<PenMembersInput>>;
    readonly admit: (owner: Owner) => Effect.Effect<void, ConnectionBlockedError>;
  }
>()("@goat/client-runtime/connection/penMembership/PenMembership") {}
export const trustedPenMember = (
  state: PenMembersInput,
  owner: Owner,
): DesktopPenMember | undefined =>
  state.kind === "ready" && state.meshId === owner.meshId
    ? state.members.find(
        (member) => member.nodeId === owner.nodeId && member.route.kind === "trusted",
      )
    : undefined;

const make = Effect.gen(function* () {
  const gateway = yield* PenMembersGateway;
  const latest = yield* SubscriptionRef.make<Option.Option<PenMembersInput>>(Option.none());
  let desktop: DesktopPenMembersState | undefined;
  let enabled: boolean | undefined;
  const current = () =>
    enabled === undefined
      ? Option.none()
      : !enabled
        ? Option.some<PenMembersInput>({ kind: "disabled" })
        : Option.fromNullishOr(desktop);
  yield* gateway.desktop.pipe(
    Stream.runForEach((state) =>
      SubscriptionRef.update(latest, (previous) => {
        if (desktop !== undefined && state.seq <= desktop.seq) return previous;
        desktop = state;
        return current();
      }),
    ),
    Effect.forkScoped,
  );
  yield* gateway.enabled.pipe(
    Stream.runForEach((value) =>
      SubscriptionRef.update(latest, () => {
        enabled = value;
        return current();
      }),
    ),
    Effect.forkScoped,
  );

  const awaitFirstState = SubscriptionRef.changes(latest).pipe(
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map((value) => Option.getOrThrow(Option.getOrThrow(value))),
  );
  const admit = Effect.fn("PenMembership.admit")(function* (owner: Owner) {
    const state = yield* awaitFirstState;
    const detail =
      state.kind === "disabled"
        ? "Pen machines are turned off in Settings."
        : state.kind === "not-member"
          ? "This machine is no longer in the Pen mesh."
          : state.kind === "ready" && state.meshId !== owner.meshId
            ? "This machine belongs to another Pen mesh."
            : state.kind === "ready" && !trustedPenMember(state, owner)
              ? "That machine is no longer a trusted Pen member."
              : undefined;
    if (detail !== undefined)
      return yield* new ConnectionBlockedError({ reason: "configuration", detail });
  });
  return { latest, admit };
});

export const layer: Layer.Layer<PenMembership> = Layer.effect(PenMembership, make);
