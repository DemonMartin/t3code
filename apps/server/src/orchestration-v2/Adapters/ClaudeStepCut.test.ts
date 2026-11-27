import { ProviderThreadId, TurnItemId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  REFUSAL_STEP_STAND_IN,
  REFUSAL_TOOL_STAND_IN,
} from "@t3tools/provider-core/server/refusal";
import {
  claudeStepCut,
  claudeTranscriptAnnotated,
  claudeTranscriptWithoutStep,
} from "./ClaudeStepCut.ts";

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

  describe("a step rewritten in place", () => {
    const parsed = (lines: ReadonlyArray<string>) =>
      lines.flatMap((entry) => (entry.trim().length === 0 ? [] : [JSON.parse(entry)]));
    const annotateAt = (ordinal: number, lines = transcript) => {
      const edit = claudeTranscriptAnnotated(
        lines,
        { item: items.find((candidate) => candidate.ordinal === ordinal)!, items, annotate: true },
        providerThreadId,
      );
      if (edit === null || edit === "not-a-step") throw new Error(`no step at ${ordinal}`);
      return edit;
    };

    it("keeps the step, drops its thinking and marks its tool results as errors", () => {
      const edit = annotateAt(3);
      // Nothing leaves, so every link and the recorded end still point at what they did.
      assert.deepEqual(uuids(edit.lines), uuids(transcript));
      assert.equal(JSON.parse(edit.lines.at(-2)!).leafUuid, "reply");
      const entries = parsed(edit.lines);
      const blocksOf = (entry: { message?: { content?: unknown } }) =>
        (entry.message?.content ?? []) as ReadonlyArray<Record<string, unknown>>;

      // The response keeps its tool calls and loses the thinking that led to them.
      const step = entries.filter((entry) => entry.message?.id === "response-2");
      assert.deepEqual(
        step.flatMap(blocksOf).map((block) => block.type),
        ["text", "tool_use", "tool_use"],
      );
      assert.equal(blocksOf(step[0]!)[0]!.text, REFUSAL_STEP_STAND_IN);
      assert.deepEqual(
        step.flatMap(blocksOf).flatMap((block) => (block.type === "tool_use" ? [block.id] : [])),
        ["tool-2a", "tool-2b"],
      );

      // Its results read as calls that errored, under the same tool_use ids.
      const results = entries.filter(
        (entry) => entry.uuid === "result-2a" || entry.uuid === "result-2b",
      );
      assert.deepEqual(
        results.map((entry) => blocksOf(entry)[0]!.tool_use_id),
        ["tool-2a", "tool-2b"],
      );
      for (const entry of results) {
        assert.deepEqual(blocksOf(entry)[0]!.content, REFUSAL_TOOL_STAND_IN);
        assert.isTrue(blocksOf(entry)[0]!.is_error);
      }

      // The text of a step that only answered becomes the stand-in and nothing else.
      const replied = annotateAt(5);
      const reply = parsed(replied.lines).find((entry) => entry.uuid === "reply");
      assert.deepEqual(
        blocksOf(reply!).map((block) => [block.type, block.text]),
        [["text", REFUSAL_STEP_STAND_IN]],
      );
    });

    it("rewrites the refused response T3 never showed, not the answered step before it", () => {
      // Claude's refused response is thinking only: no row of its own, so the caller names the
      // step before it. That step was answered and stays; the refused response is rewritten.
      const refused = [
        ...transcript.slice(0, -2),
        line("refused", "reply", "assistant", {
          id: "response-4",
          stop_reason: "refusal",
          content: [{ type: "thinking", thinking: "refused" }],
        }),
        JSON.stringify({ type: "last-prompt", leafUuid: "refused" }),
        "",
      ];
      const edit = annotateAt(5, refused);
      const entries = parsed(edit.lines);
      const contentOf = (uuid: string) =>
        entries.find((entry) => entry.uuid === uuid)?.message?.content as ReadonlyArray<
          Record<string, unknown>
        >;
      assert.deepEqual(contentOf("reply"), [{ type: "text", text: "done" }]);
      assert.deepEqual(contentOf("refused"), [{ type: "text", text: REFUSAL_STEP_STAND_IN }]);
    });

    it("leaves the user's own message and an absent step alone", () => {
      const own = { ...items[0]!, nativeItemId: "prompt" };
      assert.equal(
        claudeTranscriptAnnotated(
          transcript,
          { item: own, items: [own], annotate: true },
          providerThreadId,
        ),
        "not-a-step",
      );
      const edit = annotateAt(5);
      assert.isNull(
        claudeTranscriptAnnotated(
          edit.lines.filter((line) => !line.includes('"response-3"')),
          { item: items[4]!, items: [items[4]!], annotate: true },
          providerThreadId,
        ),
      );
    });
  });
});
