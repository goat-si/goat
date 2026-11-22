import type { BotPackageExportResult, BotProfile } from "@goat/contracts";
import { botPackageFileName } from "@goat/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";

import { shareGeneratedAttachment } from "../../lib/attachmentDownload";

export function MobileBotPackageSheet({
  bot,
  result,
  close,
  canShare,
}: {
  readonly bot: BotProfile;
  readonly result: BotPackageExportResult | string | null;
  readonly close: () => void;
  readonly canShare: () => boolean;
}) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string>();
  const save = (contents: string) => {
    if (sharing || !canShare()) return;
    setSharing(true);
    setError(undefined);
    void Promise.resolve()
      .then(() =>
        shareGeneratedAttachment({
          bytes: new TextEncoder().encode(contents),
          attachment: { name: botPackageFileName(bot.name), mimeType: "application/json" },
          signal: new AbortController().signal,
        }),
      )
      .then((shared) => {
        if (!shared) setError("File sharing is unavailable on this device.");
      })
      .catch(() => setError("Could not share the package. Try again."))
      .finally(() => setSharing(false));
  };

  return (
    <Modal presentationStyle="pageSheet" onRequestClose={close}>
      <View className="flex-1 gap-3 bg-background px-5 pb-5 pt-12">
        <Text accessibilityRole="header" className="font-goat-semibold text-xl text-foreground">
          Share {bot.name}
        </Text>
        <ScrollView className="flex-1" contentContainerClassName="gap-3">
          {result === null ? (
            <Text className="text-muted-foreground">Preparing package…</Text>
          ) : typeof result === "string" ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {result}
            </Text>
          ) : result.status === "blocked" ? (
            <>
              <Text accessibilityRole="alert" className="text-danger-foreground">
                Export blocked. Edit these fields to remove possible secrets, then try again.
              </Text>
              {result.fields.map((field) => (
                <Text key={field} className="text-foreground">
                  {field}
                </Text>
              ))}
            </>
          ) : (
            <>
              <Text className="text-muted-foreground">
                Review the setup before sharing the package.
              </Text>
              <Text selectable className="font-mono text-foreground">
                {result.contents}
              </Text>
            </>
          )}
          {error !== undefined && (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </Text>
          )}
        </ScrollView>
        <View className="flex-row justify-end gap-4">
          <Pressable
            accessibilityRole="button"
            onPress={close}
            disabled={sharing}
            className="min-h-[44px] justify-center px-3"
          >
            <Text className="text-foreground">Close</Text>
          </Pressable>
          {typeof result === "object" && result?.status === "ready" && (
            <Pressable
              accessibilityRole="button"
              onPress={() => save(result.contents)}
              disabled={sharing}
              className="min-h-[44px] justify-center px-3"
            >
              <Text className="font-goat-semibold text-primary-text">Share package</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}
