import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { environmentWakeAtom, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { msg } from "gt-react";

import { environmentCatalog } from "../../connection/catalog";
import { m } from "../../i18n/messages";
import type { AppRouter } from "../../router";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  managedEnvironmentConnectedAtom,
  managedEnvironmentDidNotStart,
  readManagedEnvironment,
  wakeManagedEnvironment,
} from "../../state/managedEnvironmentWake";
import { managedPluginEnvironmentsAtom } from "../../state/plugins";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

/**
 * Run before a command reaches its environment. Only a command the user just triggered starts a
 * sandbox: one sent by background work finds it stopped and fails as it would for any machine.
 */
function wakeForCommand(environmentId: EnvironmentId) {
  return Effect.suspend(() => {
    if (navigator.userActivation?.isActive === false) return Effect.succeed(false);
    const job = wakeManagedEnvironment(environmentId);
    if (job === null) return Effect.succeed(false);
    // The action may come from the sidebar, where no banner names the environment.
    const toastId = toastManager.add({
      type: "loading",
      title: m(
        msg("Starting {provider}", {
          provider: readManagedEnvironment(environmentId)?.label ?? "",
        }),
      ),
      timeout: 0,
    });
    return Effect.promise(() => job.finally(() => toastManager.close(toastId))).pipe(
      Effect.flatMap((started) =>
        started
          ? Effect.succeed(true)
          : Effect.fail(
              new EnvironmentRpcUnavailableError({
                environmentId,
                message: managedEnvironmentDidNotStart(environmentId),
              }),
            ),
      ),
    );
  });
}

/**
 * Starts the stopped sandbox of a thread the user opens, and reconnects to one that comes back.
 * A sandbox that stops while its thread is on screen stays stopped: only opening it, or acting
 * on it, starts it again. Drafts never start one.
 */
export function startManagedEnvironmentWake(router: AppRouter): void {
  appAtomRegistry.set(environmentWakeAtom, { wake: wakeForCommand });

  // The opened thread's environment, until its plugin has said whether it is stopped.
  let undecided: EnvironmentId | null = null;
  const decide = () => {
    if (undecided === null || readManagedEnvironment(undecided) === undefined) return;
    const environmentId = undecided;
    undecided = null;
    void wakeManagedEnvironment(environmentId);
  };
  let openThreadKey: string | null = null;
  router.subscribe("onResolved", () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const threadRef = target?.kind === "server" ? target.threadRef : null;
    const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
    // A route that resolves again for the thread already open is not the user opening it.
    if (threadKey === openThreadKey) return;
    openThreadKey = threadKey;
    undecided = threadRef?.environmentId ?? null;
    decide();
  });

  const states = new Map<string, string>();
  appAtomRegistry.subscribe(
    managedPluginEnvironmentsAtom,
    (resources) => {
      decide();
      for (const resource of resources) {
        const previous = states.get(resource.environmentId);
        states.set(resource.environmentId, resource.state);
        const environmentId = EnvironmentId.make(resource.environmentId);
        if (
          previous === undefined ||
          previous === "running" ||
          resource.state !== "running" ||
          appAtomRegistry.get(managedEnvironmentConnectedAtom(environmentId))
        )
          continue;
        // Started elsewhere, such as from the plugin's page: do not wait out the backoff.
        void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId, {
          reportFailure: false,
        });
      }
    },
    { immediate: true },
  );
}
