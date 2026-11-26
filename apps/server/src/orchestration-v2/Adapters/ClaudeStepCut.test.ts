import { ProviderThreadId, TurnItemId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { claudeStepCut, claudeTranscriptWithoutStep } from "./ClaudeStepCut.ts";

describe("a cut at a step", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:cut");
  const block = (uuid: string, response: string, content: unknown) => ({
    uuid,
    type: "assistant",
    message: { id: response, content: [content] },
  });
  const result = (uuid: string, toolUseId: string) => ({
    uuid,
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  });
  const transcript = [
    { uuid: "prompt", type: "user", message: { content: "go" } },
    block("think-1", "response-1", { type: "thinking", thinking: "first" }),
    block("call-1", "response-1", { type: "tool_use", id: "tool-1", name: "Bash", input: {} }),
    result("result-1", "tool-1"),
    block("think-2", "response-2", { type: "thinking", thinking: "second" }),
    block("call-2", "response-2", { type: "tool_use", id: "tool-2", name: "Bash", input: {} }),
    result("result-2", "tool-2"),
    block("reply", "response-3", { type: "text", text: "done" }),
  ];
  const item = (
    ordinal: number,
    nativeItemId: string | null,
    thread: typeof providerThreadId | null = providerThreadId,
  ) => ({
    id: TurnItemId.make(`item:${ordinal}`),
    ordinal,
    type: "dynamic_tool" as const,
    providerThreadId: thread,
    providerTurnId: null,
    nativeItemId,
  });
  const items = [
    item(1, "think-1:thinking:0"),
    item(2, "tool-1"),
    item(3, "response-2:thinking:0"),
    item(4, "tool-2"),
    item(5, null, null),
    item(6, "reply"),
  ];
  const cutAt = (ordinal: number) =>
    claudeStepCut(
      transcript,
      { item: items.find((candidate) => candidate.ordinal === ordinal)!, items },
      providerThreadId,
    );

  it("drops the whole response a tool call came in, thinking included", () => {
    assert.deepEqual(cutAt(4), { resumeSessionAt: "result-1", ordinal: 3 });
  });

  it("keeps the user's prompt when the first step is cut", () => {
    assert.deepEqual(cutAt(2), { resumeSessionAt: "prompt", ordinal: 1 });
  });

  it("cuts at streamed thinking by the response it belongs to", () => {
    assert.deepEqual(cutAt(3), { resumeSessionAt: "result-1", ordinal: 3 });
  });

  it("uses the next agent item for a row the transcript does not hold", () => {
    assert.deepEqual(cutAt(5), { resumeSessionAt: "result-2", ordinal: 5 });
  });

  it("takes a steer back out with the response that followed it", () => {
    const steered = [
      ...transcript.slice(0, 4),
      { uuid: "steer", type: "user", message: { content: [{ type: "text", text: "wait" }] } },
      ...transcript.slice(4),
    ];
    const steer = {
      ...item(3, null, providerThreadId),
      ordinal: 2.5,
      type: "user_message" as const,
      messageId: "message-steer",
    };
    assert.deepEqual(
      claudeStepCut(
        steered,
        { item: steer, items: [...items.slice(0, 2), steer, ...items.slice(2)] },
        providerThreadId,
      ),
      { resumeSessionAt: "result-1", ordinal: 2.5 },
    );
  });

  it("finds nothing once the transcript holds none of the items", () => {
    assert.isNull(
      claudeStepCut(transcript.slice(0, 4), { item: items[5]!, items }, providerThreadId),
    );
  });
});

describe("one step cut out of a transcript", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:cut");
  const line = (
    uuid: string,
    parentUuid: string | null,
    type: "user" | "assistant" | "attachment",
    message?: unknown,
  ) => JSON.stringify({ parentUuid, type, uuid, ...(message === undefined ? {} : { message }) });
  const block = (uuid: string, parent: string, response: string, content: unknown) =>
    line(uuid, parent, "assistant", { id: response, content: [content] });
  const result = (uuid: string, parent: string, toolUseId: string) =>
    line(uuid, parent, "user", {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    });
  const call = (id: string) => ({ type: "tool_use", id, name: "Bash", input: {} });
  const transcript = [
    JSON.stringify({ type: "mode", mode: "default" }),
    line("prompt", null, "user", { content: "go" }),
    block("call-1", "prompt", "response-1", call("tool-1")),
    result("result-1", "call-1", "tool-1"),
    block("think-2", "result-1", "response-2", { type: "thinking", thinking: "second" }),
    block("call-2a", "think-2", "response-2", call("tool-2a")),
    result("result-2a", "call-2a", "tool-2a"),
    block("call-2b", "result-2a", "response-2", call("tool-2b")),
    result("result-2b", "call-2b", "tool-2b"),
    line("note", "result-2b", "attachment"),
    block("reply", "note", "response-3", { type: "text", text: "done" }),
    JSON.stringify({ type: "last-prompt", leafUuid: "reply" }),
    "",
  ];
  const item = (ordinal: number, nativeItemId: string) => ({
    id: TurnItemId.make(`item:${ordinal}`),
    ordinal,
    type: "dynamic_tool" as const,
    providerThreadId,
    providerTurnId: null,
    nativeItemId,
  });
  const items = [
    item(1, "tool-1"),
    item(2, "response-2:thinking:0"),
    item(3, "tool-2a"),
    item(4, "tool-2b"),
    item(5, "reply"),
  ];
  const uuids = (lines: ReadonlyArray<string>) =>
    lines.flatMap((entry) => {
      const uuid = entry === "" ? undefined : (JSON.parse(entry) as { uuid?: string }).uuid;
      return uuid === undefined ? [] : [uuid];
    });
  const cutAt = (ordinal: number, lines = transcript) => {
    const edit = claudeTranscriptWithoutStep(
      lines,
      { item: items.find((candidate) => candidate.ordinal === ordinal)!, items, only: true },
      providerThreadId,
    );
    if (edit === null || edit === "not-a-step") throw new Error(`no step at ${ordinal}`);
    return edit;
  };

  it("takes the response, its tool results and nothing else", () => {
    const edit = cutAt(3);
    assert.deepEqual(uuids(edit.lines), ["prompt", "call-1", "result-1", "note", "reply"]);
    // The note that hung off the step now hangs off what came before it.
    const note = JSON.parse(edit.lines.find((entry) => entry.includes('"note"'))!);
    assert.equal(note.parentUuid, "result-1");
    // Lines the cut does not touch are the same text, and the file still ends in a newline.
    assert.equal(edit.lines[0], transcript[0]);
    assert.equal(edit.lines.at(-1), "");
    assert.deepEqual([edit.fromOrdinal, edit.toOrdinal], [2, 5]);
    assert.equal(edit.replacementOf("result-2b"), "result-1");
    assert.isUndefined(edit.replacementOf("reply"));
  });

  it("moves the recorded end of the conversation when the last step goes", () => {
    const edit = cutAt(5);
    assert.deepEqual(uuids(edit.lines).at(-1), "note");
    assert.equal(JSON.parse(edit.lines.at(-2)!).leafUuid, "note");
    assert.deepEqual([edit.fromOrdinal, edit.toOrdinal], [5, undefined]);
  });

  it("leaves the user's own message and an absent step alone", () => {
    const own = { ...items[0]!, nativeItemId: "prompt" };
    assert.equal(
      claudeTranscriptWithoutStep(
        transcript,
        { item: own, items: [own], only: true },
        providerThreadId,
      ),
      "not-a-step",
    );
    // Cut twice: the second time there is nothing left to take.
    assert.isNull(
      claudeTranscriptWithoutStep(
        cutAt(5).lines,
        { item: items[4]!, items: [items[4]!], only: true },
        providerThreadId,
      ),
    );
  });
});
