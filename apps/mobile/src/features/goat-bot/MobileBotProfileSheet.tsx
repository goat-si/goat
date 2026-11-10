import { botProfileChanges, type BotProfileValues } from "@goat/client-runtime/state/channels";
import { useRef, useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  type TextInputInstance,
  View,
} from "react-native";

const INPUT = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

/** Name, avatar and purpose of a GOAT Bot; `onSubmit` resolves to an error to show, or null. */
export function MobileBotProfileSheet(props: {
  readonly mode: "edit" | "create";
  readonly initial: BotProfileValues;
  readonly canSubmit: boolean;
  readonly onSubmit: (changes: Partial<BotProfileValues>) => Promise<string | null>;
  readonly onClose: () => void;
  /** More fields after the profile, such as a new bot's model. */
  readonly children?: ReactNode;
  /** One of those fields changed, so a save goes through with no profile change. */
  readonly extraChanged?: boolean;
}) {
  const [name, setName] = useState(props.initial.name);
  const [avatar, setAvatar] = useState(props.initial.avatar ?? "");
  const [purpose, setPurpose] = useState(props.initial.purpose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blankName = name.trim() === "";
  // A missing name is pointed out once the person leaves the field or saves, not while they start.
  const [nameChecked, setNameChecked] = useState(false);
  const nameMissing = blankName && nameChecked;
  const nameRef = useRef<TextInputInstance>(null);
  const saveDisabled = busy || !props.canSubmit;

  const save = async () => {
    if (saveDisabled) return;
    if (blankName) {
      setNameChecked(true);
      nameRef.current?.focus();
      return;
    }
    const changes = botProfileChanges(props.mode, props.initial, { name, avatar, purpose });
    if (Object.keys(changes).length === 0 && props.extraChanged !== true) return props.onClose();
    setBusy(true);
    setError(null);
    const failure = await props.onSubmit(changes);
    setBusy(false);
    if (failure === null) props.onClose();
    else setError(failure);
  };

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!busy) props.onClose();
      }}
    >
      <View className="flex-1 bg-screen px-4 pt-4">
        <View className="flex-row items-center justify-between">
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={props.onClose}
            className="min-h-[44px] justify-center px-2"
          >
            <Text className="text-foreground">Cancel</Text>
          </Pressable>
          <Text accessibilityRole="header" className="text-base font-semibold text-foreground">
            {props.mode === "create" ? "New bot" : "Edit bot"}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save"
            accessibilityState={{ disabled: saveDisabled }}
            disabled={saveDisabled}
            onPress={() => void save()}
            className="min-h-[44px] justify-center px-2"
          >
            <Text className={saveDisabled ? "text-foreground-muted" : "text-foreground"}>
              {busy ? "Saving…" : "Save"}
            </Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-3 py-4">
          <Text className="text-foreground-muted">
            {props.mode === "create"
              ? "The bot gets its own conversation."
              : "Changes reach the bot when it starts its next conversation session."}
          </Text>
          <Text className="text-foreground">Name</Text>
          <TextInput
            ref={nameRef}
            accessibilityLabel="Name"
            accessibilityHint={nameMissing ? "The bot needs a name." : undefined}
            value={name}
            maxLength={64}
            editable={!busy}
            onChangeText={setName}
            onBlur={() => setNameChecked(true)}
            className={INPUT}
          />
          {nameMissing ? (
            <Text accessibilityLiveRegion="polite" className="text-foreground-muted">
              The bot needs a name.
            </Text>
          ) : null}
          <Text className="text-foreground">Avatar</Text>
          <TextInput
            accessibilityLabel="Avatar"
            value={avatar}
            maxLength={16}
            editable={!busy}
            placeholder="An emoji, or empty for the default face"
            onChangeText={setAvatar}
            className={INPUT}
          />
          <Text className="text-foreground">Purpose</Text>
          <TextInput
            accessibilityLabel="Purpose"
            value={purpose}
            maxLength={4000}
            editable={!busy}
            multiline
            placeholder="What should this bot help with?"
            onChangeText={setPurpose}
            className={INPUT + " min-h-[120px]"}
          />
          {props.children}
          {error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
