import { useAtomValue } from "@effect/atom-react";
import { connectionRoutes } from "@goat/client-runtime/connection";
import type { EnvironmentId, NoteThreadLink } from "@goat/contracts";
import { useNavigation } from "@react-navigation/native";
import * as Option from "effect/Option";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { useThreadShell } from "../../state/entities";
import { Button } from "../../components/ui/Button";
import { noteThreadPresentation } from "./notes-model";

export function NoteLinkedThread({
  environmentId,
  link,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: NoteThreadLink;
}) {
  const navigation = useNavigation();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const destination =
    link.host === null
      ? environmentId
      : [...catalog.entries].find(
          ([, entry]) =>
            entry.target.label === link.host ||
            connectionRoutes(entry).some((route) => {
              const profile = Option.getOrNull(route.profile);
              return profile?._tag === "SshConnectionProfile" && profile.target.alias === link.host;
            }),
        )?.[0];
  const shell = useThreadShell(
    destination ? { environmentId: destination, threadId: link.threadId } : null,
  );
  const presentation = noteThreadPresentation(link, shell?.title);
  return (
    <View className="gap-2 rounded-xl border border-border bg-card p-4">
      <Text className="font-goat-bold text-foreground">{presentation.label}</Text>
      <Text className="text-sm text-foreground-muted">{presentation.status}</Text>
      {link.lastResult?.summary ? (
        <Text className="text-foreground">{link.lastResult.summary}</Text>
      ) : null}
      {destination ? (
        <Button
          fullWidth
          label="Open thread"
          tone="secondary"
          onPress={() =>
            navigation.navigate("Thread", { environmentId: destination, threadId: link.threadId })
          }
        />
      ) : null}
    </View>
  );
}
