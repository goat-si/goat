import { expect, it } from "@effect/vitest";
import { screenRuntimeLayout, screenWasmPath } from "./ScreenRuntimeAsset.ts";
import { screenChildInvocation } from "./ScreenRunSupervisor.ts";

it("resolves development, packaged desktop, and standalone archive layouts from self invocation", () => {
  expect(
    screenRuntimeLayout({ command: "/Electron", entrypoint: "/repo/apps/server/dist/bin.mjs" }),
  ).toBe("dev");
  expect(
    screenRuntimeLayout({
      command: "/Electron",
      entrypoint: "/app/resources/app.asar/apps/server/dist/bin.mjs",
    }),
  ).toBe("desktop");
  expect(
    screenRuntimeLayout({
      command: "C:\\Electron.exe",
      entrypoint: "C:\\app\\resources\\server.asar\\apps\\server\\dist\\bin.mjs",
    }),
  ).toBe("desktop");
  expect(screenRuntimeLayout({ command: "/archive/goat", entrypoint: undefined })).toBe("cli");
  expect(screenWasmPath("desktop", { resourcesPath: "/app/resources" })).toBe(
    "/app/resources/screen-code/quickjs.wasm",
  );
  expect(screenWasmPath("cli", { executable: "/archive/goat" })).toBe(
    "/archive/screen-code/quickjs.wasm",
  );
});

it("uses the packaged executable directly and prepends only an unpackaged entrypoint", () => {
  expect(screenChildInvocation({ command: "/archive/goat", entrypoint: undefined })).toEqual({
    command: "/archive/goat",
    args: ["__screen-run-child"],
  });
  expect(
    screenChildInvocation({ command: "/Electron", entrypoint: "/app/server/bin.mjs" }),
  ).toEqual({ command: "/Electron", args: ["/app/server/bin.mjs", "__screen-run-child"] });
});
