import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ProviderInstanceId } from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { DevinCloudCli } from "@goat/provider-devin-cloud/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Config from "../config.ts";
import * as HomeRoute from "../provider/OpenCodexRoute.ts";
import { diagnoseProviders } from "../provider/ProviderDiagnosis.ts";
import { formatDiagnosis, readOnlyHost } from "./provider.ts";
it.effect(
  "reports a fresh Home check with checkedBy cli and prints the same human fix as server diagnosis",
  () =>
    Effect.gen(function* () {
      const id = ProviderInstanceId.make("codex-home-cli");
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [id]: { driver: ProviderDriverKind.make("codex"), config: { modelRoute: "opencodex" } },
        },
      };
      const paths = yield* Config.deriveServerPaths("/read-only-cli", undefined);
      const host = readOnlyHost(paths, "/read-only-cli", process.cwd(), settings);
      let inspected = 0;
      const route = HomeRoute.OpenCodexRoute.of({
        inspect: () =>
          Effect.sync(() => {
            inspected++;
            return {
              modelRoute: "opencodex",
              state: "failed",
              reason: "OpenCodex isn't running on this machine.",
            };
          }),
        launchArgs: () => Effect.die("No app-server after failed route inspection"),
        requireAvailable: () => Effect.die("unused"),
      });
      const diagnosis = (checkedBy: "cli" | "server") =>
        diagnoseProviders({ input: { instanceId: id }, snapshots: [], checkedBy }).pipe(
          Effect.provideService(ProviderHost.ProviderHost, host),
          Effect.provideService(HomeRoute.OpenCodexRoute, route),
          Effect.provide(Layer.mock(DevinCloudCli.DevinCloudCli)({})),
        );
      const cli = yield* diagnosis("cli");
      const server = yield* diagnosis("server");
      assert.equal(inspected, 2);
      assert.equal(cli.checkedBy, "cli");
      const check = cli.diagnoses[0]?.checks.find((check) => check.id === "opencodex_route");
      assert.equal(check?.status, "fail");
      assert.deepStrictEqual(
        check?.fix,
        server.diagnoses[0]?.checks.find((check) => check.id === "opencodex_route")?.fix,
      );
      assert.include(formatDiagnosis(cli), check!.fix!.instruction);
    }).pipe(Effect.provide(NodeServices.layer)),
);
