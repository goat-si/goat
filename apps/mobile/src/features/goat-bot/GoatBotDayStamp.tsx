import { goatBotStampParts } from "@goat/client-runtime/goatBot";
import { Text } from "react-native";

export function GoatBotDayStamp(props: {
  readonly at: string;
  readonly nowMs: number;
  readonly formatTime: (iso: string) => string;
}) {
  const { lead, time } = goatBotStampParts(props.at, props.nowMs, props.formatTime);
  return (
    <Text className="py-4 text-center text-xs text-foreground-muted">
      <Text style={{ fontWeight: "600" }}>{lead}</Text>
      {lead ? " " : ""}
      <Text style={{ fontWeight: "400" }}>{time}</Text>
    </Text>
  );
}
