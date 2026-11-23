import type { ChatAttachment, ProviderDriverKind } from "@goat/contracts";
import { isProviderNativeImageAttachment } from "@goat/provider-core/server/attachmentPrompt";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/compat";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { findModelConfigOption } from "./runtimeModel.ts";
import { flattenSelectChoices } from "./sessionConfig.ts";

/** Builds a message's own blocks: its text and images, or the flavor's prompt for them. */
export function makeAcpPromptContent(deps: {
  readonly driver: ProviderDriverKind;
  readonly flavor: Pick<AcpAdapterV2Flavor, "buildPrompt">;
  readonly supportsImagePrompts: boolean;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
  readonly fileSystem: FileSystem.FileSystem;
  readonly activeSessionSetup: Ref.Ref<AcpSessionRuntime.AcpSessionRuntimeStartResult | null>;
  readonly configOptions: Effect.Effect<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>;
}) {
  return Effect.fnUntraced(function* (text: string, attachments: ReadonlyArray<ChatAttachment>) {
    const prompt: Array<EffectAcpSchema.ContentBlock> =
      text.length > 0 ? [{ type: "text", text }] : [];
    const imageAttachments = attachments.filter(isProviderNativeImageAttachment);
    if (imageAttachments.length > 0 && !deps.supportsImagePrompts) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: deps.driver,
        detail: "ACP driver did not negotiate image prompt support",
      });
    }
    if (deps.flavor.buildPrompt) {
      const setup = yield* Ref.get(deps.activeSessionSetup);
      const modelOption = findModelConfigOption(yield* deps.configOptions);
      const currentModelId = modelOption?.currentValue;
      const blocks = yield* deps.flavor
        .buildPrompt({
          text,
          attachments,
          resolveAttachmentPath: deps.resolveAttachmentPath,
          promptCapabilities: setup?.initializeResult.agentCapabilities?.promptCapabilities,
          agentVersion: setup?.initializeResult.agentInfo?.version,
          currentModel:
            typeof currentModelId !== "string" || modelOption === undefined
              ? undefined
              : {
                  id: currentModelId,
                  name: flattenSelectChoices(modelOption.options).find(
                    (choice) => choice.value === currentModelId,
                  )?.name,
                },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: deps.driver,
                detail: "Failed to build ACP attachment prompt",
                payload: cause,
              }),
          ),
        );
      return [...blocks];
    }
    for (const attachment of imageAttachments) {
      const path = deps.resolveAttachmentPath(attachment as ChatAttachment);
      if (path === null) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: deps.driver,
          detail: `Invalid attachment id '${attachment.id}'`,
        });
      }
      const bytes = yield* deps.fileSystem.readFile(path).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterProtocolError({
              driver: deps.driver,
              detail: `Failed to read attachment '${attachment.id}'`,
              reason: "attachment_unreadable",
              payload: cause,
            }),
        ),
      );
      prompt.push({
        type: "image",
        data: Buffer.from(bytes).toString("base64"),
        mimeType: attachment.mimeType,
      });
    }
    return prompt;
  });
}
