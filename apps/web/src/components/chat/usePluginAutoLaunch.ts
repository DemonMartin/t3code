import { useAtomValue } from "@effect/atom-react";
import {
  pluginAutoLauncher,
  pluginEnvironmentLaunchResult,
  pluginLaunchDestination,
  pluginNoticeResult,
  type PluginAutoLauncher,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, type PluginInput, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentCatalog } from "../../connection/catalog";
import { managedPluginEnvironmentsAtom, pluginCatalogsAtom } from "../../state/plugins";
import { waitForThreadLoaded, waitForThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { assetEnvironment } from "../../state/assets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
} from "../../lib/attachmentUploadQueue";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  launcherCarriesSend,
  launcherMessage,
  type LauncherAttachment,
} from "./pluginAutoLaunch.logic";

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
  /** The images and files that went with the message, to hand back if the launch is withdrawn. */
  readonly attachments: ReadonlyArray<LauncherAttachment>;
  readonly startedAt: string;
}

// By the draft thread that sent them. In memory only: a reload forgets the launch's progress,
// and its thread still shows up in the sidebar.
const pluginLaunchesAtom = Atom.make<ReadonlyMap<ThreadId, PluginAutoLaunch>>(
  new Map<ThreadId, PluginAutoLaunch>(),
).pipe(Atom.keepAlive);
const launchWatches = new Map<string, () => void>();

/** Takes a claimed send's images and files out of its draft: the launch holds them now. */
export function takeLaunchAttachments(
  target: ComposerThreadTarget,
  attachments: ReadonlyArray<LauncherAttachment>,
) {
  const store = useComposerDraftStore.getState();
  for (const attachment of attachments) {
    if (attachment.type === "image") store.removeImage(target, attachment.id);
    else store.removeFile(target, attachment.id);
  }
  releaseDraftAttachments(attachments);
}

/** Puts a withdrawn launch's images and files back into its draft, which uploads them again. */
export function returnLaunchAttachments(
  target: ComposerThreadTarget,
  attachments: ReadonlyArray<LauncherAttachment>,
) {
  const store = useComposerDraftStore.getState();
  store.addImages(
    target,
    attachments.flatMap((attachment) =>
      // Removing an image from a draft revokes its preview.
      attachment.type === "image"
        ? [{ ...attachment, previewUrl: URL.createObjectURL(attachment.file) }]
        : [],
    ),
  );
  store.addFiles(
    target,
    attachments.flatMap((attachment) => {
      if (attachment.type !== "file" || attachment.file === null) return [];
      const { uploadedAttachmentId: _id, uploadEnvironmentId: _environment, ...file } = attachment;
      return [file];
    }),
  );
}

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
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const router = useRouter();

  /**
   * Where the plugin can read each attachment on this environment, which already holds the
   * draft's uploads. Null while one is still uploading, failed, or is no longer there.
   */
  const describeAttachments = async (
    environmentId: EnvironmentId,
    attachments: ReadonlyArray<LauncherAttachment>,
  ) => {
    if (attachments.length === 0) return [];
    await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
    const uploaded = getUploadedAttachments({ environmentId, images: attachments });
    if (uploaded === null) return null;
    const described = await Promise.all(
      uploaded.map(async ({ type, id, name, mimeType, sizeBytes }) => {
        const result = await createAssetUrl({
          environmentId,
          input: { resource: { _tag: "attachment", attachmentId: id, fileName: name, mimeType } },
        });
        return result._tag === "Success"
          ? { type, name, mimeType, sizeBytes, url: result.value.relativeUrl }
          : null;
      }),
    );
    return described.every((attachment) => attachment !== null) ? described : null;
  };

  /**
   * Null when this send is not the launcher's to take. Otherwise resolves true when it must not
   * go out locally: the plugin took it, or its command failed.
   */
  return (send: {
    readonly threadId: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly launcher: PluginAutoLauncher;
    readonly context: PluginInput & { readonly message: string; readonly hasAttachments: boolean };
    /** The draft's images and files; they start the thread together with the message. */
    readonly attachments: ReadonlyArray<LauncherAttachment>;
    readonly multipleModels: boolean;
    /** Whether the composer still shows the draft this send came from. */
    readonly isCurrent: () => boolean;
    readonly onClaimed: (
      context: PluginInput,
      attachments: ReadonlyArray<LauncherAttachment>,
    ) => void;
  }): Promise<boolean> | null => {
    const { environmentId, launcher, threadId } = send;
    if (
      sendInFlightRef.current ||
      !launcherCarriesSend({ ...send.context, multipleModels: send.multipleModels })
    )
      return null;
    // `notices` tells the plugin this client shows a refusal's reason instead of a bare failure.
    const context = {
      ...send.context,
      message: launcherMessage(send.context.message, send.attachments),
      requestId: randomUUID(),
      notices: true,
    };
    const draftPath = router.state.location.pathname;
    const refused = (description: string) => {
      toastManager.add(stackedThreadToast({ type: "error", title: launcher.title, description }));
      return true;
    };
    sendInFlightRef.current = true;
    return describeAttachments(environmentId, send.attachments)
      .then((attachments) =>
        attachments === null
          ? null
          : execute({
              environmentId,
              input: {
                pluginId: launcher.pluginId,
                commandId: launcher.autoLaunch.commandId,
                permission: launcher.autoLaunch.permission,
                input: attachments.length > 0 ? { ...context, attachments } : context,
              },
            }),
      )
      .finally(() => {
        sendInFlightRef.current = false;
      })
      .then((outcome) => {
        if (outcome === null)
          return refused(
            m(msg("An attachment is still uploading or could not be uploaded. Send again.")),
          );
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
        const notice = pluginNoticeResult(outcome.value);
        if (notice !== null) return refused(notice.text);
        // A composer that moved to another thread meanwhile must not send this draft's message.
        if (pluginEnvironmentLaunchResult(outcome.value)?.requestId !== context.requestId)
          return !send.isCurrent();
        send.onClaimed(context, send.attachments);
        beginPluginLaunch(
          threadId,
          {
            environmentId,
            pluginId: launcher.pluginId,
            viewId: launcher.viewId,
            title: launcher.title,
            context,
            attachments: send.attachments,
            startedAt: new Date().toISOString(),
          },
          async (destination) => {
            // The thread shows up in the sidebar either way; it only opens for a user still waiting.
            if (router.state.location.pathname !== draftPath) return;
            // Open the thread once it can be shown: arriving before its messages have loaded
            // flashes an empty page between the launch steps and the conversation.
            const ref = scopeThreadRef(
              EnvironmentId.make(destination.environmentId),
              ThreadId.make(destination.threadId),
            );
            await waitForThreadShell(ref, 8_000);
            await waitForThreadLoaded(ref, 4_000);
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
