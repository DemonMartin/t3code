import { msg } from "gt-react";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useEnvironmentProviders } from "../../state/environments";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { managedCapabilityDenial } from "@t3tools/client-runtime/contract-labels";
import { useAuth } from "@clerk/react";
import { Link } from "@tanstack/react-router";
import {
  AgentFeedbackMode,
  DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT,
  MAX_WORKFLOW_SKIPPED_RUNS_KEPT,
  ModelSelection,
  ProviderInstanceId,
  type RefusalRecoverySettings,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useT3ConnectAuthPrompt } from "../clerk/useT3ConnectAuthPrompt";
import { Button } from "../ui/button";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { commitNumberFieldOnEnter } from "./commitNumberFieldOnEnter";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { firstManagedDenial, usePrimaryManagedPolicy } from "~/state/managedPolicy";

/** Features still settling in. */
export function LabsSettingsPanel() {
  const gt = useGT();
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title={gt("Beta")}>
        <BoringSidebarRow />
        {/* Clerk is only mounted when this build has T3 Connect. */}
        {hasCloudPublicConfig() ? <GuestLinksRowWithSignIn /> : <GuestLinksRow />}
        <LinkedEnvironmentsRow />
        <WorkflowsRow />
        <WorkflowSkippedRunsRow />
        <RefusalRecoveryRow />
        <PromptSuggestionsRow />
        <SimlockHostsRow />
        <FastWorktreeCheckoutRow />
        <AgentFeedbackRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function BoringSidebarRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      devicePreference
      description={gt(
        "Group sidebar threads into project folders. Pinned threads stay on top, and Snoozed and Settled stay below the folders.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarEnabled}
          onCheckedChange={(checked) => updateSettings({ boringSidebarEnabled: Boolean(checked) })}
          aria-label={gt("Boring sidebar (group by project)")}
        />
      }
    >
      {settings.boringSidebarEnabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <BoringSidebarMultilineRow />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function BoringSidebarMultilineRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar-multiline")}
      devicePreference
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Show folder threads on two lines: the title, then the branch, pull request, and agent.",
      )}
      control={
        <Switch
          checked={settings.boringSidebarMultilineRows}
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarMultilineRows: Boolean(checked) })
          }
          aria-label={gt("Two-line folder rows")}
        />
      }
    />
  );
}

/** Signed out of T3 Connect, the row offers to sign in instead of its switch. */
function GuestLinksRowWithSignIn() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { isSignedIn } = useAuth();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  // `isSignedIn` is undefined until Clerk loads.
  if (isSignedIn !== false) return <GuestLinksRow />;
  return (
    <SettingsRow
      {...searchableSetting("guest-links")}
      description={gt(
        "Share a thread with a guest who watches it live in a browser and sends messages you approve. Sign in to T3 Connect to use guest links.",
      )}
      control={
        <Button size="sm" variant="outline" onClick={openAuthPrompt}>
          <T>Sign in</T>
        </Button>
      }
    />
  );
}

function GuestLinksRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  const messages = useMessages();
  const scope = useOptionalSettingsScope();
  const primaryPolicy = usePrimaryManagedPolicy();
  // Guests arrive through T3 Connect, so a policy that turns Connect off turns this off too.
  const connectDenial = firstManagedDenial(
    scope
      ? scope.connectedEnvironments.map((environment) => environment.serverConfig?.managedPolicy)
      : [primaryPolicy],
    (policy) => managedCapabilityDenial(policy, "connect", messages),
  );
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("guest-links")}
      settingKeys={["guestSharingEnabled"]}
      // Turning guest links off still works without T3 Connect.
      managed={settings.guestSharingEnabled ? undefined : connectDenial}
      description={
        <T>
          Share a thread with a guest who watches it live in a browser and sends messages you
          approve. Needs T3 Connect: sign in and link this machine in{" "}
          <Link to="/settings/access" className="underline underline-offset-2">
            Sharing & access
          </Link>
          . Turning it off stops every guest link.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["guestSharingEnabled"]}
          checked={settings.guestSharingEnabled}
          onCheckedChange={(checked) => updateSettings({ guestSharingEnabled: Boolean(checked) })}
          aria-label={gt("Guest links")}
        />
      }
    />
  );
}

function LinkedEnvironmentsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <T>
          Let agents here work on your other machines, and theirs here. Turn it on for each machine,
          then link them in{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            Connections
          </Link>
          . While off, nothing new starts over a link; running tasks finish.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label={gt("Linked environments")}
        />
      }
    />
  );
}

function WorkflowsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflows-beta")}
      settingKeys={["workflowsEnabled"]}
      description={gt(
        "Run multi-step workflows from files in the workflows folder of this server's T3 home. Open them from the command palette. While off, nothing in that folder runs; runs wait until it is on again.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["workflowsEnabled"]}
          checked={settings.workflowsEnabled}
          onCheckedChange={(checked) => updateSettings({ workflowsEnabled: Boolean(checked) })}
          aria-label={gt("Workflows")}
        />
      }
    />
  );
}

export function RefusalRecoveryRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  const recovery = settings.refusalRecovery;
  const update = (next: Partial<typeof recovery>) =>
    updateSettings({ refusalRecovery: { ...recovery, ...next } });
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("refusal-recovery")}
      settingKeys={["refusalRecovery"]}
      description={gt(
        "Work around a provider refusing a request: strip its trigger strings, steer the system prompt and the task framing, then repair a refusal in place and continue. Off sends exactly what this server sent before.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["refusalRecovery"]}
          checked={recovery.enabled}
          onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
          aria-label={gt("Refusal recovery")}
        />
      }
    >
      {recovery.enabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <RefusalStripRow recovery={recovery} update={update} />
          <RefusalPromptRow recovery={recovery} update={update} />
          <RefusalEnvelopeRow recovery={recovery} update={update} />
          <RefusalDetectionRow recovery={recovery} update={update} />
          <RefusalRepairRow recovery={recovery} update={update} />
          <RefusalProviderRow recovery={recovery} update={update} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

type RefusalSettings = RefusalRecoverySettings;
type RefusalSettingsUpdate = (next: Partial<RefusalSettings>) => void;

const REFUSAL_OVERRIDE_MODES = [
  ["amend", msg("Amend")],
  ["replace", msg("Replace")],
  ["off", msg("Off")],
] as const;

const REFUSAL_CUT_MODES = [
  ["annotate", msg("Rewrite the refused step")],
  ["drop-refusal-only", msg("Drop the refused answer")],
  ["drop-whole-turn", msg("Drop the whole turn")],
] as const;

function RefusalStripRow(props: {
  readonly recovery: RefusalSettings;
  readonly update: RefusalSettingsUpdate;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const enabled = props.recovery.strip.enabled;
  return (
    <SettingsRow
      {...searchableSetting("refusal-strip")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Replace refusal trigger strings with a placeholder in prompts and tool output. Runs on its own, with every other layer off.",
      )}
      resetAction={
        enabled ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset stripping to default")}
            onClick={() => props.update({ strip: { ...props.recovery.strip, enabled: true } })}
          />
        )
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            props.update({ strip: { ...props.recovery.strip, enabled: Boolean(checked) } })
          }
          aria-label={gt("Strip refusal trigger strings")}
        />
      }
    />
  );
}

function RefusalPromptRow(props: {
  readonly recovery: RefusalSettings;
  readonly update: RefusalSettingsUpdate;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const prompt = props.recovery.promptOverride;
  return (
    <SettingsRow
      {...searchableSetting("refusal-prompt")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Tell the model, in its system prompt, that this machine is an authorized fixture and that it should answer instead of hedging. Replace drops the provider's own refusal paragraph.",
      )}
      resetAction={
        prompt.enabled && prompt.mode === "amend" ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset prompt steering to default")}
            onClick={() =>
              props.update({ promptOverride: { ...prompt, enabled: true, mode: "amend" } })
            }
          />
        )
      }
      control={
        <div className="flex items-center gap-2">
          <Select
            value={prompt.mode}
            disabled={!prompt.enabled}
            onValueChange={(mode) => {
              if (mode !== null) props.update({ promptOverride: { ...prompt, mode } });
            }}
          >
            <SelectTrigger
              aria-label={gt("Prompt steering mode")}
              size="sm"
              className="w-full sm:w-40"
            >
              <SelectValue>
                {m(REFUSAL_OVERRIDE_MODES.find(([mode]) => mode === prompt.mode)?.[1])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {REFUSAL_OVERRIDE_MODES.map(([mode, label]) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {m(label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Switch
            checked={prompt.enabled}
            onCheckedChange={(checked) =>
              props.update({ promptOverride: { ...prompt, enabled: Boolean(checked) } })
            }
            aria-label={gt("Steer the system prompt")}
          />
        </div>
      }
    />
  );
}

function RefusalEnvelopeRow(props: {
  readonly recovery: RefusalSettings;
  readonly update: RefusalSettingsUpdate;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const enabled = props.recovery.envelope.enabled;
  return (
    <SettingsRow
      {...searchableSetting("refusal-envelope")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Wrap a request that trips a refusal area in a short scope block, so the model sees what is being asked and why.",
      )}
      resetAction={
        enabled ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset task framing to default")}
            onClick={() => props.update({ envelope: { enabled: true } })}
          />
        )
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => props.update({ envelope: { enabled: Boolean(checked) } })}
          aria-label={gt("Frame refusal-area requests")}
        />
      }
    />
  );
}

function RefusalDetectionRow(props: {
  readonly recovery: RefusalSettings;
  readonly update: RefusalSettingsUpdate;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const detection = props.recovery.detection;
  return (
    <SettingsRow
      {...searchableSetting("refusal-detection")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Notice a refusal in the thread and log what matched. Detection alone only reports; it repairs nothing.",
      )}
      resetAction={
        detection.enabled && detection.textHeuristics ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset refusal detection to default")}
            onClick={() => props.update({ detection: { enabled: true, textHeuristics: true } })}
          />
        )
      }
      control={
        <Switch
          checked={detection.enabled}
          onCheckedChange={(checked) =>
            props.update({ detection: { ...detection, enabled: Boolean(checked) } })
          }
          aria-label={gt("Detect refusals")}
        />
      }
    >
      {detection.enabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <SettingsRow
            {...searchableSetting("refusal-text-heuristics")}
            className="px-0 py-2 sm:px-0"
            description={gt(
              "On providers without a structured refusal signal, also treat a short message anchored on a refusal phrase as one.",
            )}
            control={
              <Switch
                checked={detection.textHeuristics}
                onCheckedChange={(checked) =>
                  props.update({ detection: { ...detection, textHeuristics: Boolean(checked) } })
                }
                aria-label={gt("Text heuristics")}
              />
            }
          />
        </div>
      ) : null}
    </SettingsRow>
  );
}

function RefusalRepairRow(props: {
  readonly recovery: RefusalSettings;
  readonly update: RefusalSettingsUpdate;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const repair = props.recovery.repair;
  return (
    <SettingsRow
      {...searchableSetting("refusal-repair")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Keep the refused step but rewrite it: its text becomes a short stand-in, its tool results become errors, and the agent continues from there instead of starting over.",
      )}
      resetAction={
        repair.enabled && repair.cutMode === "annotate" ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset refusal repair to default")}
            onClick={() =>
              props.update({ repair: { ...repair, enabled: true, cutMode: "annotate" } })
            }
          />
        )
      }
      control={
        <div className="flex items-center gap-2">
          <Select
            value={repair.cutMode}
            disabled={!repair.enabled}
            onValueChange={(cutMode) => {
              if (cutMode !== null) props.update({ repair: { ...repair, cutMode } });
            }}
          >
            <SelectTrigger
              aria-label={gt("What a repair does with the refused step")}
              size="sm"
              className="w-full sm:w-52"
            >
              <SelectValue>
                {m(REFUSAL_CUT_MODES.find(([mode]) => mode === repair.cutMode)?.[1])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {REFUSAL_CUT_MODES.map(([mode, label]) => (
                <SelectItem key={mode} hideIndicator value={mode}>
                  {m(label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Switch
            checked={repair.enabled}
            onCheckedChange={(checked) =>
              props.update({ repair: { ...repair, enabled: Boolean(checked) } })
            }
            aria-label={gt("Repair refusals")}
          />
        </div>
      }
    >
      {repair.enabled ? (
        <div className="mt-2 mb-2 border-l-2 border-border/60 ps-3">
          <RefusalHandoffRow repair={repair} update={props.update} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

/**
 * Where a handoff goes. Left alone, the other provider's first model is used, which is the
 * first model of the first enabled instance of it.
 */
function RefusalHandoffRow(props: {
  readonly repair: RefusalSettings["repair"];
  readonly update: RefusalSettingsUpdate;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const settings = useScopedSettings();
  // The row also renders outside a settings page (tests, embedded panels), so the scope is optional.
  const scope = useOptionalSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const environment = scope?.environment ?? null;
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(
    providers,
    settings,
    scope?.target?.projectId ?? null,
  ).filter((entry) => entry.enabled && entry.isAvailable);
  const chosen = props.repair.handoffModelSelection;
  const optionOf = (instanceId: string, model: string) => `${instanceId}\u0000${model}`;
  const options = entries.flatMap((entry) =>
    entry.models.map((model) => ({
      value: optionOf(entry.instanceId, model.slug),
      label: `${entry.displayName} · ${model.slug}`,
    })),
  );
  const chosenOption = options.find(
    (option) => option.value === optionOf(chosen?.instanceId ?? "", chosen?.model ?? ""),
  );
  return (
    <SettingsRow
      {...searchableSetting("refusal-handoff")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "The model the third rung hands off to. Left unset, it is the other provider's first model; the thread returns to its previous model when the hour is up.",
      )}
      resetAction={
        chosen === null ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset handoff model to default")}
            onClick={() =>
              props.update({ repair: { ...props.repair, handoffModelSelection: null } })
            }
          />
        )
      }
      control={
        <Select
          value={chosenOption?.value ?? ""}
          onValueChange={(next) => {
            if (next === null) return;
            if (next === "") {
              props.update({ repair: { ...props.repair, handoffModelSelection: null } });
              return;
            }
            const separator = next.indexOf("\u0000");
            props.update({
              repair: {
                ...props.repair,
                handoffModelSelection: ModelSelection.make({
                  instanceId: ProviderInstanceId.make(next.slice(0, separator)),
                  model: next.slice(separator + 1),
                }),
              },
            });
          }}
        >
          <SelectTrigger aria-label={gt("Handoff model")} size="sm" className="w-full sm:w-52">
            <SelectValue>{chosenOption?.label ?? m("Other provider's first model")}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="">
              {m("Other provider's first model")}
            </SelectItem>
            {options.map((option) => (
              <SelectItem key={option.value} hideIndicator value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function RefusalProviderRow(props: {
  readonly recovery: RefusalSettings;
  readonly update: RefusalSettingsUpdate;
}) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const providers = props.recovery.providers;
  const setProvider = (provider: string, enabled: boolean) =>
    props.update({ providers: { ...providers, [provider]: { ...providers[provider], enabled } } });
  return (
    <SettingsRow
      {...searchableSetting("refusal-providers")}
      className="px-0 py-2 sm:px-0"
      description={gt(
        "Every layer above applies to both. Turn one off to leave that provider alone.",
      )}
      control={
        <div className="flex items-center gap-3">
          {(
            [
              ["claude", "Claude Code"],
              ["opencode", "OpenCode"],
            ] as const
          ).map(([provider, label]) => (
            <label key={provider} className="flex items-center gap-1.5 text-xs">
              {label}
              <Switch
                checked={providers[provider]?.enabled !== false}
                onCheckedChange={(checked) => setProvider(provider, Boolean(checked))}
                aria-label={gt("Refusal recovery in {provider}", { provider: label })}
              />
            </label>
          ))}
        </div>
      }
    />
  );
}

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

export function WorkflowSkippedRunsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workflowSkippedRunsKept"]);
  const gt = useGT();
  if (!settings.workflowsEnabled) return null;
  const kept = settings.workflowSkippedRunsKept;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("workflow-skipped-runs")}
      settingKeys={["workflowSkippedRunsKept"]}
      description={gt(
        "How many skipped runs each workflow keeps in its history. Older skipped runs are deleted; runs that did something are always kept.",
      )}
      resetAction={
        mixed || kept !== DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT ? (
          <SettingResetButton
            ariaLabel={gt("Reset skipped runs kept to default")}
            onClick={() =>
              updateSettings({ workflowSkippedRunsKept: DEFAULT_WORKFLOW_SKIPPED_RUNS_KEPT })
            }
          />
        ) : null
      }
      control={
        <div className="w-24">
          <NumberField
            value={mixed ? null : kept}
            min={0}
            max={MAX_WORKFLOW_SKIPPED_RUNS_KEPT}
            format={NO_GROUPING}
            size="sm"
            onValueCommitted={(value) => {
              if (value === null || !Number.isInteger(value) || (!mixed && value === kept)) return;
              updateSettings({ workflowSkippedRunsKept: value });
            }}
          >
            <NumberFieldGroup>
              <NumberFieldInput
                aria-label={gt("Skipped runs kept")}
                placeholder={mixed ? gt("Mixed") : undefined}
                onKeyDown={commitNumberFieldOnEnter}
              />
            </NumberFieldGroup>
          </NumberField>
        </div>
      }
    />
  );
}

function PromptSuggestionsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("prompt-suggestions-beta")}
      settingKeys={["promptSuggestionsEnabled"]}
      description={gt(
        "Show a predicted next message in the empty composer after a Claude or Codex turn. Tab uses it. Each is an extra cached request on your plan. Needs Codex 0.165+. Claude threads update on restart.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["promptSuggestionsEnabled"]}
          checked={settings.promptSuggestionsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ promptSuggestionsEnabled: Boolean(checked) })
          }
          aria-label={gt("Suggest next prompt")}
        />
      }
    />
  );
}

function SimlockHostsRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("simlock-hosts")}
      settingKeys={["simlockDeviceHostsEnabled"]}
      description={
        <T>
          Let the Device panel lease simulators and emulators from your own{" "}
          <a
            href="https://incubator.callstack.com/simlock/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Simlock
          </a>{" "}
          pool, added in{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            Devices
          </Link>
          . An alpha that may change or break. T3 Code never installs Simlock.
        </T>
      }
      control={
        <ScopedSwitch
          settingKeys={["simlockDeviceHostsEnabled"]}
          checked={settings.simlockDeviceHostsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ simlockDeviceHostsEnabled: Boolean(checked) })
          }
          aria-label={gt("Simlock device hosts")}
        />
      }
    />
  );
}

/** Shows only when every machine in scope is a Mac, since only macOS servers honor it. */
function FastWorktreeCheckoutRow() {
  const searchableSetting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("worktree-fast-checkout")}
      settingKeys={["fastWorktreeCheckout"]}
      description={gt(
        "On a Mac, clone new worktrees from a checkout cached in the T3 home folder instead of writing every file. Uses Git’s normal checkout when it can’t. Turning it off deletes the cache.",
      )}
      control={
        <ScopedSwitch
          settingKeys={["fastWorktreeCheckout"]}
          checked={settings.fastWorktreeCheckout}
          onCheckedChange={(checked) => updateSettings({ fastWorktreeCheckout: Boolean(checked) })}
          aria-label={gt("Fast worktree checkout")}
        />
      }
    />
  );
}

/** Shows only when every machine in scope honors it; older servers drop the setting. */
const AGENT_FEEDBACK_MODES = AgentFeedbackMode.literals;
const AGENT_FEEDBACK_MODE_LABELS: Record<AgentFeedbackMode, string> = {
  off: msg("Off"),
  "on-request": msg("When I ask"),
  auto: msg("Automatic"),
};
const AGENT_FEEDBACK_MODE_DESCRIPTIONS: Record<AgentFeedbackMode, string> = {
  off: msg("Agents send no feedback to the T3 team."),
  "on-request": msg(
    "When you ask, agents show you a short report about T3 Code and send it to the T3 team if you approve.",
  ),
  auto: msg(
    "Agents also report T3 Code problems they hit on their own, such as a T3 tool that failed.",
  ),
};

function AgentFeedbackRow() {
  const searchableSetting = useSearchableSetting();
  const { scope, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  const m = useMessages();
  const mixed = useScopedSettingsMixed(["agentFeedback"]);
  if (
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    connectedEnvironments.length === 0 ||
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.agentFeedback !== true,
    )
  )
    return null;
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("agent-feedback")}
      settingKeys={["agentFeedback"]}
      description={
        mixed
          ? gt("The selected machines use different agent feedback modes.")
          : m(AGENT_FEEDBACK_MODE_DESCRIPTIONS[settings.agentFeedback.mode])
      }
      control={
        <Select
          value={mixed ? null : settings.agentFeedback.mode}
          onValueChange={(mode) => {
            if (mode !== null) updateSettings({ agentFeedback: { mode } });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Agent feedback")}>
            <SelectValue>
              {(mode: AgentFeedbackMode | null) =>
                mode === null ? gt("Mixed") : m(AGENT_FEEDBACK_MODE_LABELS[mode])
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {AGENT_FEEDBACK_MODES.map((mode) => (
              <SelectItem key={mode} hideIndicator value={mode}>
                {m(AGENT_FEEDBACK_MODE_LABELS[mode])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
