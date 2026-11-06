import {
  OnePasswordSecretProviderConfig,
  SecretProviderId,
  SecretProviderKind,
  SecretProviderLabel,
  type OnePasswordAccount,
  type SecretProviderConfig,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const decodeSecretProviderId = Schema.decodeOption(SecretProviderId);
const decodeOnePasswordConfig = Schema.decodeUnknownOption(OnePasswordSecretProviderConfig);

export type ClassifiedSecretProvider =
  | { readonly kind: "one_password"; readonly account: OnePasswordAccount }
  | { readonly kind: "unsupported" };

/** Unknown kinds and configs that no longer decode are shown read-only; removal stays available. */
export function classifySecretProvider(provider: SecretProviderConfig): ClassifiedSecretProvider {
  if (provider.kind !== "one_password") return { kind: "unsupported" };
  const decoded = decodeOnePasswordConfig(provider.config);
  return decoded._tag === "Some"
    ? { kind: "one_password", account: decoded.value.account }
    : { kind: "unsupported" };
}

function secretProviderIdFromName(name: string): SecretProviderId | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return Option.getOrNull(decodeSecretProviderId(slug));
}

export interface SecretProviderDraft {
  readonly name: string;
  readonly account: string;
  readonly id?: string;
}

export function draftFromSecretProvider(provider: SecretProviderConfig): SecretProviderDraft {
  const classified = classifySecretProvider(provider);
  return {
    name: provider.label,
    account: classified.kind === "one_password" ? classified.account : "",
  };
}

export type SecretProviderTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: SecretProviderId };

export type SecretProviderDraftIssues = {
  readonly [Field in keyof SecretProviderDraft]?: string;
};

function decodeField<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
  emptyMessage: string,
): Result.Result<S["Type"], string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Result.fail(emptyMessage);
  return Result.mapError(Schema.decodeResult(schema)(trimmed), (error) => error.message);
}

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function secretProviderFromDraft(
  draft: SecretProviderDraft,
  existingIds: ReadonlySet<string>,
  target: SecretProviderTarget,
): Result.Result<
  { readonly id: SecretProviderId; readonly config: SecretProviderConfig },
  SecretProviderDraftIssues
> {
  const label = decodeField(SecretProviderLabel, draft.name, "Enter a name.");
  const account = decodeField(
    OnePasswordSecretProviderConfig.fields.account,
    draft.account,
    "Enter the 1Password account.",
  );

  let id: SecretProviderId | null = null;
  let nameIssue: string | undefined;
  let idIssue: string | undefined;
  if (Result.isFailure(label)) {
    nameIssue = label.failure;
  } else {
    id =
      target.mode === "edit"
        ? target.id
        : draft.id?.trim()
          ? Option.getOrNull(decodeSecretProviderId(draft.id.trim()))
          : secretProviderIdFromName(label.success);
    if (id === null) {
      if (draft.id?.trim())
        idIssue = "Use letters, digits, underscores or hyphens, starting with a letter or digit.";
      else nameIssue = "The name needs at least one letter or digit.";
    } else if (target.mode === "add" && existingIds.has(id)) {
      if (draft.id?.trim()) idIssue = "A secret provider with this ID exists.";
      else nameIssue = "A secret provider with this ID exists.";
    }
  }

  if (
    id === null ||
    nameIssue !== undefined ||
    idIssue !== undefined ||
    Result.isFailure(label) ||
    Result.isFailure(account)
  ) {
    return Result.fail({
      ...(nameIssue === undefined ? {} : { name: nameIssue }),
      ...(idIssue === undefined ? {} : { id: idIssue }),
      ...(Result.isFailure(account) ? { account: account.failure } : {}),
    });
  }
  return Result.succeed({
    id,
    config: {
      kind: SecretProviderKind.make("one_password"),
      label: label.success,
      config: { account: account.success },
    },
  });
}
