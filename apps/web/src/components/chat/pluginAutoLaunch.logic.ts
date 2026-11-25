import { isClearComposerCommand, parseSideChatCommand } from "@t3tools/shared/composerTrigger";
import { isUsageLimitsCommand } from "@t3tools/shared/usageLimits";

/**
 * Whether a launcher can carry a draft's first send: one plain-text message for one model.
 * Attachments exist only on this machine, and a composer command never starts a thread.
 */
export function launcherCarriesSend(input: {
  readonly message: string;
  readonly hasAttachments: boolean;
  readonly multipleModels: boolean;
}): boolean {
  return (
    input.message.trim().length > 0 &&
    !input.hasAttachments &&
    !input.multipleModels &&
    !isUsageLimitsCommand(input.message) &&
    !isClearComposerCommand(input.message) &&
    parseSideChatCommand(input.message) === null
  );
}
