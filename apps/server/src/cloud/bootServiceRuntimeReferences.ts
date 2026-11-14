import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { bootServiceUnitPaths } from "./bootServiceUnitPaths.ts";
import { bootServiceProgramOf } from "./systemdValues.ts";

export const bootServiceRuntimeReferences = Effect.fn("cloud.boot_service.runtime_references")(
  function* (input: { readonly noSystemd: "allow" | "skip" }) {
    const fs = yield* FileSystem.FileSystem;
    const unitPaths = yield* bootServiceUnitPaths();
    if (unitPaths === undefined) {
      yield* Effect.logWarning(
        "Could not determine the service unit directory; skipping runtime pruning",
      );
      return undefined;
    }
    if (unitPaths === "no-systemd") {
      if (input.noSystemd === "allow") return [];
      yield* Effect.logWarning("Systemd is not running here; skipping runtime pruning");
      return undefined;
    }
    const references: string[] = [];
    for (const unitPath of unitPaths) {
      const unit = yield* fs.readFileString(unitPath).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.result,
      );
      if (unit._tag === "Failure") {
        yield* Effect.logWarning("Could not inspect the service unit; skipping runtime pruning", {
          unitPath,
          cause: unit.failure,
        });
        return undefined;
      }
      const program = Option.flatMapNullishOr(unit.success, bootServiceProgramOf);
      if (Option.isSome(program)) {
        references.push(
          program.value,
          yield* fs.realPath(program.value).pipe(Effect.orElseSucceed(() => program.value)),
        );
      }
    }
    return references;
  },
);
