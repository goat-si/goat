// Lifted from GOAT v1 scripts/sign-macos-ad-hoc.ts (adapted): v1 hands this to electron-builder;
// GOAT 2 has no electron-builder, so it runs the same @electron/osx-sign call directly on the
// assembled app, with v1's entitlements (renderMacEntitlements() without passkeys) and the
// hardened runtime electron-builder turns on by default.
// Usage: node apps/desktop/scripts/sign-macos-ad-hoc.ts "<path to .app>"
import { fileURLToPath } from "node:url";
import { sign as signApplication } from "@electron/osx-sign";

const app = process.argv[2];
if (app === undefined) {
  console.error("usage: sign-macos-ad-hoc.ts <app>");
  process.exit(2);
}
const entitlements = fileURLToPath(new URL("../resources/entitlements.mac.plist", import.meta.url));

// An unsigned build must be ad-hoc whatever identity a keychain would match.
await signApplication({
  app,
  identity: "-",
  identityValidation: false,
  batchCodesignCalls: true,
  optionsForFile: () => ({ entitlements, hardenedRuntime: true }),
});
