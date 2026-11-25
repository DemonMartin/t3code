import { isClearComposerCommand, parseSideChatCommand } from "@t3tools/shared/composerTrigger";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";

/**
 * Whether a draft's first send is offered to its launcher: one message for one model.
 * A composer command never starts a thread. Attachments are still offered, flagged in the
 * context, so the plugin can refuse them instead of the message silently running here.
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
