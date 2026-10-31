import type { ComputerUseApp } from "@goat/contracts";
import * as Option from "effect/Option";

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
