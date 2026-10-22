import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";

import { useAtomValue } from "@effect/atom-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon } from "~/components/solar";
import { useState } from "react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  DEFAULT_OPENCODEX_BASE_URL,
  type CodexModelRoute,
  type AcpRegistrySearchAgent,
  AuthProvidersManageScope,
  ProviderInstanceId,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@goat/contracts";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";

import { cn } from "../../lib/utils";
import { normalizeProviderAccentColor } from "../../providerInstances";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { ChatGptConnectionButton } from "./ChatGptConnectionButton";
import { Dialog } from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { providerClients } from "./providerDriverMeta";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { ProviderSettingsForm, deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { WizardPanel, WizardPopup, WizardHeader, WizardFooter } from "../ui/wizard";
import {
  ADD_PROVIDER_WIZARD_STEPS,
  ACP_REGISTRY_WIZARD_STEPS,
  deriveAvailableInstanceId,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  setupStepIndex,
  summarizeDriverSetupState,
  updateProviderIdentityDraft,
  type DriverSetupBadge,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "./AddProviderInstanceDialog.logic";
import { AddProviderInstanceWizardSteps } from "./AddProviderInstanceWizardSteps";
import { AcpRegistrySearchStep } from "./AcpRegistrySearchStep";
import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";
import { resolveOfficialAcpRegistryIconUrl } from "./AcpRegistryIcon";
import { AddManagedCodexAccountDialog } from "./CodexSetupSection";
import { ProviderEnvironmentSection } from "./ProviderInstanceCard";

/**
 * Output is trimmed to 48 chars so the final composed id stays under the 64-char slug cap
 * enforced by `ProviderInstanceId` in `@goat/contracts`.
 */
function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function deriveInstanceId(driver: ProviderDriverKind, label: string): string {
  const slug = slugifyLabel(label);
  return slug ? `${driver}_${slug}` : "";
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
const ACP_REGISTRY_DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const DEFAULT_DRIVER_OPTION = providerClients.definitions[0]!;
const EMPTY_CONFIG_DRAFT: Record<string, unknown> = {};
/**
 * Validate an instance id against the same slug rules the server applies in
 * `ProviderInstanceId` (see `packages/contracts/src/providerInstance.ts`).
 */
function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

const DRIVER_SETUP_BADGES: Record<
  DriverSetupBadge,
  { readonly label: string; readonly variant: "success" | "outline" | "warning" }
> = {
  signedIn: { label: "Signed in", variant: "success" },
  installed: { label: "Installed", variant: "outline" },
  missing: { label: "Not installed", variant: "warning" },
};

export interface AddProviderInstanceResult {
  readonly instanceId: ProviderInstanceId;
  readonly signedIn: boolean;
}

interface AddProviderInstanceDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly initialCodexRoute?: CodexModelRoute | undefined;
  /** Preselects a driver on the provider list. */
  readonly initialDriver?: ProviderDriverKind | undefined;
  /** Opens straight to the setup step of an instance that already exists. */
  readonly initialInstanceId?: ProviderInstanceId | undefined;
  readonly onCreated?: (instanceId: ProviderInstanceId) => void;
  /** Called when the dialog closes after an instance was created or opened for setup. */
  readonly onFinished?: (result: AddProviderInstanceResult) => void;
}

export function AddProviderInstanceDialog({
  open,
  environmentId,
  environmentLabel,
  onOpenChange,
  onCreated,
  onFinished,
  initialCodexRoute,
  initialDriver,
  initialInstanceId,
}: AddProviderInstanceDialogProps) {
  const settings = useEnvironmentSettings(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const initialInstanceDriver = initialInstanceId
    ? (settings.providerInstances?.[initialInstanceId]?.driver ??
      providers.find((provider) => provider.instanceId === initialInstanceId)?.driver)
    : undefined;
  const startDriver = initialInstanceDriver ?? initialDriver ?? DEFAULT_DRIVER_KIND;
  const startStep = initialInstanceId
    ? setupStepIndex(
        startDriver === ACP_REGISTRY_DRIVER_KIND
          ? ACP_REGISTRY_WIZARD_STEPS
          : ADD_PROVIDER_WIZARD_STEPS,
      )
    : 0;

  const homePreset = initialCodexRoute === "opencodex";
  const [wizardStep, setWizardStep] = useState(homePreset ? 1 : startStep);
  const [addingChatGptAccount, setAddingChatGptAccount] = useState(false);
  const [driver, setDriver] = useState<ProviderDriverKind>(startDriver);
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    homePreset
      ? {
          codex: {
            label: "Codex · OpenCodex Home",
            accentColor: "",
            instanceIdOverride: "codex_home",
          },
        }
      : {},
  );
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [localEnvironment, setLocalEnvironment] = useState<
    ReadonlyArray<ProviderInstanceEnvironmentVariable>
  >([]);
  const [isManualAcpConfiguration, setIsManualAcpConfiguration] = useState(false);
  const [isRegistryLoading, setIsRegistryLoading] = useState(false);
  const [isPreparingRegistryAgent, setIsPreparingRegistryAgent] = useState(false);
  // Driver-specific config drafts keyed by driver so toggling between drivers
  // during the same dialog session does not lose in-progress input.
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>(
    homePreset
      ? {
          codex: {
            setupMode: "existing",
            modelRoute: "opencodex",
            opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
          },
        }
      : {},
  );
  // Errors are suppressed until the user has tried to submit once. After that
  // they update live so fixing the problem clears the message in place.
  const [hasAttemptedSubmit, setHasAttemptedSubmit] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [createdInstanceId, setCreatedInstanceId] = useState<ProviderInstanceId | null>(
    initialInstanceId ?? null,
  );
  const createdProvider = createdInstanceId
    ? providers.find((provider) => provider.instanceId === createdInstanceId)
    : undefined;

  const handleOpenChange = (nextOpen: boolean, signedIn?: boolean) => {
    if (!nextOpen) {
      if (createdInstanceId) {
        onFinished?.({
          instanceId: createdInstanceId,
          signedIn: signedIn ?? createdProvider?.auth.status === "authenticated",
        });
      }
      setWizardStep(homePreset ? 1 : startStep);
      setAddingChatGptAccount(false);
      setDriver(startDriver);
      setIdentityByDriver(
        homePreset
          ? {
              codex: {
                label: "Codex · OpenCodex Home",
                accentColor: "",
                instanceIdOverride: "codex_home",
              },
            }
          : {},
      );
      setConfigByDriver(
        homePreset
          ? {
              codex: {
                setupMode: "existing",
                modelRoute: "opencodex",
                opencodexBaseUrl: DEFAULT_OPENCODEX_BASE_URL,
              },
            }
          : {},
      );
      setSelectedAcp(null);
      setLocalEnvironment([]);
      setIsManualAcpConfiguration(false);
      setIsRegistryLoading(false);
      setIsPreparingRegistryAgent(false);
      setHasAttemptedSubmit(false);
      setIsSaving(false);
      setCreatedInstanceId(initialInstanceId ?? null);
    }
    onOpenChange(nextOpen);
  };

  // Codex and Claude run at their default slots before they are configured, so
  // those ids stay reserved; other unconfigured default slots are free to take.
  const existingIds = new Set([
    "codex",
    "claudeAgent",
    ...Object.keys(settings.providerInstances ?? {}),
  ]);

  const driverOption = providerClients.get(driver) ?? DEFAULT_DRIVER_OPTION;
  const isAcpRegistry = driver === ACP_REGISTRY_DRIVER_KIND;
  const defaultIdentity: ProviderIdentityDraft = {
    label: driverOption.label,
    accentColor: "",
    instanceIdOverride: null,
  };
  const { label, accentColor, instanceIdOverride } = identityByDriver[driver] ?? defaultIdentity;
  const instanceId =
    instanceIdOverride ??
    deriveAvailableInstanceId(
      (candidateLabel) => {
        if (!candidateLabel.trim() || candidateLabel === driverOption.label) {
          return isAcpRegistry ? `${driver}_custom` : driver;
        }
        return deriveInstanceId(driver, candidateLabel);
      },
      label,
      existingIds,
    );
  const driverSettingsFields = deriveProviderSettingsFields(driverOption);
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const showInstanceIdError = hasAttemptedSubmit && instanceIdError !== null;
  const identityStep = 1;
  const previewLabel = label.trim() || `${driverOption.label} Workspace`;

  const configDraft = configByDriver[driver] ?? EMPTY_CONFIG_DRAFT;
  const isLocalAcp = isAcpRegistry && isManualAcpConfiguration && configDraft.source === "local";
  const wizardSteps = isAcpRegistry ? ACP_REGISTRY_WIZARD_STEPS : ADD_PROVIDER_WIZARD_STEPS;
  const setupStep = setupStepIndex(wizardSteps);
  const localCommandPath =
    typeof configDraft.commandPath === "string" ? configDraft.commandPath.trim() : "";
  const manualAgentId = typeof configDraft.agentId === "string" ? configDraft.agentId.trim() : "";
  const acpSelectionError = isLocalAcp
    ? localCommandPath.length > 0
      ? null
      : "Executable is required."
    : selectedAcp !== null || (isManualAcpConfiguration && manualAgentId.length > 0)
      ? null
      : "Select an ACP or configure one manually.";
  const wizardStepSummaries = isAcpRegistry
    ? ([
        isLocalAcp ? "Local ACP command" : (selectedAcp?.name ?? (manualAgentId || null)),
        previewLabel,
        null,
      ] as const)
    : ([driverOption.label, previewLabel, null, null] as const);
  const setConfigDraft = (config: Record<string, unknown> | undefined) => {
    setConfigByDriver((existing) => {
      const next = { ...existing };
      if (config === undefined || Object.keys(config).length === 0) {
        delete next[driver];
      } else {
        next[driver] = config;
      }
      return next;
    });
  };
  const setIdentityDraft = (update: Partial<ProviderIdentityDraft>) => {
    setIdentityByDriver((existing) => ({
      ...existing,
      [driver]: { ...(existing[driver] ?? defaultIdentity), ...update },
    }));
  };

  const applyWizardNavigation = (navigation: WizardNavigation) => {
    if (isSaving || isPreparingRegistryAgent || createdInstanceId) return;
    if (navigation.kind === "blocked") {
      setHasAttemptedSubmit(true);
    }
    // Entering the setup step is what creates the instance.
    if (navigation.kind === "navigate" && navigation.step === setupStep) {
      void handleSave();
      return;
    }
    setWizardStep(navigation.step);
  };

  const navigateToStep = (requestedStep: number) => {
    applyWizardNavigation(
      isAcpRegistry
        ? resolveAcpRegistryWizardNavigation(wizardStep, requestedStep, {
            instanceIdError,
            selectionError: acpSelectionError,
          })
        : resolveWizardNavigation(wizardStep, requestedStep, ADD_PROVIDER_WIZARD_STEPS.length, {
            instanceIdError,
          }),
    );
  };

  const handleAcpPrepared = (agent: AcpRegistrySearchAgent) => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    const nextLabel = agent.name;
    const registryIconUrl = resolveOfficialAcpRegistryIconUrl(agent.icon);
    const nextInstanceId = deriveAvailableInstanceId(
      (candidateLabel) => deriveInstanceId(ACP_REGISTRY_DRIVER_KIND, candidateLabel),
      nextLabel,
      existingIds,
    );
    setSelectedAcp(agent);
    setIsManualAcpConfiguration(false);
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: nextLabel,
        instanceIdOverride: nextInstanceId,
      }),
    );
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: {
        agentId: agent.id,
        distribution: "auto",
        ...(registryIconUrl ? { registryIconUrl } : {}),
      },
    }));
    setHasAttemptedSubmit(false);
    setWizardStep(1);
  };

  const handleManualAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => {
      const next = { ...existing };
      delete next[ACP_REGISTRY_DRIVER_KIND];
      return next;
    });
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: "",
        instanceIdOverride: null,
      }),
    );
    setHasAttemptedSubmit(false);
  };

  const handleLocalAcpConfiguration = () => {
    setDriver(ACP_REGISTRY_DRIVER_KIND);
    setSelectedAcp(null);
    setIsManualAcpConfiguration(true);
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER_KIND]: { source: "local", commandArgs: [] },
    }));
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER_KIND, {
        label: "Local ACP",
        instanceIdOverride: null,
      }),
    );
    setLocalEnvironment([]);
    setHasAttemptedSubmit(false);
  };

  const handleSave = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
    if (isSaving || createdInstanceId) return;
    setHasAttemptedSubmit(true);
    if (instanceIdError !== null || (isAcpRegistry && acpSelectionError !== null)) return;

    const config =
      driver === "codex"
        ? { ...configByDriver[driver], setupMode: "existing" }
        : (configByDriver[driver] ?? {});
    const hasConfig = Object.keys(config).length > 0;
    const normalizedAccentColor = normalizeProviderAccentColor(accentColor);

    const nextInstance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(label.trim().length > 0 ? { displayName: label.trim() } : {}),
      ...(normalizedAccentColor ? { accentColor: normalizedAccentColor } : {}),
      ...(hasConfig ? { config } : {}),
      ...(isLocalAcp && localEnvironment.length > 0 ? { environment: localEnvironment } : {}),
    };
    const brandedId = ProviderInstanceId.make(instanceId);
    setIsSaving(true);
    const result = await persistProviderInstance({
      operation: "create",
      instanceId: brandedId,
      instance: nextInstance,
    });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setIsSaving(false);
      toastManager.add({
        type: "error",
        title: "Could not add provider instance",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
      return;
    }
    onCreated?.(brandedId);
    setCreatedInstanceId(brandedId);
    setIsSaving(false);
    setWizardStep(setupStep);
  };

  if (addingChatGptAccount) {
    return (
      <AddManagedCodexAccountDialog
        environmentId={environmentId}
        onClose={() => handleOpenChange(false)}
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => handleOpenChange(nextOpen)}>
      <WizardPopup size="wide">
        <WizardHeader
          title="Add provider"
          description={<>Add an account or configure a provider on {environmentLabel}.</>}
        >
          <AddProviderInstanceWizardSteps
            currentStep={wizardStep}
            summaries={wizardStepSummaries}
            instanceIdError={instanceIdError}
            steps={wizardSteps}
            disabled={isSaving || isPreparingRegistryAgent || createdInstanceId !== null}
            {...(isAcpRegistry
              ? { identityStep: 1, prerequisite: { step: 0, error: acpSelectionError } }
              : {})}
            onNavigation={applyWizardNavigation}
          />
        </WizardHeader>

        {createdInstanceId ? (
          <ProviderWizardAuthenticationStep
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={createdInstanceId}
            provider={createdProvider}
            onFinish={({ signedIn }) => handleOpenChange(false, signedIn)}
          />
        ) : (
          <>
            <WizardPanel
              className={cn(isAcpRegistry && wizardStep === identityStep && "min-h-72")}
              holdHeight={wizardStep === 0 && !isManualAcpConfiguration && isRegistryLoading}
            >
              <div className={cn("grid gap-2", wizardStep !== 0 && "hidden")}>
                <div id="add-instance-driver-label" className="text-sm font-medium text-foreground">
                  Provider
                </div>
                <RadioGroup
                  disabled={isPreparingRegistryAgent}
                  value={driver}
                  onValueChange={(value) => {
                    setDriver(ProviderDriverKind.make(value));
                    setIsManualAcpConfiguration(false);
                    setHasAttemptedSubmit(false);
                  }}
                  aria-labelledby="add-instance-driver-label"
                  className="grid grid-cols-1 sm:grid-cols-2"
                >
                  {providerClients.definitions
                    .filter((option) => option.driverKind !== ACP_REGISTRY_DRIVER_KIND)
                    .map((option) => {
                      const setupBadge = summarizeDriverSetupState(providers, option.driverKind);
                      return (
                        <RadioPrimitive.Root
                          key={option.driverKind}
                          value={option.driverKind}
                          className="relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-3 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
                        >
                          <ProviderInstanceIcon
                            driverKind={option.driverKind}
                            displayName={option.label}
                            iconClassName="size-4"
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {option.label}
                          </span>
                          {setupBadge ? (
                            <Badge variant={DRIVER_SETUP_BADGES[setupBadge].variant} size="sm">
                              {DRIVER_SETUP_BADGES[setupBadge].label}
                            </Badge>
                          ) : null}
                          <RadioPrimitive.Indicator
                            className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                            aria-hidden
                          >
                            <CheckIcon className="size-3.5 shrink-0" />
                          </RadioPrimitive.Indicator>
                          {option.badgeLabel ? (
                            <Badge variant="warning" size="sm">
                              {option.badgeLabel}
                            </Badge>
                          ) : null}
                        </RadioPrimitive.Root>
                      );
                    })}
                </RadioGroup>
              </div>

              {wizardStep === 0 ? (
                <div className="space-y-4 pt-4">
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <div aria-hidden className="flex-1 border-t border-border/70" />
                    <span>Or choose from ACP Registry</span>
                    <div aria-hidden className="flex-1 border-t border-border/70" />
                  </div>
                  {isAcpRegistry && isManualAcpConfiguration ? (
                    <div className="grid gap-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-medium text-foreground">
                            {isLocalAcp ? "Local ACP command" : "Enter manually"}
                          </h3>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {isLocalAcp
                              ? `Run an installed ACP executable on ${environmentLabel}.`
                              : "Enter an official registry ID and any local executable or auth override."}
                          </p>
                        </div>
                        <Button
                          onClick={() => {
                            setIsManualAcpConfiguration(false);
                            setHasAttemptedSubmit(false);
                          }}
                          size="xs"
                          variant="ghost"
                        >
                          Search registry
                        </Button>
                      </div>
                      <SettingsGroup variant="plain">
                        <ProviderSettingsForm
                          definition={driverOption}
                          value={configDraft}
                          idPrefix="add-provider-acpRegistry-manual"
                          variant="settings"
                          onChange={setConfigDraft}
                        />
                        {isLocalAcp ? (
                          <ProviderEnvironmentSection
                            environment={localEnvironment}
                            onChange={setLocalEnvironment}
                          />
                        ) : null}
                      </SettingsGroup>
                      {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                        <p className="text-2xs text-destructive">{acpSelectionError}</p>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <AcpRegistrySearchStep
                        environmentId={environmentId}
                        providerInstances={settings.providerInstances}
                        onPrepared={handleAcpPrepared}
                        onManualConfiguration={handleManualAcpConfiguration}
                        onLocalConfiguration={handleLocalAcpConfiguration}
                        onLoadingChange={setIsRegistryLoading}
                        onPreparingChange={setIsPreparingRegistryAgent}
                      />
                      {isAcpRegistry && hasAttemptedSubmit && acpSelectionError ? (
                        <p className="mt-2 text-2xs text-destructive">{acpSelectionError}</p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {isAcpRegistry && wizardStep === 1 && selectedAcp ? (
                <div className="mb-4 flex items-start justify-between gap-3 border-b border-border/70 pb-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {selectedAcp.name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      v{selectedAcp.version} · {selectedAcp.distribution}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2 text-2xs">
                    {selectedAcp.website ? (
                      <a
                        aria-label={`Open documentation for ${selectedAcp.name} (${selectedAcp.id})`}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.website}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Docs
                      </a>
                    ) : null}
                    {selectedAcp.repository ? (
                      <a
                        aria-label={`Open source for ${selectedAcp.name} (${selectedAcp.id})`}
                        className="text-muted-foreground hover:text-foreground"
                        href={selectedAcp.repository}
                        rel="noreferrer"
                        target="_blank"
                      >
                        Source
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <SettingsGroup
                variant="plain"
                className={cn(wizardStep !== identityStep && "hidden")}
              >
                <SettingsRow
                  title={<label htmlFor="add-provider-label">Label</label>}
                  description={
                    <span id="add-provider-label-description">Shown in the provider list.</span>
                  }
                  control={
                    <Input
                      id="add-provider-label"
                      aria-describedby="add-provider-label-description"
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder="e.g. Work"
                      value={label}
                      onChange={(event) => setIdentityDraft({ label: event.target.value })}
                    />
                  }
                />
                <SettingsRow
                  title={<label htmlFor="add-provider-instance-id">Instance ID</label>}
                  description={
                    <span id="add-provider-instance-id-description">
                      Letters, digits, '-', or '_'.
                    </span>
                  }
                  status={
                    showInstanceIdError ? (
                      <span
                        id="add-provider-instance-id-error"
                        role="alert"
                        className="text-destructive"
                      >
                        {instanceIdError}
                      </span>
                    ) : undefined
                  }
                  control={
                    <Input
                      id="add-provider-instance-id"
                      aria-describedby={
                        showInstanceIdError
                          ? "add-provider-instance-id-description add-provider-instance-id-error"
                          : "add-provider-instance-id-description"
                      }
                      size="sm"
                      className="w-full @min-[32rem]/settings-row:w-56"
                      placeholder={`${driver}_work`}
                      value={instanceId}
                      onChange={(event) => {
                        setIdentityDraft({ instanceIdOverride: event.target.value });
                      }}
                      aria-invalid={showInstanceIdError}
                    />
                  }
                />
                <SettingsRow
                  title="Accent color"
                  description="Optional marker shown in the picker."
                  control={
                    <ProviderAccentColorPicker
                      displayName={label || driverOption.label}
                      value={accentColor || undefined}
                      onCommit={(value) => setIdentityDraft({ accentColor: value })}
                      layout="inline"
                    />
                  }
                />
              </SettingsGroup>

              {!isAcpRegistry && driverSettingsFields.length > 0 ? (
                <SettingsGroup variant="plain" className={cn(wizardStep !== 2 && "hidden")}>
                  <ProviderSettingsForm
                    definition={driverOption}
                    value={configDraft}
                    idPrefix={`add-provider-${driver}`}
                    variant="settings"
                    onChange={setConfigDraft}
                  />
                </SettingsGroup>
              ) : !isAcpRegistry && wizardStep === 2 ? (
                <div className="grid gap-2">
                  <p className="text-sm text-muted-foreground">
                    This driver has no required configuration. You can add the instance now.
                  </p>
                </div>
              ) : null}
            </WizardPanel>

            <WizardFooter>
              <Button
                variant={wizardStep === 0 ? "ghost-muted" : "outline"}
                size="sm"
                disabled={isSaving || isPreparingRegistryAgent}
                onClick={() => {
                  if (wizardStep === 0) {
                    handleOpenChange(false);
                    return;
                  }
                  setWizardStep((step) => Math.max(0, step - 1));
                }}
              >
                {wizardStep === 0 ? "Cancel" : "Back"}
              </Button>
              {wizardStep === 0 && driver === "codex" ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => navigateToStep(1)}>
                    Configure manually
                  </Button>
                  <ChatGptConnectionButton
                    size="sm"
                    onClick={() => setAddingChatGptAccount(true)}
                  />
                </>
              ) : wizardStep < setupStep - 1 ? (
                <Button
                  size="sm"
                  disabled={isPreparingRegistryAgent}
                  onClick={() => navigateToStep(wizardStep + 1)}
                >
                  Next
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={isSaving || !canManageProviders}
                  onClick={() => void handleSave()}
                >
                  {isSaving ? "Adding..." : "Add and set up"}
                </Button>
              )}
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}
