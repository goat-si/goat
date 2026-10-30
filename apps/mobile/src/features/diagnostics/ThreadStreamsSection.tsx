import {
  formatThreadStreamReport,
  readThreadStreamDiagnostics,
  subscribeThreadStreamDiagnostics,
  threadStreamDiagnosticsVersion,
} from "@goat/client-runtime/state/thread-stream-diagnostics";
import { useSyncExternalStore } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";

/** Re-renders only while this screen is mounted and a stream records something. */
export function useThreadStreamDiagnostics() {
  useSyncExternalStore(subscribeThreadStreamDiagnostics, threadStreamDiagnosticsVersion);
  return readThreadStreamDiagnostics();
}

export function ThreadStreamsSection(props: {
  readonly diagnostics: ReturnType<typeof readThreadStreamDiagnostics>;
}) {
  return (
    <SettingsSection title="Thread streams">
      {props.diagnostics.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          Open a thread to see how its live updates arrive.
        </Text>
      ) : (
        props.diagnostics.map((diagnostic, index) => (
          <View
            key={`${diagnostic.environmentId}:${diagnostic.threadId}`}
            className={index === 0 ? "p-4" : "border-t border-border-subtle p-4"}
          >
            <Text selectable className="font-mono text-xs leading-snug text-foreground">
              {formatThreadStreamReport([diagnostic])}
            </Text>
          </View>
        ))
      )}
    </SettingsSection>
  );
}
