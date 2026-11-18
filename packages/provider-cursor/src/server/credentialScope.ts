import { sameCursorBackend } from "./sdkBackend.ts";

/**
 * Removes the credentials an instance may not send from one merged environment. One it inherits
 * from the server goes only to the backend and usage endpoint the server names; an instance that
 * names its own backend or usage endpoint uses only credentials it sets itself, or its own GOAT
 * sign-in. `server` must be the host copy the environment was merged from.
 */
export const instanceCredentials = (input: {
  readonly instanceVariables: ReadonlySet<string>;
  readonly settingsEndpoint: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly server: NodeJS.ProcessEnv;
}) => {
  const { server } = input;
  const own = (name: string) => input.instanceVariables.has(name);
  const ownBackend =
    own("CURSOR_BACKEND_URL") &&
    !sameCursorBackend(input.environment.CURSOR_BACKEND_URL, server.CURSOR_BACKEND_URL);
  const endpoint =
    input.settingsEndpoint?.trim() ||
    (own("CURSOR_API_ENDPOINT") ? input.environment.CURSOR_API_ENDPOINT : undefined);
  const ownEndpoint =
    endpoint !== undefined && !sameCursorBackend(endpoint, server.CURSOR_API_ENDPOINT);
  // A token or login is the server's, for its backend and usage endpoint alike.
  const ownDestination = ownBackend || ownEndpoint;
  const environment = { ...input.environment };
  if (ownBackend && !own("CURSOR_API_KEY")) delete environment.CURSOR_API_KEY;
  if (ownDestination && !own("CURSOR_AUTH_TOKEN")) delete environment.CURSOR_AUTH_TOKEN;
  return {
    environment,
    /** Whether usage may exchange the environment's CURSOR_API_KEY. */
    usageTakesEnvironmentKey: !ownDestination || own("CURSOR_API_KEY"),
    /** Whether the server's CLI or Keychain login may be read for usage. */
    serverLogins: !ownDestination,
  };
};
