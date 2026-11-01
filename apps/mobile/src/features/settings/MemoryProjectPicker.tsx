import { useState } from "react";
import { TextInput, View } from "react-native";
import type { EnvironmentId, ProjectId } from "@goat/contracts";
import { useProjects } from "../../state/entities";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsActionRow } from "./components/SettingsActionRow";

const PAGE_SIZE = 20;

/** Candidate rows are created only while open, with an explicit per-page bound. */
export function MemoryProjectPicker({
  environmentId,
  excludeProjectId,
  label,
  candidateLabel,
  disabled,
  onSelect,
}: {
  environmentId: EnvironmentId;
  excludeProjectId?: ProjectId;
  label: string;
  candidateLabel: string;
  disabled?: boolean;
  onSelect: (projectId: ProjectId) => void;
}) {
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  if (!open)
    return (
      <SettingsActionRow
        icon="brain"
        label={label}
        disabled={disabled}
        onPress={() => {
          setQuery("");
          setPage(0);
          setOpen(true);
        }}
      />
    );
  const matches = projects.filter(
    (project) =>
      project.environmentId === environmentId &&
      project.id !== excludeProjectId &&
      project.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
  return (
    <View>
      <Text className="p-3 text-sm text-foreground-muted">{label}</Text>
      <View className="p-3">
        <TextInput
          accessibilityLabel="Search projects"
          placeholder="Search projects"
          value={query}
          onChangeText={(value) => {
            setQuery(value);
            setPage(0);
          }}
          className="rounded-lg border border-border p-3 text-foreground"
        />
      </View>
      <Text className="p-3 text-sm text-foreground-muted">
        {matches.length
          ? `Page ${currentPage + 1} of ${Math.ceil(matches.length / PAGE_SIZE)}`
          : "No matching projects"}
      </Text>
      {matches.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((project) => (
        <SettingsActionRow
          key={project.id}
          icon="brain"
          label={`${candidateLabel}${project.title}`}
          disabled={disabled}
          onPress={() => {
            setOpen(false);
            onSelect(project.id);
          }}
        />
      ))}
      <SettingsActionRow
        icon="brain"
        label="Previous projects"
        disabled={currentPage === 0}
        onPress={() => setPage(currentPage - 1)}
      />
      <SettingsActionRow
        icon="brain"
        label="Next projects"
        disabled={(currentPage + 1) * PAGE_SIZE >= matches.length}
        onPress={() => setPage(currentPage + 1)}
      />
      <SettingsActionRow
        icon="brain"
        label="Close project chooser"
        onPress={() => setOpen(false)}
      />
    </View>
  );
}
