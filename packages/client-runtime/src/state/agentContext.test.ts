import {
  ContextHandoffId,
  ProviderThreadId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentContextHiddenItemIds, agentContextOmitsTurns } from "./agentContext.ts";

type Projection = Parameters<typeof agentContextHiddenItemIds>[0];
type Row = Parameters<typeof agentContextHiddenItemIds>[1][number];

const first = ProviderThreadId.make("provider-thread:first");
const second = ProviderThreadId.make("provider-thread:second");

const run = (ordinal: number, providerThreadId: ProviderThreadId, fresh = false) =>
  ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    providerThreadId,
    status: "completed",
    startedAt: "2026-11-26T10:00:00.000Z",
    ...(fresh ? { freshContext: true } : {}),
  }) as unknown as OrchestrationV2ThreadProjection["runs"][number];

const row = (
  id: string,
  runOrdinal: number,
  ordinal: number,
  providerThreadId: ProviderThreadId | null,
  type: Row["item"]["type"] = "command_execution",
): Row => ({
  visibility: "local",
  item: {
    id: TurnItemId.make(id),
    type,
    status: "completed",
    runId: RunId.make(`run:${runOrdinal}`),
    providerThreadId,
    ordinal,
  },
});

const handoff = (
  targetRun: number,
  to: ProviderThreadId,
  strategy: "full_thread_summary" | "delta_since_target_last_seen",
  delivered: ReadonlyArray<string>,
) =>
  ({
    id: ContextHandoffId.make(`handoff:${targetRun}`),
    targetRunId: RunId.make(`run:${targetRun}`),
    toProviderThreadId: to,
    strategy,
    status: "ready",
    deliveredItemIds: delivered.map((id) => TurnItemId.make(id)),
    coveredRunOrdinals: { from: 1, to: Math.max(1, targetRun - 1) },
  }) as unknown as OrchestrationV2ThreadProjection["contextHandoffs"][number];

const hidden = (projection: Projection, rows: ReadonlyArray<Row>) =>
  [...agentContextHiddenItemIds(projection, rows)].toSorted();

describe("what the thread's agent has in its context", () => {
  // Run 1 on the first agent, run 2 on the second, run 3 back on the first.
  const rows = [
    row("prompt-1", 1, 100, null, "user_message"),
    row("work-1", 1, 101, first),
    row("prompt-2", 2, 200, null, "user_message"),
    row("work-2a", 2, 201, second),
    row("work-2b", 2, 202, second),
    row("switch", 2, 203, null, "handoff"),
    row("prompt-3", 3, 300, null, "user_message"),
    row("work-3", 3, 301, first),
  ];
  const runs = [run(1, first), run(2, second), run(3, first)];

  it("has every row of a thread that never changed agent", () => {
    expect(
      hidden(
        { thread: { activeProviderThreadId: first }, runs: [run(1, first)], contextHandoffs: [] },
        rows.slice(0, 2),
      ),
    ).toEqual([]);
  });

  it("lacks the other agent's work that a handoff left out", () => {
    const projection = {
      thread: { activeProviderThreadId: first },
      runs,
      contextHandoffs: [
        handoff(2, second, "full_thread_summary", ["prompt-1", "work-1"]),
        handoff(3, first, "delta_since_target_last_seen", ["prompt-2", "work-2b"]),
      ],
    };
    // Its own earlier turn is still in its session; the handoff back brought part of run 2.
    expect(hidden(projection, rows)).toEqual(["work-2a"]);
  });

  it("starts over at a handoff of the whole thread", () => {
    const projection = {
      thread: { activeProviderThreadId: second },
      runs: runs.slice(0, 2),
      contextHandoffs: [handoff(2, second, "full_thread_summary", ["prompt-1"])],
    };
    expect(hidden(projection, rows.slice(0, 6))).toEqual(["work-1"]);
  });

  it("keeps a summary only of what came before its compaction", () => {
    const compacted = [
      ...rows.slice(0, 2),
      row("prompt-4", 4, 400, null, "user_message"),
      row("work-4", 4, 401, first),
      row("compaction", 4, 402, first, "compaction"),
      row("work-4b", 4, 403, first),
    ];
    expect(
      hidden(
        {
          thread: { activeProviderThreadId: first },
          runs: [run(1, first), run(4, first)],
          contextHandoffs: [],
        },
        compacted,
      ),
    ).toEqual(["prompt-1", "prompt-4", "work-1", "work-4"]);
  });

  it("knows the thread has turns the agent lacks before any row is loaded", () => {
    const own = { thread: { activeProviderThreadId: first }, contextHandoffs: [] };
    expect(agentContextOmitsTurns({ ...own, runs: [run(1, first), run(2, first)] })).toBe(false);
    // Another agent ran a turn, the session was started over, or the context was cleared.
    expect(agentContextOmitsTurns({ ...own, runs })).toBe(true);
    expect(
      agentContextOmitsTurns({
        ...own,
        runs: [run(1, first), run(2, first)],
        contextHandoffs: [handoff(2, first, "full_thread_summary", [])],
      }),
    ).toBe(true);
    expect(agentContextOmitsTurns({ ...own, runs: [run(1, first), run(3, first, true)] })).toBe(
      true,
    );
    // A long thread: the session was started over at run 25, and only later runs are loaded.
    expect(
      agentContextOmitsTurns({
        ...own,
        runs: [run(33, first), run(34, first)],
        contextHandoffs: [handoff(25, first, "full_thread_summary", [])],
      }),
    ).toBe(true);
    // A fork's first run starts from a handoff of what it inherited: nothing of its own is left out.
    expect(
      agentContextOmitsTurns({
        ...own,
        runs: [run(1, first)],
        contextHandoffs: [handoff(1, first, "full_thread_summary", [])],
      }),
    ).toBe(false);
  });

  it("has nothing from before the context was cleared", () => {
    expect(
      hidden(
        {
          thread: { activeProviderThreadId: first },
          runs: [run(1, first), run(3, first, true)],
          contextHandoffs: [],
        },
        [...rows.slice(0, 2), ...rows.slice(6)],
      ),
    ).toEqual(["prompt-1", "work-1"]);
  });
});
