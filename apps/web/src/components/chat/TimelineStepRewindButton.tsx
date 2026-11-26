import type { OrchestrationV2ProjectedTurnItem, RunId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { HistoryIcon, PencilIcon, ScissorsIcon } from "lucide-react";
import { use } from "react";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import type { ChatMessage } from "../../types";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRowSharedState,
} from "./timelineRowContext";

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

/** Whether the agent that ran the run can rewind into it; it can be another than the current one. */
function runCanRewind(
  ctx: Pick<TimelineRowSharedState, "runs" | "stepRewindInstanceIds">,
  runId: RunId,
): boolean {
  const run = ctx.runs.find((candidate) => candidate.id === runId);
  return run !== undefined && ctx.stepRewindInstanceIds.has(run.providerInstanceId);
}

/**
 * "Edit from here" on a message sent into a running turn (a steer): the turn goes back to just
 * before it and the message returns to the composer, as for a message that started a turn.
 */
export function SteerRewindButton({
  message,
  projectedItem,
}: {
  readonly message: ChatMessage;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const gt = useGT();
  const onRewindToStep = ctx.onRewindToStep;
  const runId = projectedItem?.item.runId ?? null;
  if (
    onRewindToStep === undefined ||
    projectedItem === undefined ||
    projectedItem.visibility !== "local" ||
    runId === null ||
    (message.inputIntent !== "steer" && message.inputIntent !== "promoted_queued_to_steer") ||
    !runCanRewind(ctx, runId)
  )
    return null;
  return (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-steer-rewind={projectedItem.sourceItemId}
          disabled={activity.isRevertingCheckpoint || activity.isWorking}
          onClick={() => onRewindToStep({ itemId: projectedItem.sourceItemId, runId, message })}
          aria-label={gt("Edit from here")}
        />
      }
      label={<T>Edit from here</T>}
    >
      <PencilIcon className="size-3" />
    </SharedTooltipTrigger>
  );
}

/**
 * "Cut out" and "Rewind to here" on a step inside a turn: the first takes just that step out of
 * the conversation, the second everything from it on. In a work row they appear on hover, like
 * the row's timestamp; beside a reply they follow the reply's own actions.
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
    !canRewindToStep(projectedItem) ||
    !runCanRewind(ctx, runId)
  )
    return null;

  const action = (only: boolean) => (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          size={placement === "row" ? "icon-micro" : "xs"}
          variant={placement === "row" ? "ghost-muted" : "ghost"}
          {...(only
            ? { "data-step-cut": projectedItem.sourceItemId }
            : { "data-step-rewind": projectedItem.sourceItemId })}
          disabled={activity.isRevertingCheckpoint || activity.isWorking}
          onClick={(event) => {
            // The row itself toggles its details.
            event.stopPropagation();
            onRewindToStep({ itemId: projectedItem.sourceItemId, runId, only });
          }}
          onKeyDown={(event) => event.stopPropagation()}
          aria-label={only ? gt("Cut out") : gt("Rewind to here")}
        />
      }
      label={only ? <T>Cut out</T> : <T>Rewind to here</T>}
    >
      {only ? <ScissorsIcon className="size-3" /> : <HistoryIcon className="size-3" />}
    </SharedTooltipTrigger>
  );
  if (placement === "reply") {
    return (
      <>
        {action(true)}
        {action(false)}
      </>
    );
  }
  return (
    // Takes no room until the row is hovered or focused, so labels keep their width.
    <span className="pointer-events-none absolute flex shrink-0 gap-0.5 opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:static pointer-coarse:opacity-100">
      {action(true)}
      {action(false)}
    </span>
  );
}
