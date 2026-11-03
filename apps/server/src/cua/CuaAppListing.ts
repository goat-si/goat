import type { ComputerUseApp } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";

export interface CuaAppListing {
  readonly apps: ReadonlyArray<string>;
  readonly catalog: ReadonlyArray<ComputerUseApp>;
}

export const catalogName = (id: string): string => {
  const base = id.split(/[\\/]/).pop() ?? id;
  return (base.replace(/\.(exe|app)$/i, "") || id).slice(0, 255);
};

export const standaloneCatalog = (listing: Option.Option<CuaAppListing>) =>
  Option.getOrElse(
    Option.map(listing, (value) =>
      value.catalog.map((app) =>
        app.name === app.id ? { ...app, name: catalogName(app.id) } : app,
      ),
    ),
    () => [],
  );

export const availableCatalog = Effect.fn("CuaDriver.availableCatalog")(function* (
  enabled: Effect.Effect<boolean>,
  listing: Effect.Effect<Option.Option<CuaAppListing>>,
  catalog?: Effect.Effect<Option.Option<ReadonlyArray<ComputerUseApp>>>,
) {
  if (!(yield* enabled)) return Option.none();
  const result = yield* (
    catalog ??
      listing.pipe(
        Effect.map((value) => Option.map(value, (entry) => standaloneCatalog(Option.some(entry)))),
      )
  );
  return (yield* enabled) ? result : Option.none();
});
