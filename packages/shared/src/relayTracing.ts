import { isGoatConnectEnabled } from "./goatConnect.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import type { HttpClient } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";

export interface RelayClientTracingConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

export interface RelayClientTracingResource {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly runtime: string;
  readonly serviceInstanceId: string;
  readonly client: string;
  readonly component?: string;
  readonly attributes?: Readonly<Record<string, string>> | undefined;
}

export class RelayClientTracer extends Context.Reference(
  "@goat/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

class LocalTracer extends Context.Reference("@goat/shared/relayTracing/LocalTracer", {
  defaultValue: () => Option.none<Tracer.Tracer>(),
}) {}

/** Export only GOAT Connect spans; wrap local work with {@link withLocalTracing}. */
export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) =>
          Tracer.Tracer.pipe(
            Effect.flatMap((local) =>
              effect.pipe(
                Effect.provideService(Tracer.Tracer, tracer),
                Effect.provideService(LocalTracer, Option.some(local)),
              ),
            ),
          ),
      }),
    ),
  );

/** Keep local work in the local trace without exporting machine details through relay spans. */
export const withLocalTracing = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  LocalTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (local) => effect.pipe(Effect.provideService(Tracer.Tracer, local)),
      }),
    ),
  );

function traceSafeError(): Error {
  const error = new Error("Relay operation failed");
  error.stack = "Error: Relay operation failed";
  return error;
}

function traceSafeExit(exit: Exit.Exit<unknown, unknown>): Exit.Exit<unknown, unknown> {
  if (Exit.isSuccess(exit)) {
    return exit;
  }
  return Exit.failCause(
    Cause.fromReasons(
      exit.cause.reasons.map((reason) => {
        if (Cause.isFailReason(reason)) {
          return Cause.makeFailReason(traceSafeError());
        }
        if (Cause.isDieReason(reason)) {
          return Cause.makeDieReason(traceSafeError());
        }
        return reason;
      }),
    ),
  );
}

const RELAY_SPAN_NAMES = new Set([
  "environment.relay.request",
  "EnvironmentAuth.authenticateHttpRequest",
  "relay.connection.attempt",
  "clientRuntime.managedRelay.authorize",
  "clientRuntime.managedRelay.connectEnvironment",
  "clientRuntime.managedRelay.cooldown",
  "clientRuntime.managedRelay.createEnvironmentLinkChallenge",
  "clientRuntime.managedRelay.deleteAccount",
  "clientRuntime.managedRelay.exchangeAccessToken",
  "clientRuntime.managedRelay.getAccountDeletion",
  "clientRuntime.managedRelay.getAgentActivitySnapshot",
  "clientRuntime.managedRelay.getEnvironmentStatus",
  "clientRuntime.managedRelay.invalidateAccessToken",
  "clientRuntime.managedRelay.linkEnvironment",
  "clientRuntime.managedRelay.listDevices",
  "clientRuntime.managedRelay.listEnvironments",
  "clientRuntime.managedRelay.obtainAccessToken",
  "clientRuntime.managedRelay.readmitKey",
  "clientRuntime.managedRelay.registerDevice",
  "clientRuntime.managedRelay.registerLiveActivity",
  "clientRuntime.managedRelay.resetTokenCache",
  "clientRuntime.managedRelay.tokenCacheCriticalSection",
  "clientRuntime.managedRelay.unlinkEnvironment",
  "clientRuntime.managedRelay.unregisterDevice",
  "clientRuntime.managedRelayAccount.make",
  "clientRuntime.managedRelaySession.deregisterEnvironment",
  "clientRuntime.managedRelaySession.readClerkToken",
]);
const RELAY_NUMERIC_ATTRIBUTES = new Set([
  "http.response.status_code",
  "http.status_code",
  "connection.attempt",
  "connection.generation",
  "connection.retry.failure_count",
  "connection.retry.delay_ms",
]);

function isSafeRelayAttribute(key: string, value: unknown): boolean {
  return (
    (RELAY_NUMERIC_ATTRIBUTES.has(key) && typeof value === "number" && Number.isFinite(value)) ||
    (key === "url.scheme" && (value === "http" || value === "https"))
  );
}

export function nonInterferingTracer(delegate: Tracer.Tracer): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span({
        ...options,
        name: RELAY_SPAN_NAMES.has(options.name) ? options.name : "relay.operation",
        links: options.links.map((link) => ({ ...link, attributes: {} })),
      });
      const attribute = span.attribute.bind(span);
      const addLinks = span.addLinks.bind(span);
      span.attribute = (key, value) => {
        if (isSafeRelayAttribute(key, value)) attribute(key, value);
      };
      span.event = () => {};
      span.addLinks = (links) => addLinks(links.map((link) => ({ ...link, attributes: {} })));
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        try {
          if (span.attributes instanceof Map) {
            for (const [key, value] of span.attributes) {
              if (!isSafeRelayAttribute(key, value)) span.attributes.delete(key);
            }
          }
          if (Array.isArray(span.links)) {
            for (let index = 0; index < span.links.length; index += 1) {
              const link = span.links[index];
              if (link !== undefined) span.links[index] = { ...link, attributes: {} };
            }
          }
          end(endTime, traceSafeExit(exit));
        } catch {}
      };
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
}

export function layer(
  config: RelayClientTracingConfig | null,
  resource: RelayClientTracingResource,
): Layer.Layer<never, never, HttpClient.HttpClient> {
  if (!isGoatConnectEnabled() || config === null) {
    return Layer.succeed(RelayClientTracer, Option.none());
  }

  const layerTracer = OtlpTracer.layer({
    url: config.tracesUrl,
    headers: {
      Authorization: `Bearer ${config.tracesToken}`,
      "X-Axiom-Dataset": config.tracesDataset,
    },
    resource: {
      serviceName: resource.serviceName,
      serviceVersion: resource.serviceVersion,
      attributes: {
        "service.namespace": "goat",
        "service.instance.id": resource.serviceInstanceId,
        "service.runtime": resource.runtime,
        "goat.component": resource.component ?? "relay-client",
        "goat.client.surface": resource.client,
        ...resource.attributes,
      },
    },
  }).pipe(Layer.provide(OtlpSerialization.layerJson));

  return Layer.effect(
    RelayClientTracer,
    Tracer.Tracer.pipe(Effect.map(nonInterferingTracer), Effect.asSome),
  ).pipe(Layer.provide(layerTracer));
}
