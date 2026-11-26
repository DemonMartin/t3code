import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { HistoryIcon } from "lucide-react";
import { use } from "react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowActivityCtx, TimelineRowCtx } from "./timelineRowContext";

/**
 * Whether the conversation can be cut at this row: a finished step the agent took in one of this
 * thread's own turns. A fork's inherited rows belong to the thread they came from, a subagent's
 * rows to its own conversation, and T3 Code's own notices to neither.
 */
function canRewindToStep(projectedItem: OrchestrationV2ProjectedTurnItem): boolean {
  const { item } = projectedItem;
  return (
    projectedItem.visibility === "local" &&
    item.runId !== null &&
    item.providerThreadId !== null &&
    item.parentItemId === null &&
    item.type !== "user_message" &&
    item.status !== "pending" &&
    item.status !== "running" &&
    item.status !== "waiting"
  );
}

/**
 * "Rewind to here" on a step inside a turn. In a work row it appears on hover, like the row's
 * timestamp; beside a reply it follows the reply's own actions.
 */
export function TimelineStepRewindButton({
  projectedItem,
  placement,
}: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem | undefined;
  readonly placement: "row" | "reply";
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const gt = useGT();
  const onRewindToStep = ctx.onRewindToStep;
  const runId = projectedItem?.item.runId ?? null;
  if (
    onRewindToStep === undefined ||
    projectedItem === undefined ||
    runId === null ||
    !canRewindToStep(projectedItem)
  )
    return null;

  const button = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={placement === "row" ? "icon-micro" : "xs"}
            variant={placement === "row" ? "ghost-muted" : "ghost"}
            data-step-rewind={projectedItem.sourceItemId}
            disabled={activity.isRevertingCheckpoint || activity.isWorking}
            onClick={(event) => {
              // The row itself toggles its details.
              event.stopPropagation();
              onRewindToStep({ itemId: projectedItem.sourceItemId, runId });
            }}
            onKeyDown={(event) => event.stopPropagation()}
            aria-label={gt("Rewind to here")}
          />
        }
      >
        <HistoryIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Rewind to here</T>
      </TooltipPopup>
    </Tooltip>
  );
  if (placement === "reply") return button;
  return (
    // Takes no room until the row is hovered or focused, so labels keep their width.
    <span className="pointer-events-none absolute flex shrink-0 opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100">
      {button}
    </span>
  );
}
