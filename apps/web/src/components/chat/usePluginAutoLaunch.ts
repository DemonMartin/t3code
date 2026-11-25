import { useAtomValue } from "@effect/atom-react";
import {
  pluginAutoLauncher,
  pluginEnvironmentLaunchResult,
  type PluginAutoLauncher,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PluginInput, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { pluginCatalogsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { launcherCarriesSend } from "./pluginAutoLaunch.logic";

// Drafts whose user picked a machine instead. Kept in memory only, so a reload returns a
// draft to its plugin's default.
const autoLaunchOptOutsAtom = Atom.make<ReadonlySet<ThreadId>>(new Set<ThreadId>()).pipe(
  Atom.keepAlive,
);

export interface PluginAutoLaunchControl {
  readonly launcher: PluginAutoLauncher;
  /** False once the user picked a machine for this draft; its first send is then a normal one. */
  readonly active: boolean;
  readonly setActive: (active: boolean) => void;
}

/** The launcher an unsent draft starts through, when a plugin on its environment asks for that. */
export function usePluginAutoLauncher(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly unsentDraft: boolean;
}): PluginAutoLaunchControl | null {
  const catalogs = useAtomValue(pluginCatalogsAtom);
  const optedOut = useAtomValue(autoLaunchOptOutsAtom).has(input.threadId);
  const launcher = input.unsentDraft
    ? pluginAutoLauncher(catalogs.find((row) => row.environmentId === input.environmentId)?.catalog)
    : null;
  if (launcher === null) return null;
  const { threadId } = input;
  return {
    launcher,
    active: !optedOut,
    setActive: (active) =>
      appAtomRegistry.update(autoLaunchOptOutsAtom, (current) => {
        if (current.has(threadId) !== active) return current;
        const next = new Set(current);
        if (active) next.delete(threadId);
        else next.add(threadId);
        return next;
      }),
  };
}

export interface PluginAutoLaunch {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly viewId: string;
  readonly context: PluginInput;
}

/**
 * Runs a draft's first send through its launcher. The plugin claims the send by answering with
 * an `environment-launch` result for the request; any other answer leaves it to the normal send.
 */
export function usePluginAutoLaunchSend(sendInFlightRef: { current: boolean }) {
  const execute = useAtomCommand(serverEnvironment.executePluginCommand, { reportFailure: false });
  const [launch, setLaunch] = useState<PluginAutoLaunch | null>(null);

  /**
   * Null when this send is not the launcher's to take. Otherwise resolves true when it must not
   * go out locally: the plugin took it, or its command failed.
   */
  const claimSend = (send: {
    readonly environmentId: EnvironmentId;
    readonly launcher: PluginAutoLauncher;
    readonly context: PluginInput & { readonly message: string; readonly hasAttachments: boolean };
    readonly multipleModels: boolean;
    /** Whether the composer still shows the draft this send came from. */
    readonly isCurrent: () => boolean;
    readonly onClaimed: (context: PluginInput) => void;
  }): Promise<boolean> | null => {
    const { environmentId, launcher } = send;
    if (
      sendInFlightRef.current ||
      !launcherCarriesSend({ ...send.context, multipleModels: send.multipleModels })
    )
      return null;
    const context = { ...send.context, requestId: randomUUID() };
    sendInFlightRef.current = true;
    return execute({
      environmentId,
      input: {
        pluginId: launcher.pluginId,
        commandId: launcher.autoLaunch.commandId,
        permission: launcher.autoLaunch.permission,
        input: context,
      },
    })
      .finally(() => {
        sendInFlightRef.current = false;
      })
      .then((outcome) => {
        if (outcome._tag === "Failure") {
          if (!isAtomCommandInterrupted(outcome)) {
            const failure = squashAtomCommandFailure(outcome);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: launcher.title,
                description:
                  failure instanceof Error
                    ? failure.message
                    : m(msg("The plugin command failed. Try again.")),
              }),
            );
          }
          return true;
        }
        // A composer that moved to another thread meanwhile must not send this draft's message.
        if (pluginEnvironmentLaunchResult(outcome.value)?.requestId !== context.requestId)
          return !send.isCurrent();
        send.onClaimed(context);
        if (send.isCurrent())
          setLaunch({
            environmentId,
            pluginId: launcher.pluginId,
            viewId: launcher.viewId,
            context,
          });
        return true;
      });
  };

  return { claimSend, launch, closeLaunch: () => setLaunch(null) };
}
