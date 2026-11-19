// @effect-diagnostics-next-line nodeBuiltinImport:off -- hash launch identities without retaining credentials as cache keys.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HomeRoute from "./OpenCodexRoute.ts";
import * as CodexErrors from "effect-codex-app-server/errors";
import { providerProbeEnvironment } from "@goat/provider-core/server/snapshotProbe";
import { decodeCodexHomeCatalogArg } from "./CodexHomeRouteConfig.ts";
import { withCodexAppServerClient } from "./CodexProvider.ts";
import { parseCodexSkillsListResponse } from "./codexSkillsList.ts";
import { makeCodexSkillsPool } from "./CodexSkillsPool.ts";

type Input = Parameters<typeof withCodexAppServerClient>[0];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

export function codexSkillsIdentity(input: Input, routeArgs: ReadonlyArray<string>): string {
  const route = input.route && { ...input.route, execution: { ...input.route.execution, cwd: "" } };
  const launch = { ...input, cwd: "", route, routeArgs };
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(stable(launch)))
    .digest("hex");
}

export const makeCodexSkillsProbe = Effect.fn("CodexSkillsProbe.make")(function* () {
  const pending = new Map<string, { input: Input; users: number }>();
  const helpers = yield* makeCodexSkillsPool((key: string) =>
    Effect.suspend(() => {
      const launch = pending.get(key)?.input;
      return launch === undefined
        ? Effect.fail(
            new CodexErrors.CodexAppServerSpawnError({
              command: "codex app-server",
              cause: "Missing probe launch identity",
            }),
          )
        : withCodexAppServerClient(launch).pipe(Effect.map(({ client }) => client));
    }),
  );
  return Effect.fn("CodexSkillsProbe.probe")(function* (input: Input) {
    const routes = yield* Effect.serviceOption(HomeRoute.OpenCodexRoute);
    const routeArgs =
      input.route?.settings.modelRoute === "opencodex"
        ? Option.isSome(routes)
          ? yield* routes.value.launchArgs(input.route)
          : yield* new HomeRoute.OpenCodexRouteUnavailable({
              detail: "Could not read OpenCodex status",
            })
        : (input.routeArgs ?? []);
    const launch = {
      ...input,
      environment: providerProbeEnvironment(input.environment ?? process.env),
      ...(input.route !== undefined || input.routeArgs !== undefined ? { routeArgs } : {}),
    };
    const key = codexSkillsIdentity(launch, routeArgs);
    const entry = pending.get(key);
    if (entry === undefined && pending.size >= 8)
      return yield* new CodexErrors.CodexAppServerSpawnError({
        command: "codex app-server",
        cause: "Too many distinct skills probes",
      });
    if (entry) entry.users++;
    else pending.set(key, { input: launch, users: 1 });
    return yield* helpers(key, (client) =>
      Effect.gen(function* () {
        if (input.route?.settings.modelRoute === "opencodex") {
          if (Option.isNone(routes))
            return yield* new HomeRoute.OpenCodexRouteUnavailable({
              detail: "Could not read OpenCodex status",
            });
          yield* routes.value.requireAvailable(input.route);
          const pointer = routeArgs.find((arg) => arg.startsWith("model_catalog_json="));
          const expected =
            pointer === undefined
              ? undefined
              : decodeCodexHomeCatalogArg(pointer.slice("model_catalog_json=".length));
          if (typeof expected !== "string")
            return yield* new HomeRoute.OpenCodexRouteUnavailable({
              detail: "Could not verify the effective Codex endpoint.",
            });
          const response = yield* client.request("config/read", {
            cwd: input.cwd,
            includeLayers: false,
          });
          yield* HomeRoute.verifyEffectiveCodexRoute(input.route, response.config, expected).pipe(
            Effect.provide(NodePath.layer),
          );
        }
        const response = yield* client.request("skills/list", {
          cwds: [input.cwd],
          forceReload: true,
        });
        return parseCodexSkillsListResponse(response, input.cwd);
      }),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          const current = pending.get(key);
          if (current && --current.users === 0) pending.delete(key);
        }),
      ),
    );
  });
});
