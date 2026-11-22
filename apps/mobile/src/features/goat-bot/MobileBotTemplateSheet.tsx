import { offerBotTemplateDraft } from "@goat/client-runtime/goatBot";
import type { BotProfile, ChannelBotResult, ChannelCreateBotInput } from "@goat/contracts";
import { GOAT_BOT_TEMPLATES } from "@goat/shared/goatBotNames";
import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { uuidv4 } from "../../lib/uuid";

type Template = (typeof GOAT_BOT_TEMPLATES)[number];

export function MobileBotTemplateSheet(props: {
  createBot: (input: ChannelCreateBotInput) => Promise<ChannelBotResult | string>;
  canCreate: () => boolean;
  close: () => void;
  openBot: (bot: BotProfile) => void;
}) {
  const [template, select] = useState<Template>();
  const [name, setName] = useState("");
  const [request, setRequest] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<BotProfile>();

  const open = (bot: BotProfile, text: string) => {
    if (!props.canCreate()) return;
    offerBotTemplateDraft(bot, text);
    props.close();
    props.openBot(bot);
  };

  const create = async () => {
    if (!template || busy || !name.trim() || !props.canCreate()) return;
    const clientRequestId = request ?? uuidv4();
    setRequest(clientRequestId);
    setBusy(true);
    setError(undefined);
    const result = await props.createBot({
      clientRequestId,
      templateId: template.id,
      name: name.trim(),
      avatar: template.face,
      purpose: template.purpose,
      defaultModelSelection: null,
    });
    setBusy(false);
    if (typeof result === "string") {
      setError(result);
      return;
    }
    if (result.templateAutomationPending) {
      setCreated(result.bot);
      setError("1 routine could not be added");
      return;
    }
    open(result.bot, template.firstMessage);
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!busy) props.close();
      }}
    >
      <ScrollView className="flex-1 bg-background" contentContainerClassName="gap-4 p-5 pt-12">
        <Text className="text-xl font-semibold text-foreground">From a template</Text>
        {template === undefined ? (
          GOAT_BOT_TEMPLATES.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              onPress={() => {
                select(item);
                setName(item.name);
              }}
            >
              <Text className="text-base font-medium text-foreground">
                {item.face} {item.name}
              </Text>
              <Text className="text-foreground-muted">{item.purpose}</Text>
            </Pressable>
          ))
        ) : (
          <View className="gap-3">
            <Text className="text-lg font-medium text-foreground">
              {template.face} {template.name}
            </Text>
            <Text className="font-medium text-foreground">Name</Text>
            <TextInput
              accessibilityLabel="Name"
              className="rounded-md border border-border p-2 text-foreground"
              value={name}
              onChangeText={setName}
              maxLength={64}
              editable={request === undefined}
            />
            <Text className="text-foreground">{template.purpose}</Text>
            <Text className="text-foreground">{template.instructions}</Text>
            <Text className="text-foreground">Paused · {template.automation.title}</Text>
            <Text className="text-foreground-muted">{template.automation.prompt}</Text>
            <Text className="font-medium text-foreground">First message draft</Text>
            <Text className="text-foreground">{template.firstMessage}</Text>
            {error && (
              <Text accessibilityRole="alert" className="text-foreground">
                {error}
              </Text>
            )}
            <Pressable
              accessibilityRole="button"
              disabled={busy || !name.trim()}
              onPress={() => void create()}
            >
              <Text className="text-primary">
                {busy ? "Creating…" : error ? "Retry" : "Create bot"}
              </Text>
            </Pressable>
            {created && (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => open(created, template.firstMessage)}
              >
                <Text className="text-primary">Open bot</Text>
              </Pressable>
            )}
            {request === undefined && (
              <Pressable accessibilityRole="button" onPress={() => select(undefined)}>
                <Text className="text-primary">Choose another template</Text>
              </Pressable>
            )}
          </View>
        )}
        <Pressable accessibilityRole="button" disabled={busy} onPress={props.close}>
          <Text className="text-primary">Cancel</Text>
        </Pressable>
      </ScrollView>
    </Modal>
  );
}
