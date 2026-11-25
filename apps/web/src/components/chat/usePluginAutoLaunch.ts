import { useAtomValue } from "@effect/atom-react";
import {
  pluginAutoLauncher,
  pluginEnvironmentLaunchResult,
  pluginLaunchDestination,
  type PluginAutoLauncher,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type PluginInput, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentCatalog } from "../../connection/catalog";
import { managedPluginEnvironmentsAtom, pluginCatalogsAtom } from "../../state/plugins";
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

/** A first send a plugin took, until its thread exists or the plugin drops the launch. */
export interface PluginAutoLaunch {
  readonly environmentId: EnvironmentId;
  readonly pluginId: string;
  readonly viewId: string;
  readonly title: string;
  readonly context: PluginInput & { readonly message: string; readonly requestId: string };
  readonly startedAt: string;
}

// By the draft thread that sent them. In memory only: a reload forgets the launch's progress,
// and its thread still shows up in the sidebar.
const pluginLaunchesAtom = Atom.make<ReadonlyMap<ThreadId, PluginAutoLaunch>>(
  new Map<ThreadId, PluginAutoLaunch>(),
).pipe(Atom.keepAlive);
const launchWatches = new Map<string, () => void>();

export function usePluginLaunch(threadId: ThreadId): PluginAutoLaunch | null {
  return useAtomValue(pluginLaunchesAtom).get(threadId) ?? null;
}

export function endPluginLaunch(threadId: ThreadId, requestId: string) {
  launchWatches.get(requestId)?.();
  launchWatches.delete(requestId);
  appAtomRegistry.update(pluginLaunchesAtom, (current) => {
    if (current.get(threadId)?.context.requestId !== requestId) return current;
    const next = new Map(current);
    next.delete(threadId);
    return next;
  });
}

/**
 * Watched outside any component: the launch outlives the draft's view, and whether to open its
 * thread depends on where the user is at the moment it is ready.
 */
function beginPluginLaunch(
  threadId: ThreadId,
  launch: PluginAutoLaunch,
  /** Resolves once the user is where the started thread takes them, if anywhere. */
  onStarted: (destination: {
    readonly environmentId: string;
    readonly threadId: string;
  }) => Promise<void>,
) {
  const { requestId } = launch.context;
  appAtomRegistry.update(pluginLaunchesAtom, (current) => new Map(current).set(threadId, launch));
  const destinationAtom = Atom.make((get) =>
    pluginLaunchDestination(
      get(managedPluginEnvironmentsAtom),
      (environmentId) =>
        get(environmentCatalog.catalogValueAtom).entries.has(EnvironmentId.make(environmentId)),
      { environmentId: launch.environmentId, pluginId: launch.pluginId, requestId },
    ),
  );
  let ended = false;
  const stop = appAtomRegistry.subscribe(
    destinationAtom,
    (destination) => {
      if (destination === null || ended) return;
      ended = true;
      // The draft keeps showing the launch until its thread is on screen, not an empty composer.
      void onStarted(destination).finally(() => endPluginLaunch(threadId, requestId));
    },
    { immediate: true },
  );
  if (ended) stop();
  else launchWatches.set(requestId, stop);
}

/**
 * Runs a draft's first send through its launcher. The plugin claims the send by answering with
 * an `environment-launch` result for the request; any other answer leaves it to the normal send.
 */
export function usePluginAutoLaunchSend(sendInFlightRef: { current: boolean }) {
  const execute = useAtomCommand(serverEnvironment.executePluginCommand, { reportFailure: false });
  const router = useRouter();

  /**
   * Null when this send is not the launcher's to take. Otherwise resolves true when it must not
   * go out locally: the plugin took it, or its command failed.
   */
  return (send: {
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly launcher: PluginAutoLauncher;
    readonly context: PluginInput & { readonly message: string; readonly hasAttachments: boolean };
    readonly multipleModels: boolean;
    /** Whether the composer still shows the draft this send came from. */
    readonly isCurrent: () => boolean;
    readonly onClaimed: (context: PluginInput) => void;
  }): Promise<boolean> | null => {
    const { environmentId, launcher, threadId } = send;
    if (
      sendInFlightRef.current ||
      !launcherCarriesSend({ ...send.context, multipleModels: send.multipleModels })
    )
      return null;
    const context = { ...send.context, requestId: randomUUID() };
    const draftPath = router.state.location.pathname;
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
        beginPluginLaunch(
          threadId,
          {
            environmentId,
            pluginId: launcher.pluginId,
            viewId: launcher.viewId,
            title: launcher.title,
            context,
            startedAt: new Date().toISOString(),
          },
          async (destination) => {
            // The thread shows up in the sidebar either way; it only opens for a user still waiting.
            if (router.state.location.pathname !== draftPath) return;
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: {
                environmentId: EnvironmentId.make(destination.environmentId),
                threadId: ThreadId.make(destination.threadId),
              },
            });
          },
        );
        return true;
      });
  };
}
