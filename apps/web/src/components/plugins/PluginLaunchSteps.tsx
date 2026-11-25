import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { pluginLaunchProgress, type PluginLaunchStep } from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { PluginAction } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { RotateCwIcon, XIcon } from "lucide-react";
import { Fragment, useContext, useEffect, useState } from "react";

import { pluginCatalogsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import type { PluginAutoLaunch } from "../chat/usePluginAutoLaunch";
import {
  SetupStepActions,
  SetupStepDetail,
  SetupStepNote,
  SetupStepRow,
} from "../chat/WorktreeSetupCard";
import { Button } from "../ui/button";

/**
 * A launch a plugin is carrying out for a draft's first send, shown as the setup steps of the
 * thread being started. The launcher's view is the source: its status blocks are the steps and
 * its actions the controls. `onWithdrawn` fires once the view no longer has the launch.
 */
export function PluginLaunchSteps({
  launch,
  onWithdrawn,
}: {
  launch: PluginAutoLaunch;
  onWithdrawn: () => void;
}) {
  const gt = useGT();
  const query = serverEnvironment.pluginView({
    environmentId: launch.environmentId,
    input: { pluginId: launch.pluginId, viewId: launch.viewId, context: launch.context },
  });
  const result = useAtomValue(query);
  const registry = useContext(RegistryContext);
  const commands =
    useAtomValue(pluginCatalogsAtom)
      .find((row) => row.environmentId === launch.environmentId)
      ?.catalog?.plugins.find((plugin) => plugin.id === launch.pluginId)?.commands ?? [];
  const execute = useAtomCommand(serverEnvironment.executePluginCommand, { reportFailure: false });
  const [runningActionId, setRunningActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = pluginLaunchProgress(Option.getOrNull(AsyncResult.value(result)));
  const unreadable = result._tag === "Failure";
  // Until the view answers, the launch is one step named after its launcher.
  const steps: ReadonlyArray<PluginLaunchStep> =
    progress.steps.length > 0
      ? progress.steps
      : [
          {
            id: "launch",
            label: launch.title,
            detail: null,
            status: unreadable ? "failed" : "running",
          },
        ];

  const { withdrawn } = progress;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the message back to the composer once the plugin's view no longer has this launch
  useEffect(() => {
    if (withdrawn) onWithdrawn();
  }, [withdrawn, onWithdrawn]);

  const run = (action: PluginAction) => {
    const command = commands.find((candidate) => candidate.id === action.command);
    if (!command || runningActionId !== null) return;
    setRunningActionId(action.id);
    setError(null);
    void execute({
      environmentId: launch.environmentId,
      input: {
        pluginId: launch.pluginId,
        commandId: command.id,
        permission: command.permission,
        input: action.input,
      },
    })
      .then((outcome) => {
        if (outcome._tag === "Failure" && !isAtomCommandInterrupted(outcome)) {
          const failure = squashAtomCommandFailure(outcome);
          setError(
            failure instanceof Error
              ? failure.message
              : gt("The plugin command failed. Try again."),
          );
        }
        registry.refresh(query);
      })
      .finally(() => setRunningActionId(null));
  };

  return (
    <section aria-label={launch.title} data-plugin-launch={launch.context.requestId}>
      {steps.map((step) => (
        <Fragment key={step.id}>
          <SetupStepRow
            data-plugin-launch-step={step.status}
            status={step.status}
            label={step.label}
            trailing={
              step.detail !== null && step.status === "running" ? (
                <SetupStepDetail>{step.detail}</SetupStepDetail>
              ) : null
            }
          />
          {step.detail !== null && step.status === "failed" ? (
            <SetupStepNote>{step.detail}</SetupStepNote>
          ) : null}
        </Fragment>
      ))}
      {unreadable ? (
        <SetupStepNote>
          <T>This plugin view could not be loaded.</T>
        </SetupStepNote>
      ) : null}
      {error === null ? null : <SetupStepNote>{error}</SetupStepNote>}
      {unreadable ? (
        <SetupStepActions>
          <Button type="button" size="xs" variant="ghost-muted" onClick={onWithdrawn}>
            <XIcon aria-hidden />
            {gt("Dismiss")}
          </Button>
        </SetupStepActions>
      ) : null}
      {progress.actions.length > 0 ? (
        <SetupStepActions>
          {progress.actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              size="xs"
              variant="ghost-muted"
              // The plugin's own wording says what the short label does, such as deleting the sandbox.
              aria-label={action.label}
              disabled={
                runningActionId !== null ||
                !commands.some((command) => command.id === action.command)
              }
              onClick={() => run(action)}
            >
              {action.id === "cancel" ? (
                <>
                  <XIcon aria-hidden />
                  {gt("Cancel")}
                </>
              ) : action.id === "retry" ? (
                <>
                  <RotateCwIcon aria-hidden />
                  {gt("Retry")}
                </>
              ) : (
                action.label
              )}
            </Button>
          ))}
        </SetupStepActions>
      ) : null}
    </section>
  );
}
