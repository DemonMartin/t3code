import { isClearComposerCommand, parseSideChatCommand } from "@t3tools/shared/composerTrigger";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";

import { removeInlineContextReference } from "../../lib/composerContextReferences";

import {
  composerDraftHasUserContent,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";

export type LauncherAttachment = ComposerImageAttachment | ComposerFileAttachment;

/**
 * A draft's text names its attachments inline, by ids only this draft knows. The thread a
 * launcher starts gets the attachments themselves, so the message goes without those marks.
 */
export function launcherMessage(
  message: string,
  attachments: ReadonlyArray<LauncherAttachment>,
): string {
  return attachments.reduce(
    (text, attachment) =>
      removeInlineContextReference(
        text,
        toKindScopedComposerContextId(attachment.type, attachment.id),
      ).prompt,
    message,
  );
}

/**
 * What a draft holds besides its text: the images and files a launcher takes along, and
 * whether there is context only this environment has (terminal output, annotations, replies).
 */
export function launcherDraftContent(draft: ComposerThreadDraftState | null | undefined): {
  readonly attachments: ReadonlyArray<LauncherAttachment>;
  readonly other: boolean;
} {
  if (!draft) return { attachments: [], other: false };
  return {
    attachments: [...draft.images, ...draft.files],
    other: composerDraftHasUserContent({
      ...draft,
      prompt: "",
      images: [],
      files: [],
      persistedAttachments: [],
    }),
  };
}

/**
 * Whether a draft's first send is offered to its launcher: one message for one model.
 * A composer command never starts a thread. Content a launcher cannot carry is still offered,
 * flagged in the context, so the plugin can refuse it instead of the message running here.
 */
export function launcherCarriesSend(input: {
  readonly message: string;
  readonly hasAttachments: boolean;
  readonly multipleModels: boolean;
}): boolean {
  return (
    input.message.trim().length > 0 &&
    !input.multipleModels &&
    !isUsageLimitsCommand(input.message) &&
    !isClearComposerCommand(input.message) &&
    parseSideChatCommand(input.message) === null
  );
}
