import type {
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  TurnItemId,
} from "@t3tools/contracts";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "contextHandoffs"> & {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "activeProviderThreadId">;
};
/** A timeline row, with or without its text. */
type Row = Pick<OrchestrationV2ProjectedTurnItem, "visibility"> & {
  readonly item: Pick<
    OrchestrationV2TurnItem,
    "id" | "type" | "status" | "runId" | "providerThreadId" | "ordinal"
  >;
};

// What an agent's context is made of. Other rows are the app's own: where the context changed,
// checkpoints, requests. They explain the view, so they stay in it.
const CONTENT: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "todo_list",
  "proposed_plan",
]);

/** The agent's session: the run it starts at, and the handoffs that brought it other work. */
function agentSession(projection: Projection) {
  const agent = projection.thread.activeProviderThreadId;
  if (agent === null) return null;
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  // The session holds nothing from before a cleared context, or from before a handoff that gave
  // it the whole thread: that is how a new or a restarted session begins.
  let start = 0;
  for (const run of projection.runs) {
    if (run.freshContext === true && run.startedAt !== null) start = Math.max(start, run.ordinal);
  }
  const handoffs = projection.contextHandoffs.flatMap((handoff) => {
    const target = runs.get(handoff.targetRunId);
    return handoff.toProviderThreadId === agent &&
      handoff.status !== "failed" &&
      handoff.status !== "superseded" &&
      target?.status !== "rolled_back"
      ? // A long thread's older runs are not loaded; a handoff's run follows the ones it covers.
        [{ handoff, ordinal: target?.ordinal ?? handoff.coveredRunOrdinals.to + 1 }]
      : [];
  });
  for (const { handoff, ordinal } of handoffs) {
    if (handoff.strategy === "full_thread_summary") start = Math.max(start, ordinal);
  }
  return { agent, runs, start, handoffs };
}

/**
 * Whether the thread has turns its agent's session does not hold as they ran: ones from before
 * the session started, or ones another agent ran. Unlike the hidden rows, this needs none of the
 * thread's rows loaded.
 */
export function agentContextOmitsTurns(projection: Projection): boolean {
  const session = agentSession(projection);
  return (
    session !== null &&
    // Past the first run, the session began after the thread did; the runs before may not be loaded.
    (session.start > 1 ||
      projection.runs.some(
        (run) =>
          run.status !== "rolled_back" &&
          run.startedAt !== null &&
          run.providerThreadId !== null &&
          run.providerThreadId !== session.agent,
      ))
  );
}

/**
 * The thread's own rows its current agent lacks: another agent's work a handoff left out, and
 * what came before a restarted session, a cleared context or a compaction. A handed-over item
 * counts as seen even if shortened; a compaction hides what it summarized.
 */
export function agentContextHiddenItemIds(
  projection: Projection,
  rows: ReadonlyArray<Row>,
): ReadonlySet<TurnItemId> {
  const hidden = new Set<TurnItemId>();
  const session = agentSession(projection);
  if (session === null) return hidden;
  const { agent, runs, start, handoffs } = session;

  // The agent's latest compaction: what came before it is now a summary.
  let compacted: { readonly run: number; readonly item: number } | undefined;
  for (const { item } of rows) {
    const run = item.runId === null ? undefined : runs.get(item.runId);
    if (
      item.type !== "compaction" ||
      item.status !== "completed" ||
      item.providerThreadId !== agent ||
      run === undefined ||
      run.ordinal < start
    )
      continue;
    if (
      compacted === undefined ||
      run.ordinal > compacted.run ||
      (run.ordinal === compacted.run && item.ordinal > compacted.item)
    )
      compacted = { run: run.ordinal, item: item.ordinal };
  }

  const handed = new Set<TurnItemId>();
  for (const { handoff, ordinal } of handoffs) {
    // Handed over into a session that was later started over, or before the compaction.
    if (ordinal < start || (compacted !== undefined && ordinal <= compacted.run)) continue;
    for (const itemId of handoff.deliveredItemIds ?? []) handed.add(itemId);
  }

  for (const row of rows) {
    const { item } = row;
    // A fork's inherited rows reached the agent with the fork; they are not this thread's own.
    if (row.visibility !== "local" || !CONTENT.has(item.type) || handed.has(item.id)) continue;
    const run = item.runId === null ? undefined : runs.get(item.runId);
    // Rows outside any run are the app's own notes.
    if (run === undefined) continue;
    const own =
      (item.providerThreadId ?? run.providerThreadId) === agent &&
      run.ordinal >= start &&
      (compacted === undefined ||
        run.ordinal > compacted.run ||
        (run.ordinal === compacted.run && item.ordinal > compacted.item));
    if (!own) hidden.add(item.id);
  }
  return hidden;
}
