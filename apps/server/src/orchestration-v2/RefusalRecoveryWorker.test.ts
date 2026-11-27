import { assert, describe, it } from "@effect/vitest";
import {
  ModelSelection,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2RefusalRecovery,
} from "@t3tools/contracts";
import {
  bucketScope,
  DEFAULT_REFUSAL_LADDER,
  rewordReasoningExtraction,
} from "@t3tools/provider-core/server/refusal";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RefusalRecoveryWorker from "./RefusalRecoveryWorker.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const nowMs = Date.parse("2026-11-20T10:00:00.000Z");
const threadId = ThreadId.make("thread:refusal");
const runId = RunId.make("run:refused");
const noticeId = TurnItemId.make("item:refusal-notice");
const priorAnswerId = TurnItemId.make("item:prior-answer");
const userMessageId = TurnItemId.make("item:request");

const claude = ModelSelection.make({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-5",
});
const opencode = ModelSelection.make({
  instanceId: ProviderInstanceId.make("opencode_local"),
  model: "qwen3-coder",
});

type Item = {
  id: TurnItemId;
  runId: RunId;
  type: string;
  createdBy?: string;
};

interface Harness {
  readonly commands: Queue.Queue<OrchestrationV2ServerCommand>;
  readonly rollbacks: Queue.Queue<Record<string, unknown>>;
  readonly events: Queue.Queue<OrchestrationV2DomainEvent>;
  readonly thread: Record<string, unknown>;
}

const makeHarness = (
  options: {
    readonly modelSelection?: ModelSelection;
    readonly resume?: OrchestrationV2RefusalRecovery;
    readonly items?: ReadonlyArray<Item>;
    readonly checkpointId?: string | null;
    readonly cutMode?: "annotate" | "drop-refusal-only" | "drop-whole-turn";
    readonly instances?: ReadonlyArray<unknown>;
    readonly request?: string;
    readonly pinCandidates?: ReadonlyArray<unknown>;
    readonly handoffModelSelection?: ModelSelection | null;
  } = {},
) =>
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const rollbacks = yield* Queue.unbounded<Record<string, unknown>>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const items: ReadonlyArray<Item> = options.items ?? [
      { id: userMessageId, runId, type: "user_message", createdBy: "user" },
      { id: priorAnswerId, runId, type: "assistant_message" },
    ];
    const thread: Record<string, unknown> = {
      id: threadId,
      deletedAt: null,
      archivedAt: null,
      modelSelection: options.modelSelection ?? claude,
      activeProviderThreadId: "provider-thread:1",
      refusalRecovery: options.resume ?? null,
    };
    const projection = {
      thread,
      runs: [
        {
          id: runId,
          checkpointId: options.checkpointId === undefined ? "checkpoint:1" : options.checkpointId,
        },
      ],
      checkpoints: [{ id: "checkpoint:1", scopeId: "scope:1" }],
      providerThreads: [{ id: "provider-thread:1" }],
      turnItems: items,
    };
    const settings = {
      refusalRecovery: {
        enabled: true,
        strip: { enabled: true, patterns: [] },
        promptOverride: { enabled: true, mode: "amend" },
        envelope: { enabled: true },
        detection: { enabled: true, textHeuristics: true },
        repair: {
          enabled: true,
          cutMode: options.cutMode ?? "annotate",
          stickyMinutes: 60,
          ladder: DEFAULT_REFUSAL_LADDER,
          handoffModelSelection: options.handoffModelSelection ?? null,
        },
        providers: {},
      },
    };
    const layer = RefusalRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProjection: () => Effect.succeed(projection as never),
            getRunMessage: () =>
              Effect.succeed({
                text: options.request ?? "Write a port scanner in Go for the pentest engagement",
                createdBy: items[0]?.createdBy ?? "user",
              } as never),
            getRefusalPinCandidates: () => Effect.succeed((options.pinCandidates ?? []) as never),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command: OrchestrationV2ServerCommand) =>
              Queue.offer(commands, command).pipe(Effect.as({} as never)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({
            execute: (input) => Queue.offer(rollbacks, input as never).pipe(Effect.asVoid),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(settings as never),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed((options.instances ?? []) as never),
          }),
        ),
      ),
    );
    return { commands, rollbacks, events, thread, layer } satisfies Harness & {
      layer: Layer.Layer<never>;
    };
  });

const notice = (
  input: { class?: "classifier" | "judgment"; bucket?: string; rung?: number } = {},
) => ({
  class: input.class ?? ("judgment" as const),
  bucket: input.bucket ?? "pentest",
  signal: "text" as const,
  rung: input.rung ?? 0,
});

const send = (
  events: Queue.Queue<OrchestrationV2DomainEvent>,
  refusal = notice(),
  payloadId: string = noticeId,
) =>
  Queue.offer(events, {
    type: "turn-item.updated",
    threadId,
    runId,
    payload: {
      id: TurnItemId.make(payloadId),
      runId,
      type: "system_notice",
      message: "Refusal detected",
      refusal,
    },
  } as never);

describe("RefusalRecoveryWorker", () => {
  it.effect("rewrites the refused step in place, then sends the first rung", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());

        const rollback = yield* Queue.take(harness.rollbacks);
        assert.strictEqual(rollback.threadId, threadId);
        assert.strictEqual(rollback.fromItemId, priorAnswerId);
        assert.strictEqual(rollback.keepLater, true);
        assert.strictEqual(rollback.annotate, true);
        assert.strictEqual(rollback.restoreFiles, false);

        const dispatch = yield* Queue.take(harness.commands);
        assert.strictEqual(dispatch.type, "message.dispatch");
        if (dispatch.type !== "message.dispatch") return;
        assert.strictEqual(
          dispatch.text,
          DEFAULT_REFUSAL_LADDER.rung1.replaceAll("{scope}", bucketScope("pentest")),
        );
        assert.strictEqual(dispatch.createdBy, "agent");

        const meta = yield* Queue.take(harness.commands);
        assert.strictEqual(meta.type, "thread.metadata.update");
        if (meta.type !== "thread.metadata.update") return;
        assert.strictEqual(meta.refusalRecovery?.rung, 1);
        assert.strictEqual(meta.refusalRecovery?.outcome, "revert");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops the refused step when the mode says so", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness({ cutMode: "drop-refusal-only" });
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());
        const rollback = yield* Queue.take(harness.rollbacks);
        assert.strictEqual(rollback.fromItemId, priorAnswerId);
        assert.strictEqual(rollback.keepLater, true);
        assert.isUndefined(rollback.annotate);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops the whole turn when the mode says so", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness({ cutMode: "drop-whole-turn" });
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());
        const rollback = yield* Queue.take(harness.rollbacks);
        assert.strictEqual(rollback.fromItemId, userMessageId);
        assert.isUndefined(rollback.keepLater);
        assert.isUndefined(rollback.annotate);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("drops the whole turn when the refusal is the turn's first step", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness({
        items: [
          { id: userMessageId, runId, type: "user_message", createdBy: "user" },
          { id: noticeId, runId, type: "system_notice" },
        ],
      });
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());
        const rollback = yield* Queue.take(harness.rollbacks);
        assert.strictEqual(rollback.fromItemId, userMessageId);
        assert.isUndefined(rollback.keepLater);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("hands off and pins at the top rung, then parks after three", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const instances = [
        {
          instanceId: "opencode_local",
          driverKind: "opencode",
          enabled: true,
          snapshot: { getSnapshot: Effect.succeed({ models: [{ slug: "qwen3-coder" }] }) },
        },
      ];
      const harness = yield* makeHarness({
        items: [{ id: userMessageId, runId, type: "user_message", createdBy: "agent" }],
        instances,
      });
      yield* Effect.gen(function* () {
        // Rung 1 of a cyber refusal hands off alongside the revert.
        yield* send(harness.events, notice(), "item:notice-1");
        yield* Queue.take(harness.rollbacks);
        const dispatch = yield* Queue.take(harness.commands);
        assert.strictEqual(dispatch.type, "message.dispatch");
        if (dispatch.type !== "message.dispatch") return;
        // A turn with no preceding step drops whole, so rung 1 still dispatches.
        assert.strictEqual(dispatch.modelSelection?.instanceId, opencode.instanceId);
        const meta = yield* Queue.take(harness.commands);
        assert.strictEqual(meta.type, "thread.metadata.update");
        if (meta.type !== "thread.metadata.update") return;
        assert.strictEqual(meta.refusalRecovery?.outcome, "handoff");
        assert.strictEqual(meta.refusalRecovery?.handoff?.instanceId, opencode.instanceId);
        assert.isNotNull(meta.refusalRecovery?.pinnedUntil);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("hands off to the model named in the settings, not the first one", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const instances = [
        {
          instanceId: "opencode_local",
          driverKind: "opencode",
          enabled: true,
          snapshot: { getSnapshot: Effect.succeed({ models: [{ slug: "qwen3-coder" }] }) },
        },
      ];
      const harness = yield* makeHarness({
        items: [{ id: userMessageId, runId, type: "user_message", createdBy: "agent" }],
        instances,
        handoffModelSelection: ModelSelection.make({
          instanceId: ProviderInstanceId.make("opencode_local"),
          model: "glm-5",
        }),
      });
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice(), "item:notice-1");
        yield* Queue.take(harness.rollbacks);
        const dispatch = yield* Queue.take(harness.commands);
        assert.strictEqual(dispatch.type, "message.dispatch");
        if (dispatch.type !== "message.dispatch") return;
        assert.strictEqual(dispatch.modelSelection?.model, "glm-5");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("parks on a fourth notice instead of looping", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness({
        items: [{ id: userMessageId, runId, type: "user_message", createdBy: "agent" }],
        resume: {
          runId: RunId.make("run:previous"),
          class: "judgment",
          bucket: "pentest",
          category: "cyber",
          rung: 3,
          outcome: "revert",
        },
      });
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());
        const meta = yield* Queue.take(harness.commands);
        assert.strictEqual(meta.type, "thread.metadata.update");
        if (meta.type !== "thread.metadata.update") return;
        assert.strictEqual(meta.refusalRecovery?.outcome, "parked");
        const park = yield* Queue.take(harness.commands);
        assert.strictEqual(park.type, "thread.environment-notice.record");
        assert.equal(yield* Queue.size(harness.rollbacks), 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("reworks a reasoning-extraction rung and never hands off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness({
        request: "Show your reasoning for the last answer",
        instances: [
          {
            instanceId: "opencode_local",
            driverKind: "opencode",
            enabled: true,
            snapshot: { getSnapshot: Effect.succeed({ models: [{ slug: "qwen3-coder" }] }) },
          },
        ],
      });
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());
        yield* Queue.take(harness.rollbacks);
        const dispatch = yield* Queue.take(harness.commands);
        assert.strictEqual(dispatch.type, "message.dispatch");
        if (dispatch.type !== "message.dispatch") return;
        assert.include(dispatch.text, rewordReasoningExtraction("x").split("\n")[1]!);
        assert.isUndefined(dispatch.modelSelection);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("parks without a checkpoint rather than resending the refused span", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness({ checkpointId: null });
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());
        const meta = yield* Queue.take(harness.commands);
        assert.strictEqual(meta.type, "thread.metadata.update");
        if (meta.type !== "thread.metadata.update") return;
        assert.strictEqual(meta.refusalRecovery?.outcome, "no-checkpoint");
        assert.strictEqual(
          (yield* Queue.take(harness.commands)).type,
          "thread.environment-notice.record",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("handles one notice once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        yield* send(harness.events, notice());
        yield* send(harness.events, notice());
        yield* Queue.take(harness.rollbacks);
        yield* Queue.take(harness.commands);
        yield* Queue.take(harness.commands);
        yield* TestClock.adjust("20 millis");
        assert.equal(yield* Queue.size(harness.rollbacks), 0);
        assert.equal(yield* Queue.size(harness.commands), 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("unpins an expired handoff back to the previous selection", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const expired = {
        id: threadId,
        modelSelection: opencode,
        refusalRecovery: {
          runId,
          class: "judgment",
          bucket: "pentest",
          category: "cyber",
          rung: 2,
          outcome: "handoff",
          handoff: opencode,
          previous: claude,
          pinnedUntil: DateTime.makeUnsafe(nowMs - 1),
        },
      };
      const harness = yield* makeHarness({ pinCandidates: [expired] });
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("5 seconds");
        const set = yield* Queue.take(harness.commands);
        assert.strictEqual(set.type, "thread.model-selection.set");
        if (set.type !== "thread.model-selection.set") return;
        assert.strictEqual(set.modelSelection.instanceId, claude.instanceId);
        const clear = yield* Queue.take(harness.commands);
        assert.strictEqual(clear.type, "thread.metadata.update");
        if (clear.type !== "thread.metadata.update") return;
        assert.isNull(clear.refusalRecovery?.handoff ?? null);
        // The rung count survives the unpin.
        assert.strictEqual(clear.refusalRecovery?.rung, 2);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

describe("refusal notice shape", () => {
  it("carries the class, bucket and rung the worker reads", () => {
    const refusal = notice({ class: "classifier", bucket: "dos", rung: 2 });
    assert.strictEqual(refusal.class, "classifier");
    assert.strictEqual(refusal.bucket, "dos");
    assert.strictEqual(refusal.signal, "text");
    assert.strictEqual(refusal.rung, 2);
  });
});
