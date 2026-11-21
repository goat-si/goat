import { WS_METHODS } from "@goat/contracts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { connectionAtomRuntime } from "./connection/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { themeEnvironmentIdAtom } from "./state/desktopHostEnvironment";

const validate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:theme:validate-css",
  tag: WS_METHODS.themeValidateCss,
});

export async function validateThemeCssForSave(css: string): Promise<string> {
  const { sanitizeThemeCss } = await import("@goat/shared/themeCssSanitizer");
  sanitizeThemeCss(css);
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  if (environmentId === null) throw new Error("Connect to an environment to save custom CSS.");
  const result = await runAtomCommand(
    appAtomRegistry,
    validate,
    { environmentId, input: { css } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value.css;
}
