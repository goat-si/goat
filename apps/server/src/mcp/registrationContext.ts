import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { CurrentLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { McpSchema } from "effect/ai";
import { HttpRouter, HttpServerRequest } from "effect/http";

// The services Effect's McpServer treats as the call's own, plus its middleware entries.
const callKeys = new Set<string>([
  McpSchema.McpRequestContext.key,
  McpSchema.McpServerClient.key,
  HttpServerRequest.HttpServerRequest.key,
  HttpServerRequest.ParsedSearchParams.key,
  HttpRouter.RouteContext.key,
  CurrentLogLevel.key,
  Scope.Scope.key,
  Tracer.ParentSpan.key,
]);

/**
 * The services a tool registration was built with, minus what belongs to each call. Effect 4.0
 * ran every toolkit handler with these over the caller's; 4.1 lets the caller's win, so a call
 * could replace a service the server built. `withRegistrationContext` restores the server's.
 */
export const captureRegistrationContext = Effect.map(Effect.context<never>(), (context) => {
  const services = new Map<string, unknown>();
  for (const [key, value] of context.mapUnsafe) {
    if (!callKeys.has(key) && !key.startsWith("effect/ai/McpServer/Middleware-")) {
      services.set(key, value);
    }
  }
  return Context.makeUnsafe<never>(services);
});

/** Runs a handler with its registration's services over whatever the call carries. */
export const withRegistrationContext =
  <A, E, R>(
    registration: Context.Context<never>,
    handle: (payload: unknown) => Effect.Effect<A, E, R>,
  ) =>
  (payload: unknown) =>
    Effect.updateContext(handle(payload), (call: Context.Context<R>) =>
      Context.merge(call, registration),
    );
