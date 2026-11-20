// @effect-diagnostics nodeBuiltinImport:off -- paths feed bounded no-follow reads.
import { EnvironmentThemeId } from "@goat/contracts";
import { fromSecret } from "../auth/PayloadSigner.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import { readThemeFileGuarded, MAX_THEME_FILE_BYTES } from "../environmentTheme.ts";
import { openAssetClaims, sealAssetClaims } from "./assetClaimsSeal.ts";
import {
  closeThemeBackground,
  openThemeBackground,
  readOpenedThemeBackground,
  THEME_BACKGROUND_EXTENSIONS,
} from "./themeBackgroundFile.ts";
import { publishedBackgroundBudget } from "./publishedBackgroundBudget.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

const THEME_BACKGROUND_SIGNING_SECRET = "theme-background-signing-key";
const THEME_BACKGROUND_TOKEN_TTL_MS = 10 * 60_000;
export const THEME_BACKGROUND_TOKEN_PREFIX = "tb1-";
const THEME_BACKGROUND_NAME = "background";
const MAX_ENVIRONMENT_ID_BYTES = 1024;
const MAX_TOKEN_LENGTH = 4096;
const Claims = Schema.Struct({
  environmentId: Schema.String.check(Schema.isMaxLength(MAX_ENVIRONMENT_ID_BYTES)),
  themeId: EnvironmentThemeId,
  revision: Schema.String.check(Schema.isPattern(/^(?:webp|png|jpg|jpeg):[a-f0-9]{64}$/)),
  expiresAt: Schema.Number,
});
const ClaimsJson = Schema.fromJsonString(Claims);
const encodeClaims = Schema.encodeSync(ClaimsJson);
const decodeClaims = Schema.decodeUnknownOption(ClaimsJson);

export class ThemeBackgroundAssetError extends Schema.TaggedError<ThemeBackgroundAssetError>()(
  "ThemeBackgroundAssetError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const issueThemeBackgroundUrl = Effect.fn("ThemeBackground.issueUrl")(function* (
  themeId: string,
  revision: string,
) {
  const config = yield* ServerConfig.ServerConfig;
  const environmentId = readThemeFileGuarded(
    config.environmentIdPath,
    MAX_ENVIRONMENT_ID_BYTES,
  )?.trim();
  const themes = yield* (yield* EnvironmentTheme.EnvironmentThemeService).current;
  if (
    !environmentId ||
    !themes.some((theme) => theme.id === themeId && theme.background === revision)
  )
    return null;
  const store = yield* SecretStore.ServerSecretStore;
  const secret = yield* store
    .getOrCreateRandom(THEME_BACKGROUND_SIGNING_SECRET, 32)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ThemeBackgroundAssetError({ message: "Cannot sign theme background.", cause }),
      ),
    );
  const expiresAt = (yield* Clock.currentTimeMillis) + THEME_BACKGROUND_TOKEN_TTL_MS;
  const encoded = yield* Effect.try({
    try: () => encodeClaims({ environmentId, themeId, revision, expiresAt }),
    catch: (cause) =>
      new ThemeBackgroundAssetError({ message: "Cannot encode theme background claim.", cause }),
  });
  const payload = sealAssetClaims(encoded, secret);
  const signature = fromSecret(secret).sign(payload);
  return {
    relativeUrl: `/api/assets/${THEME_BACKGROUND_TOKEN_PREFIX}${payload}.${signature}/${THEME_BACKGROUND_NAME}`,
    expiresAt,
  };
});

export const resolveThemeBackgroundAsset = Effect.fn("ThemeBackground.resolveAsset")(function* (
  token: string,
  name: string,
) {
  if (
    !token.startsWith(THEME_BACKGROUND_TOKEN_PREFIX) ||
    token.length > MAX_TOKEN_LENGTH ||
    name !== THEME_BACKGROUND_NAME
  )
    return null;
  const parts = token.slice(THEME_BACKGROUND_TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;
  const store = yield* SecretStore.ServerSecretStore;
  const secretResult = yield* store
    .getOrCreateRandom(THEME_BACKGROUND_SIGNING_SECRET, 32)
    .pipe(Effect.result);
  if (secretResult._tag === "Failure") {
    yield* Effect.logError("Cannot load theme background signing key.");
    return null;
  }
  const secret = secretResult.success;
  if (!fromSecret(secret).verify(payload, signature)) return null;
  const claims = Option.getOrNull(decodeClaims(openAssetClaims(payload, secret)));
  if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  const config = yield* ServerConfig.ServerConfig;
  const environmentId = readThemeFileGuarded(
    config.environmentIdPath,
    MAX_ENVIRONMENT_ID_BYTES,
  )?.trim();
  if (!environmentId || claims.environmentId !== environmentId) return null;
  const service = yield* Effect.serviceOption(EnvironmentTheme.EnvironmentThemeService);
  if (Option.isNone(service)) {
    yield* Effect.logError("Theme background service is unavailable.");
    return null;
  }
  const raw = readThemeFileGuarded(
    NodePath.join(config.environmentThemesDir, `${claims.themeId}.json`),
    MAX_THEME_FILE_BYTES,
  );
  if (raw === null) return null;
  const extension = THEME_BACKGROUND_EXTENSIONS.find((value) =>
    claims.revision.startsWith(`${value}:`),
  );
  if (!extension) return null;
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise(() =>
      openThemeBackground(config.environmentThemesDir, claims.themeId, extension),
    ).pipe(
      Effect.catch(() =>
        Effect.logWarning("could not open theme background file").pipe(Effect.as(null)),
      ),
    ),
    (file) =>
      Effect.gen(function* () {
        if (file === null) return null;
        const reservation = yield* publishedBackgroundBudget.reserve(file.info.size);
        if (reservation === null) return { kind: "busy" as const };
        const image = yield* Effect.uninterruptible(
          Effect.tryPromise(() => readOpenedThemeBackground(file, raw)).pipe(
            Effect.catch(() =>
              Effect.logWarning("could not read theme background file").pipe(Effect.as(null)),
            ),
          ),
        );
        if (image === null || image.revision !== claims.revision) return null;
        const themes = yield* service.value.current;
        if (
          !themes.some(
            (theme) => theme.id === claims.themeId && theme.background === claims.revision,
          )
        )
          return null;
        return {
          kind: "found" as const,
          bytes: image.bytes,
          mimeType: image.mimeType,
          expiresAt: claims.expiresAt,
        };
      }),
    (file) =>
      file === null
        ? Effect.void
        : Effect.tryPromise(() => closeThemeBackground(file)).pipe(
            Effect.catch(() => Effect.logWarning("could not close theme background file")),
          ),
  );
});
