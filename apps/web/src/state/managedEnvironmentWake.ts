import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { managedEnvironmentWakeStep } from "@t3tools/client-runtime/state/plugins";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { environmentCatalog } from "../connection/catalog";
import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { managedPluginEnvironmentsAtom } from "./plugins";
import { serverEnvironment } from "./server";

// Covers a container start and the server boot inside it.
const WAKE_TIMEOUT_MS = 120_000;

// Environments being started for something the user did.
const wakingEnvironmentIdsAtom = Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
  Atom.keepAlive,
);
const inFlight = new Map<string, Promise<boolean>>();

export const readManagedEnvironment = (environmentId: string) =>
  appAtomRegistry
    .get(managedPluginEnvironmentsAtom)
    .find((resource) => resource.environmentId === environmentId);

export const managedEnvironmentConnectedAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      ).phase === "connected",
  ),
);

/**
 * Why a managed environment is unreachable, for the thread shown on it: `starting` while it
 * comes up, `stopped` when its plugin can start it and nothing has yet. Null for anything else.
 */
export const managedEnvironmentStatusAtom = Atom.family((environmentId: string) =>
  Atom.make((get): "starting" | "stopped" | null => {
    if (get(wakingEnvironmentIdsAtom).has(environmentId)) return "starting";
    const step = managedEnvironmentWakeStep(
      get(managedPluginEnvironmentsAtom).find(
        (resource) => resource.environmentId === environmentId,
      ),
    );
    return step === "wait" ? "starting" : step === "resume" ? "stopped" : null;
  }),
);

/** The plugin's own name for starting a stopped environment, such as "Resume". */
export const managedEnvironmentResumeLabelAtom = Atom.family((environmentId: string) =>
  Atom.make(
    (get) =>
      get(managedPluginEnvironmentsAtom).find(
        (resource) => resource.environmentId === environmentId,
      )?.resume?.label ?? null,
  ),
);

function setWaking(environmentId: string, waking: boolean) {
  appAtomRegistry.update(wakingEnvironmentIdsAtom, (current) => {
    if (current.has(environmentId) === waking) return current;
    const next = new Set(current);
    if (waking) next.add(environmentId);
    else next.delete(environmentId);
    return next;
  });
}

/** Resolves true once this client is connected to the environment, false if it never comes up. */
function untilConnected(environmentId: EnvironmentId): Promise<boolean> {
  return new Promise((resolve) => {
    const connected = managedEnvironmentConnectedAtom(environmentId);
    const readiness = Atom.make((get) => ({
      connected: get(connected),
      state:
        get(managedPluginEnvironmentsAtom).find(
          (resource) => resource.environmentId === environmentId,
        )?.state ?? null,
    }));
    let retried = false;
    let settled = false;
    let stop = () => {};
    const finish = (started: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stop();
      resolve(started);
    };
    const timeout = setTimeout(() => finish(false), WAKE_TIMEOUT_MS);
    stop = appAtomRegistry.subscribe(
      readiness,
      ({ connected, state }) => {
        if (connected) finish(true);
        else if (state === "error" || state === "deleted") finish(false);
        else if (state === "running" && !retried) {
          // The connection is backing off from when the environment was down.
          retried = true;
          void runAtomCommand(appAtomRegistry, environmentCatalog.retryNow, environmentId, {
            reportFailure: false,
          });
        }
      },
      { immediate: true },
    );
    if (settled) stop();
  });
}

/**
 * Starts a stopped managed environment and waits for its connection. Null when the environment
 * is not one that is stopped or starting, so the caller carries on as for any other machine.
 * Concurrent callers share one start.
 */
export function wakeManagedEnvironment(environmentId: EnvironmentId): Promise<boolean> | null {
  const running = inFlight.get(environmentId);
  if (running) return running;
  const resource = readManagedEnvironment(environmentId);
  const step = managedEnvironmentWakeStep(resource);
  if (!resource || step === null) return null;
  const resume = step === "resume" ? resource.resumeCommand : undefined;
  setWaking(environmentId, true);
  const job = (async () => {
    if (resume) {
      const outcome = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.executePluginCommand,
        { environmentId: resource.owner.environmentId, input: resume },
        { label: "managed-environment:resume", reportFailure: false },
      );
      if (outcome._tag !== "Success") return false;
    }
    return untilConnected(environmentId);
  })().finally(() => {
    inFlight.delete(environmentId);
    setWaking(environmentId, false);
  });
  inFlight.set(environmentId, job);
  return job;
}

export function managedEnvironmentDidNotStart(environmentId: EnvironmentId) {
  const environment = readManagedEnvironment(environmentId)?.label ?? environmentId;
  return m(msg("{environment} did not start.", { environment }));
}
