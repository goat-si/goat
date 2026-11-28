// The typed boundary between GOAT 2 code and the lifted v1 tree (@v1/surfaces). GOAT 2's tsconfig resolves @v1/surfaces
// to this file, so its typecheck never walks v1 internals (v1 needs its own compiler options); vite resolves it to
// surfaces.ts, and tsconfig.v1.json checks that surfaces.ts implements exactly these declarations. Declarations only,
// valid under both compiler setups.
import type { ComponentType, HTMLAttributes } from "react";

/** The [data-v1] boundary a lifted v1 surface renders inside (v1 CSS is scoped to it). */
export declare const V1Boundary: ComponentType<HTMLAttributes<HTMLDivElement>>;
/** ?v1fixture: CSS scoping and portal-root check (e2e/v1fixture.spec.ts). */
export declare const V1Fixture: ComponentType;
