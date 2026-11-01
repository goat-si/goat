import type { OrchestrationV2InternalCommand, OrchestrationV2TurnItem } from "@goat/contracts";

type SecretRequestRecord = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "secret_request.record" }
>;

/** A card's origin is fixed when it is first recorded, so a later record cannot redirect it. */
export const secretRequestOptionalFields = (
  command: SecretRequestRecord,
  existing: Extract<OrchestrationV2TurnItem, { readonly type: "secret_request" }> | undefined,
) => {
  const siteOrigin = existing === undefined ? command.siteOrigin : existing.siteOrigin;
  return {
    ...(command.placeholder === undefined ? {} : { placeholder: command.placeholder }),
    ...(command.delivery === undefined ? {} : { delivery: command.delivery }),
    ...(siteOrigin === undefined ? {} : { siteOrigin }),
  };
};
