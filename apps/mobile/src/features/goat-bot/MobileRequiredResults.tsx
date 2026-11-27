import { currentRequiredResults } from "@goat/client-runtime/goatBot";
import { Text, View } from "react-native";
import { useGT } from "../../i18n/I18nProvider";

export function MobileRequiredResults({
  work,
  task,
}: {
  work: Parameters<typeof currentRequiredResults>[0];
  task: Parameters<typeof currentRequiredResults>[1];
}) {
  const gt = useGT();
  const progress = currentRequiredResults(work, task);
  if (!progress) return null;
  const labels = {
    pending: gt("Not started"),
    running: gt("In progress"),
    awaiting_acceptance: gt("Awaiting acceptance"),
    accepted: gt("Accepted", { $context: "A required worker result that passed review" }),
    failed: gt("Failed"),
  };
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="font-medium text-foreground">
        {gt("Required results accepted")} {progress.accepted}/{progress.items.length}
      </Text>
      {progress.items.map((item) => (
        <View key={item.id}>
          <Text className="text-foreground">{item.criterion}</Text>
          <Text className="text-foreground-muted">
            {labels[item.state]}
            {item.attempt > 1 ? ` · ${gt("Attempt {attempt}", { attempt: item.attempt })}` : ""}
          </Text>
          {item.host && (
            <Text className="text-foreground-muted">
              {gt("Worker on {host}", { host: item.host })}
            </Text>
          )}
          {item.evidence && <Text className="text-foreground-muted">{item.evidence}</Text>}
        </View>
      ))}
    </View>
  );
}
