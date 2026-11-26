/**
 * Rewinding a Claude conversation to a step inside a turn, and cutting one step out of it.
 *
 * A step is one model response: the transcript entries that share its response id, and the
 * results of its tool calls. A rewind resumes the session from the entry before the step. A cut
 * keeps what came after, so it edits the transcript file instead.
 */
import {
  ProviderDriverKind,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { field } from "../unknownField.ts";

// The adapter imports this module, so its own constant cannot be imported here.
const CLAUDE_PROVIDER = ProviderDriverKind.make("claudeAgent");

/** A user or assistant entry of a session, as the SDK lists them. */
export interface ClaudeTranscriptEntry {
  readonly type: string;
  readonly uuid: string;
  readonly message: {
    readonly content: unknown;
    /** The API response an assistant entry is a block of; its blocks share it. */
    readonly id?: unknown;
  };
}

/**
 * Where a transcript is cut so the model step that produced an item leaves it, with all after
 * it. `resumeSessionAt` is the last entry kept, null when the step opens the transcript.
 * `ordinal` is the first item cut, which can sit before the one asked for: a step's thinking
 * comes before its tool call. Null when the transcript holds none of the items from it on.
 */
export function claudeStepCut(
  messages: ReadonlyArray<ClaudeTranscriptEntry>,
  cut: ProviderAdapter.ProviderAdapterV2TurnCut,
  providerThreadId: OrchestrationV2ProviderThread["id"],
): { readonly resumeSessionAt: string | null; readonly ordinal: number } | null {
  // The native ids this adapter gives items: an entry's uuid, a tool call's id, and
  // `${uuid or response id}:thinking:${n}` or `:text:${n}` for streamed blocks.
  const entryOf = new Map<string, number>();
  const note = (nativeId: unknown, index: number) => {
    if (typeof nativeId === "string" && !entryOf.has(nativeId)) entryOf.set(nativeId, index);
  };
  messages.forEach((entry, index) => {
    note(entry.uuid, index);
    if (entry.type !== "assistant") return;
    note(entry.message.id, index);
    if (!Array.isArray(entry.message.content)) return;
    for (const block of entry.message.content) {
      if (field(block, "type") === "tool_use") note(field(block, "id"), index);
    }
  });
  const indexOf = (nativeId: string | null) =>
    nativeId === null
      ? undefined
      : (entryOf.get(nativeId) ?? entryOf.get(nativeId.replace(/:(?:thinking|text):\d+$/, "")));
  // T3's own rows (notices, stop requests) are in no entry; the next agent item stands in.
  for (const item of cut.items) {
    if (
      item.ordinal < cut.item.ordinal ||
      (item.providerThreadId !== null && item.providerThreadId !== providerThreadId)
    )
      continue;
    const found = indexOf(item.nativeItemId);
    if (found === undefined) continue;
    const response = messages[found]!.type === "assistant" ? messages[found]!.message.id : null;
    let start =
      typeof response === "string"
        ? messages.findIndex((entry) => entry.type === "assistant" && entry.message.id === response)
        : found;
    // A steer has no entry of its own in T3's items: it is the prompt just before the response
    // that followed it, and goes with that response.
    if (cut.item.type === "user_message") {
      while (start > 0 && isPromptEntry(messages[start - 1]!)) start--;
    }
    const ordinals = cut.items.flatMap((candidate) => {
      const index = indexOf(candidate.nativeItemId);
      return index !== undefined && index >= start ? [candidate.ordinal] : [];
    });
    return {
      resumeSessionAt: start === 0 ? null : messages[start - 1]!.uuid,
      ordinal: Math.min(cut.item.ordinal, ...ordinals),
    };
  }
  return null;
}

/** A user entry the person wrote, not a tool result handed back to the model. */
function isPromptEntry(entry: ClaudeTranscriptEntry): boolean {
  if (entry.type !== "user") return false;
  const content = entry.message.content;
  return (
    typeof content === "string" ||
    (Array.isArray(content) && !content.some((block) => field(block, "type") === "tool_result"))
  );
}

/**
 * A transcript's lines without the model step that produced an item (its response and tool
 * results); what followed is linked to what came before. `replacementOf` gives a removed entry's
 * last kept ancestor. Null: no such item in the transcript. "not-a-step": the item is the user's.
 */
export function claudeTranscriptWithoutStep(
  lines: ReadonlyArray<string>,
  cut: ProviderAdapter.ProviderAdapterV2TurnCut,
  providerThreadId: OrchestrationV2ProviderThread["id"],
):
  | {
      readonly lines: ReadonlyArray<string>;
      readonly replacementOf: (uuid: string) => string | null | undefined;
      readonly fromOrdinal: number;
      readonly toOrdinal?: number;
    }
  | "not-a-step"
  | null {
  const parsed = lines.map((line): unknown => {
    if (line.trim().length === 0) return undefined;
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  });
  const uuidOf = (entry: unknown) => {
    const uuid = field(entry, "uuid");
    return typeof uuid === "string" ? uuid : undefined;
  };
  // The main conversation, in file order; a subagent's sidechain is not this thread's history.
  const conversation = parsed.filter(
    (entry) =>
      uuidOf(entry) !== undefined &&
      (field(entry, "type") === "user" || field(entry, "type") === "assistant") &&
      field(entry, "isSidechain") !== true,
  );
  const responseOf = (entry: unknown) =>
    field(entry, "type") === "assistant" ? field(field(entry, "message"), "id") : undefined;
  const blocksOf = (entry: unknown): ReadonlyArray<unknown> => {
    const content = field(field(entry, "message"), "content");
    return Array.isArray(content) ? content : [];
  };
  // The native ids this adapter gives items; see `claudeStepCut`.
  const positionOf = new Map<string, number>();
  const note = (nativeId: unknown, position: number) => {
    if (typeof nativeId === "string" && !positionOf.has(nativeId))
      positionOf.set(nativeId, position);
  };
  conversation.forEach((entry, position) => {
    note(uuidOf(entry), position);
    note(responseOf(entry), position);
    if (field(entry, "type") !== "assistant") return;
    for (const block of blocksOf(entry)) {
      if (field(block, "type") === "tool_use") note(field(block, "id"), position);
    }
  });
  const find = (nativeId: string | null) =>
    nativeId === null
      ? undefined
      : (positionOf.get(nativeId) ??
        positionOf.get(nativeId.replace(/:(?:thinking|text):\d+$/, "")));
  const target = cut.items.find(
    (item) =>
      item.ordinal >= cut.item.ordinal &&
      (item.providerThreadId === null || item.providerThreadId === providerThreadId) &&
      find(item.nativeItemId) !== undefined,
  );
  if (target === undefined) return null;
  const response = responseOf(conversation[find(target.nativeItemId)!]);
  if (typeof response !== "string") return "not-a-step";

  const removed = new Set<string>();
  const toolIds = new Set<unknown>();
  for (const entry of conversation) {
    if (responseOf(entry) !== response) continue;
    removed.add(uuidOf(entry)!);
    for (const block of blocksOf(entry)) {
      if (field(block, "type") === "tool_use") toolIds.add(field(block, "id"));
    }
  }
  for (const entry of conversation) {
    if (
      field(entry, "type") === "user" &&
      blocksOf(entry).some(
        (block) =>
          field(block, "type") === "tool_result" && toolIds.has(field(block, "tool_use_id")),
      )
    )
      removed.add(uuidOf(entry)!);
  }

  const parentOf = new Map<string, unknown>();
  for (const entry of parsed) {
    const uuid = uuidOf(entry);
    if (uuid !== undefined) parentOf.set(uuid, field(entry, "parentUuid"));
  }
  const kept = (uuid: string): string | null => {
    let current: unknown = uuid;
    // A chain cannot be longer than the file; the bound guards against a cycle in a damaged one.
    for (let steps = 0; steps <= parsed.length; steps++) {
      if (typeof current !== "string") return null;
      if (!removed.has(current)) return current;
      current = parentOf.get(current);
    }
    return null;
  };
  const edited: Array<string> = [];
  parsed.forEach((entry, index) => {
    const uuid = uuidOf(entry);
    if (uuid !== undefined && removed.has(uuid)) return;
    // Every entry that hung off the step, a later one and a note beside it alike, and the
    // CLI's record of where the conversation ends.
    const links = (["parentUuid", "leafUuid"] as const).filter((key) => {
      const link = field(entry, key);
      return typeof link === "string" && removed.has(link);
    });
    if (links.length === 0) {
      edited.push(lines[index]!);
      return;
    }
    const relinked = { ...(entry as Record<string, unknown>) };
    for (const key of links) relinked[key] = kept(String(relinked[key]));
    edited.push(JSON.stringify(relinked));
  });

  const stepOrdinals = cut.items.flatMap((item) => {
    const position = find(item.nativeItemId);
    return position !== undefined && removed.has(uuidOf(conversation[position])!)
      ? [item.ordinal]
      : [];
  });
  const last = Math.max(cut.item.ordinal, ...stepOrdinals);
  const later = cut.items.flatMap((item) => {
    const position = find(item.nativeItemId);
    return item.ordinal > last &&
      position !== undefined &&
      !removed.has(uuidOf(conversation[position])!)
      ? [item.ordinal]
      : [];
  });
  return {
    lines: edited,
    replacementOf: (uuid) => (removed.has(uuid) ? kept(uuid) : undefined),
    fromOrdinal: Math.min(cut.item.ordinal, ...stepOrdinals),
    ...(later.length === 0 ? {} : { toOrdinal: Math.min(...later) }),
  };
}

const refused = (providerThread: OrchestrationV2ProviderThread, cause: string) =>
  new ProviderAdapter.ProviderAdapterRollbackThreadError({
    driver: CLAUDE_PROVIDER,
    providerThreadId: providerThread.id,
    cause,
  });

const cursorRef = (nativeId: string | null) =>
  nativeId === null ? null : { driver: CLAUDE_PROVIDER, nativeId, strength: "weak" as const };

/**
 * The rollback's result when it names a step, null when it does not or the transcript no longer
 * holds the step: the caller then rolls back to the turn as usual.
 */
export const rollbackClaudeStep = Effect.fn("ClaudeStepCut.rollbackClaudeStep")(function* <
  E1,
  E2,
>(input: {
  readonly rollback: ProviderAdapter.ProviderAdapterV2RollbackThreadInput;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly now: DateTime.Utc;
  /** The transcript entry a turn ends at, where the adapter recorded one. */
  readonly turnCursor: (turn: OrchestrationV2ProviderTurn) => string | null;
  readonly fileSystem: FileSystem.FileSystem;
  readonly transcriptPath: Effect.Effect<string | undefined, E1>;
  /** Absent in a runtime that cannot list a session's entries. */
  readonly sessionMessages?: Effect.Effect<ReadonlyArray<ClaudeTranscriptEntry>, E2>;
}) {
  const { providerThread, providerThreadTurns, target } = input.rollback;
  const cut = target.type === "provider_turn" ? target.cut : undefined;
  if (cut === undefined || target.type !== "provider_turn") return null;
  const idle = {
    ...providerThread,
    providerSessionId: input.providerSessionId,
    status: "idle" as const,
    updatedAt: input.now,
  };

  if (cut.only === true) {
    // Later steps and turns stay, so the transcript itself loses the step: resuming at an entry
    // can only drop a tail.
    const transcriptPath = yield* input.transcriptPath;
    if (transcriptPath === undefined) {
      return yield* refused(
        providerThread,
        "Claude's transcript for this conversation was not found.",
      );
    }
    const transcript = yield* input.fileSystem.readFileString(transcriptPath);
    const edit = claudeTranscriptWithoutStep(transcript.split("\n"), cut, providerThread.id);
    if (edit === "not-a-step") {
      return yield* refused(
        providerThread,
        "Only a step the agent took can be cut out of a Claude conversation.",
      );
    }
    // Nothing to take out: a cut that already ran looks like this.
    if (edit === null) return { providerThread: idle, messages: [], runtimeRequests: [] };
    // Replaced in one move, so a reader never sees half a transcript.
    const draft = `${transcriptPath}.t3-cut`;
    yield* input.fileSystem.writeFileString(draft, edit.lines.join("\n"));
    yield* input.fileSystem.rename(draft, transcriptPath);
    // A cursor that sat on the step moves to the entry before it.
    const head = idle.nativeConversationHeadRef?.nativeId;
    const movedHead = head == null ? undefined : edit.replacementOf(head);
    return {
      providerThread:
        movedHead === undefined
          ? idle
          : { ...idle, nativeConversationHeadRef: cursorRef(movedHead) },
      messages: [],
      runtimeRequests: [],
      cutFromOrdinal: edit.fromOrdinal,
      ...(edit.toOrdinal === undefined ? {} : { cutToOrdinal: edit.toOrdinal }),
      providerTurns: providerThreadTurns.flatMap((turn) => {
        const cursor = input.turnCursor(turn);
        const moved = cursor === null ? undefined : edit.replacementOf(cursor);
        return moved === undefined ? [] : [{ ...turn, nativeTurnRef: cursorRef(moved) }];
      }),
    } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
  }

  if (input.sessionMessages === undefined) {
    return yield* refused(
      providerThread,
      "This Claude runtime cannot read its transcript to rewind into a turn.",
    );
  }
  const step = claudeStepCut(yield* input.sessionMessages, cut, providerThread.id);
  if (step === null) return null;
  const cursor = step.resumeSessionAt;
  if (cursor === null) {
    return yield* refused(
      providerThread,
      "Nothing precedes that step in Claude's transcript; rewind to the message instead.",
    );
  }
  // The cut turn, and any after it in the same run, now end at the cursor: a later rewind or
  // fork to them must not bring the cut steps back.
  const cutTurn =
    providerThreadTurns.find((turn) => turn.id === cut.item.providerTurnId) ?? target.providerTurn;
  return {
    providerThread: {
      ...idle,
      nativeConversationHeadRef: cursorRef(cursor),
      lastRunOrdinal: target.appRunOrdinal,
    },
    messages: [],
    runtimeRequests: [],
    cutFromOrdinal: step.ordinal,
    providerTurns: providerThreadTurns
      .filter(
        (turn) => turn.providerThreadId === providerThread.id && turn.ordinal >= cutTurn.ordinal,
      )
      .map((turn) => ({ ...turn, nativeTurnRef: cursorRef(cursor) })),
  } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
});
