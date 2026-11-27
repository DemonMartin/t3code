/**
 * Finding the model step an item belongs to in an OpenCode session, and taking one step out.
 *
 * A step is one assistant message: its reasoning, text and tool calls. A rewind reverts at that
 * message, which the adapter does itself. OpenCode has no call that removes a message from the
 * middle of a session, so a cut goes through its export and import.
 */
import { Session } from "@opencode/client/effect";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  REFUSAL_STEP_STAND_IN,
  REFUSAL_TOOL_STAND_IN,
} from "@t3tools/provider-core/server/refusal";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { OPENCODE_PROVIDER } from "../adapter.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";

type Connection = OpenCode2Client.OpenCode2Api;

/**
 * The message that holds an item, with the ordinal of the first row the message produced and,
 * as `next`, of the first row of a later message. Null when the history holds none of the items
 * from it on, which is how a cut that already ran looks.
 */
export const stepBoundary = Effect.fn("OpenCode2StepCut.stepBoundary")(function* (
  client: Connection["client"],
  sessionId: string,
  providerThreadId: OrchestrationV2ProviderThread["id"],
  cut: ProviderAdapter.ProviderAdapterV2TurnCut,
) {
  const history = yield* OpenCode2Client.paginate(
    { sessionID: Session.ID.make(sessionId), order: "asc" as const, limit: 100 },
    client.message.list,
  ).pipe(Stream.runCollect);
  // A steer is the user message the adapter sent under an id made from T3's (`steerPromptId`).
  if (cut.item.type === "user_message" && cut.item.messageId !== undefined) {
    const steerId = `msg_t3_steer_${sessionId}:${cut.item.messageId}`;
    const steer = history.find((message) => message.id === steerId);
    if (steer !== undefined)
      return { messageId: steer.id, agent: false, ordinal: cut.item.ordinal };
  }
  // The native ids the adapter gives a message's items; see its `itemBase` and `ordinalOf`.
  const itemsOf = (message: (typeof history)[number]) => {
    if (message.type !== "assistant") return [message.id];
    const counts = { text: 0, reasoning: 0 };
    return message.content.map((part) =>
      part.type === "tool" ? part.id : `${message.id}:${part.type}:${counts[part.type]++}`,
    );
  };
  const messageOf = new Map<string, (typeof history)[number]>();
  for (const message of history) {
    for (const nativeId of itemsOf(message)) messageOf.set(nativeId, message);
  }
  // T3's own rows (notices, stop requests) have no message; the next agent item stands in.
  for (const item of cut.items) {
    if (
      item.ordinal < cut.item.ordinal ||
      item.nativeItemId === null ||
      (item.providerThreadId !== null && item.providerThreadId !== providerThreadId)
    )
      continue;
    const message = messageOf.get(item.nativeItemId);
    if (message === undefined) continue;
    const step = new Set(itemsOf(message));
    const ordinals = cut.items.flatMap((candidate) =>
      candidate.nativeItemId !== null && step.has(candidate.nativeItemId)
        ? [candidate.ordinal]
        : [],
    );
    const last = Math.max(cut.item.ordinal, ...ordinals);
    // The first row of a later message: where the history picks up when only the step goes.
    const later = cut.items.flatMap((candidate) => {
      const owner =
        candidate.nativeItemId === null ? undefined : messageOf.get(candidate.nativeItemId);
      return candidate.ordinal > last && owner !== undefined && owner.id !== message.id
        ? [candidate.ordinal]
        : [];
    });
    return {
      messageId: message.id,
      agent: message.type === "assistant",
      ordinal: Math.min(cut.item.ordinal, ...ordinals),
      ...(later.length === 0 ? {} : { next: Math.min(...later) }),
    };
  }
  return null;
});

/**
 * Writes the session back under its own id with one message changed, so every other id T3 holds
 * stays good. Deleting a session deletes its subagents' sessions, so they go back in after it.
 */
const rewriteMessage = Effect.fn("OpenCode2StepCut.rewriteMessage")(function* (
  connection: Connection,
  sessionId: string,
  directory: string,
  messageId: string,
  rewrite: (
    message: OpenCode2Client.OpenCode2Transcript["messages"][number],
  ) => OpenCode2Client.OpenCode2Transcript["messages"][number] | undefined,
) {
  const { client, transcript: transcripts } = connection;
  if (transcripts === undefined) {
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver: OPENCODE_PROVIDER,
      detail: "This OpenCode server cannot rewrite a session's history.",
    });
  }
  const descendants: Array<string> = [];
  for (let index = -1; index < descendants.length; index++) {
    const parent = index === -1 ? sessionId : descendants[index]!;
    type Page = Effect.Success<ReturnType<typeof client.session.list>>;
    let page: Parameters<typeof client.session.list>[0] = {
      parentID: Session.ID.make(parent),
      limit: 100,
    };
    while (page !== undefined) {
      const children: Page = yield* client.session.list(page);
      descendants.push(...children.data.map((child) => String(child.id)));
      // Later pages take the cursor alone.
      page =
        children.data.length === 0 || children.cursor.next === undefined
          ? undefined
          : { cursor: children.cursor.next };
    }
  }
  const original = yield* transcripts.read(sessionId);
  const saved = yield* Effect.forEach(descendants, transcripts.read);
  const read = (source: unknown, key: string): unknown =>
    typeof source === "object" && source !== null ? Reflect.get(source, key) : undefined;
  const directoryOf = (transcript: OpenCode2Client.OpenCode2Transcript) => {
    const own = read(read(transcript.info, "location"), "directory");
    return typeof own === "string" ? own : directory;
  };
  yield* client.session.remove({ sessionID: Session.ID.make(sessionId) });
  yield* transcripts
    .write(
      {
        ...original,
        messages: original.messages.flatMap((message) => {
          if (message.id !== messageId) return [message];
          const rewritten = rewrite(message);
          return rewritten === undefined ? [] : [rewritten];
        }),
      },
      directoryOf(original),
    )
    .pipe(
      // A session that would not go back in edited goes back in as it was.
      Effect.tapError(() =>
        transcripts.write(original, directoryOf(original)).pipe(Effect.ignore({ log: true })),
      ),
      Effect.ensuring(
        // Parents first, as the import asks; `descendants` is in that order.
        Effect.forEach(
          saved,
          (child) =>
            transcripts.write(child, directoryOf(child)).pipe(Effect.ignore({ log: true })),
          { discard: true },
        ),
      ),
    );
});

/** Takes one message out of the history. */
export const removeMessage = Effect.fn("OpenCode2StepCut.removeMessage")(function* (
  connection: Connection,
  sessionId: string,
  directory: string,
  messageId: string,
) {
  yield* rewriteMessage(connection, sessionId, directory, messageId, () => undefined);
});

/**
 * Keeps one message but rewrites it into a step that was refused: its reasoning goes, its prose
 * becomes a stand-in note and its finished tool calls become errors, so the model reads an
 * attempt that failed and continues differently. Reasoning cannot be edited in place, so it is
 * dropped rather than kept with stale text.
 */
export const annotateMessage = Effect.fn("OpenCode2StepCut.annotateMessage")(function* (
  connection: Connection,
  sessionId: string,
  directory: string,
  messageId: string,
) {
  yield* rewriteMessage(connection, sessionId, directory, messageId, (message) => {
    const content = Array.isArray(Reflect.get(message, "content"))
      ? (Reflect.get(message, "content") as ReadonlyArray<unknown>)
      : [];
    const partType = (part: unknown) =>
      typeof part === "object" && part !== null ? Reflect.get(part, "type") : undefined;
    const rewritten: Array<unknown> = [];
    let noted = false;
    for (const part of content) {
      const type = partType(part);
      if (type === "reasoning") continue;
      if (type === "text") {
        if (!noted) {
          rewritten.push({ type: "text", text: REFUSAL_STEP_STAND_IN });
          noted = true;
        }
        continue;
      }
      if (type === "tool" && typeof part === "object" && part !== null) {
        const state = Reflect.get(part, "state");
        const status =
          typeof state === "object" && state !== null ? Reflect.get(state, "status") : undefined;
        // A call that finished becomes an error; one still running is left as it is.
        if (status === "completed" || status === "error") {
          // The output goes with the call's status: an error may still carry `content`, and
          // what the refused step read must not stay in the conversation.
          const { content: _output, ...rest } = state as Record<string, unknown>;
          rewritten.push({
            ...part,
            state: {
              ...rest,
              status: "error",
              error: { type: "refusal", message: REFUSAL_TOOL_STAND_IN },
            },
          });
          continue;
        }
      }
      rewritten.push(part);
    }
    if (!noted) rewritten.push({ type: "text", text: REFUSAL_STEP_STAND_IN });
    return { ...message, content: rewritten };
  });
});
