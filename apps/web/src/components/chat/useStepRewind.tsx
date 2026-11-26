import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type RunId,
  type ScopedThreadRef,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { msg, T } from "gt-react";
import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { useStableCallback } from "../../hooks/useStableCallback";
import { findRevertCheckpoint } from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import type { ChatMessage, SessionPhase } from "../../types";
import { assetEnvironment } from "../../state/assets";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage } from "./chatViewSend";
import type { makeThreadErrorSetter } from "../ChatView.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { closeThreadOverlay, makeThreadOverlayAtom, useThreadOverlay } from "./ChatOverlayHosts";

/** A step inside a turn the user asked to rewind to, or to cut out on its own. */
export interface PendingStepRewind {
  readonly itemId: TurnItemId;
  readonly runId: RunId;
  /** Only this step leaves the conversation; what came after it stays. */
  readonly only?: boolean;
  /** A message sent into the running turn (a steer): it goes back into the composer. */
  readonly message?: ChatMessage;
}

const stepRewindConfirmAtom = makeThreadOverlayAtom<PendingStepRewind>("step-rewind-confirm");

function openStepRewindConfirm(threadKey: string, pending: PendingStepRewind): void {
  appAtomRegistry.set(stepRewindConfirmAtom, { threadKey, value: pending });
}

export function StepRewindConfirmHost(props: {
  readonly threadKey: string;
  readonly onConfirm: (pending: PendingStepRewind) => void;
}) {
  const pending = useThreadOverlay(stepRewindConfirmAtom, props.threadKey);
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(stepRewindConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pending?.only === true ? (
              <T>Cut this step out?</T>
            ) : pending?.message !== undefined ? (
              <T>Edit from this message?</T>
            ) : (
              <T>Rewind to here?</T>
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pending?.message !== undefined ? (
              <T>
                The chat goes back to just before this message, which returns to the composer. What
                the agent did after it leaves the conversation. Files stay as they are.
              </T>
            ) : pending?.only === true ? (
              <T>
                This step leaves the conversation: the agent no longer sees it or its result.
                Everything before and after it stays, and files stay as they are.
              </T>
            ) : (
              <T>
                The chat goes back to just before this step. The step and everything after it leave
                the conversation, so your next message continues from there. Files stay as they are.
              </T>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            <T>Cancel</T>
          </AlertDialogClose>
          <Button
            onClick={() => {
              if (pending === null) return;
              closeThreadOverlay(stepRewindConfirmAtom);
              props.onConfirm(pending);
            }}
          >
            {pending?.only === true ? (
              <T>Cut out</T>
            ) : pending?.message !== undefined ? (
              <T>Edit from here</T>
            ) : (
              <T>Rewind</T>
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/**
 * Sends a rewind to a step inside run `runId` and waits for the server to cut the run there.
 * `revert` gets the run's ordinal, which names the checkpoint the rewind follows.
 */
async function waitForStepRewind(
  threadRef: ScopedThreadRef,
  runId: RunId,
  requestId: CommandId,
  revert: (turnCount: number) => Promise<void>,
  timeoutMs = 120_000,
): Promise<void> {
  const threadAtom = environmentThreadDetails.stateAtom(threadRef);
  const readProjection = () => Option.getOrNull(appAtomRegistry.get(threadAtom).data);
  const run = readProjection()?.runs.find((candidate) => candidate.id === runId);
  if (run === undefined || run.status === "rolled_back") {
    throw new Error(m(msg("The thread has changed. Select a step to rewind again.")));
  }
  const cutsBefore = run.truncations?.length ?? 0;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error === undefined) resolve();
      else reject(error);
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        thread.runs.some(
          (candidate) =>
            candidate.id === runId && (candidate.truncations?.length ?? 0) > cutsBefore,
        )
      )
        finish();
    };
    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error(m(msg("Timed out waiting for the thread to rewind."))));
    }, timeoutMs);
    Promise.resolve()
      .then(() => revert(run.ordinal))
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}

interface StepRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly composerRef: ComposerHandleRef;
  readonly promptRef: { current: string };
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back to a step inside a turn, or taking one step out of it: asks first, then sends the
 * rewind and waits for the thread to show it.
 */
export function useStepRewind(input: StepRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    phase,
    isSendBusy,
    isRevertingCheckpoint,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    composerRef,
    promptRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  /** A steer: rewinds to just before it and puts it back in the composer, as "Edit from here". */
  const editFromMessage = async (target: PendingStepRewind, message: ChatMessage) => {
    const ordinal = serverProjection?.runs.find((run) => run.id === target.runId)?.ordinal;
    if (!activeThread || ordinal === undefined) {
      return { error: m(msg("The thread has changed. Select a message to edit again.")) };
    }
    return rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount: ordinal,
      restoreFiles: false,
      checkpoint: findRevertCheckpoint(serverProjection, ordinal),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
      step: {
        itemId: target.itemId,
        wait: (commandId, send) => waitForStepRewind(routeThreadRef, target.runId, commandId, send),
      },
    });
  };

  const onRewindToStep = async (target: PendingStepRewind, confirmed = false) => {
    if (
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        m(
          msg("Reconnect {environment} before rewinding.", {
            environment: activeEnvironmentUnavailableLabel,
          }),
        ),
      );
      return;
    }
    if (phase === "running" || isSendBusy) {
      setThreadError(activeThread.id, m(msg("Interrupt the current turn before rewinding.")));
      return;
    }
    if (!confirmed) {
      openStepRewindConfirm(routeThreadKey, target);
      return;
    }
    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    if (target.message !== undefined) {
      const rewind = await editFromMessage(target, target.message);
      useComposerDraftStore.setState((store) => {
        const remaining = new Set(store.rewindingThreadKeys);
        remaining.delete(routeThreadKey);
        return { rewindingThreadKeys: remaining };
      });
      if (rewind.error !== null) {
        setThreadError(activeThread.id, rewind.error);
        return;
      }
      if (currentRouteThreadKeyRef.current === routeThreadKey) {
        promptRef.current = rewind.prompt;
        composerRef.current?.resetCursorState({
          prompt: rewind.prompt,
          cursor: rewind.prompt.length,
        });
        requestAnimationFrame(() => {
          if (currentRouteThreadKeyRef.current === routeThreadKey)
            composerRef.current?.focusAtEnd();
        });
      }
      return;
    }
    const commandId = CommandId.make(randomUUID());
    const failure = await waitForStepRewind(
      routeThreadRef,
      target.runId,
      commandId,
      async (turnCount) => {
        // Keep the live checkpoint identity when command context refetches a bounded window.
        const checkpoint = findRevertCheckpoint(serverProjection, turnCount);
        const result = await revertThreadCheckpoint({
          environmentId,
          input: {
            commandId,
            threadId: activeThread.id,
            turnCount,
            restoreFiles: false,
            fromItemId: target.itemId,
            ...(target.only === true ? { keepLater: true } : {}),
            ...(checkpoint === undefined
              ? {}
              : { checkpointId: checkpoint.id, scopeId: checkpoint.scopeId }),
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
    ).then(
      () => null,
      (error: unknown) =>
        thrownErrorMessage(error, m) ??
        (target.only === true
          ? m(msg("Failed to cut the step out."))
          : m(msg("Failed to rewind the conversation."))),
    );
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (failure !== null) {
      setThreadError(activeThread.id, failure);
      return;
    }
    // After a rewind the next message continues from the step, so the composer comes next.
    if (target.only === true) return;
    requestAnimationFrame(() => {
      if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
    });
  };
  const onRewindToStepStable = useStableCallback((target: PendingStepRewind) => {
    void onRewindToStep(target);
  });
  const onConfirmStepRewindStable = useStableCallback((target: PendingStepRewind) => {
    void onRewindToStep(target, true);
  });
  return { onConfirmStepRewindStable, onRewindToStepStable };
}
