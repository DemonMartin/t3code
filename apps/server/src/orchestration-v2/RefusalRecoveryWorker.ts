import {
  CommandId,
  MessageId,
  ModelSelection,
  ProviderInstanceId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2RefusalNotice,
  type OrchestrationV2RefusalRecovery,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  detectRefusalCategory,
  planRefusalRepair,
  type RefusalBucket,
  refusalLogLine,
  refusalProviderForInstance,
  rewordReasoningExtraction,
} from "@t3tools/provider-core/server/refusal";
import { forkParked } from "../serverActivation.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** The notice a stopped repair leaves, so the thread does not retry the same refusal. */
const PARKED_NOTICE =
  "Refusal recovery stopped; the refused turn could not be repaired. Switch the provider to continue.";

/** Whether a run is still live; the notice is written before the turn settles. */
const waitForQuiet = (
  projections: ProjectionStore.ProjectionStoreV2["Service"],
  threadId: Parameters<ProjectionStore.ProjectionStoreV2["Service"]["getThreadProjection"]>[0],
) =>
  projections.getThreadProjection(threadId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("150 millis"),
      until: (projection) =>
        projection.runs.every(
          (run) => !ThreadManagement.ACTIVE_RUN_STATUSES.some((status) => status === run.status),
        ),
      times: 60,
    }),
  );

/**
 * The other provider, or the configured selection. The handoff exists to reach an uncensored
 * model, so an enabled OpenCode instance and its first model fill in first; any other provider
 * kind is the fallback.
 */
const handoffSelection = Effect.fnUntraced(function* (input: {
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly instances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
  readonly from: ModelSelection;
}) {
  const preferences = (yield* input.settings.getSettings).refusalRecovery;
  if (preferences.repair.handoffModelSelection !== null) {
    return preferences.repair.handoffModelSelection;
  }
  const fromKind = refusalProviderForInstance(input.from.instanceId);
  const enabled = (yield* input.instances.listInstances).filter((instance) => instance.enabled);
  for (const kind of ["opencode", "claude"] as const) {
    if (kind === fromKind) continue;
    for (const candidate of enabled) {
      if (refusalProviderForInstance(candidate.instanceId) !== kind) continue;
      const snapshot = yield* candidate.snapshot.getSnapshot.pipe(Effect.option);
      const model = Option.getOrUndefined(snapshot)?.models?.[0];
      if (model === undefined) continue;
      return ModelSelection.make({
        instanceId: ProviderInstanceId.make(candidate.instanceId),
        model: model.slug,
      });
    }
  }
  return null;
});

/**
 * Layer 5: repair the refused step and steer the next turn. The step's text and thinking become
 * a stand-in and its tool results errors, so the model reads a failed attempt instead of the same
 * request again; then one ladder rung is sent. The top rung hands off to the other provider and
 * pins the thread; after the third the thread parks.
 */
const makeWorker = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const rollback = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;

  // Notices are replayed on restart; the same item is handled once per process.
  const handled = new Set<string>();

  const repair = Effect.fn("RefusalRecoveryWorker.repair")(function* (
    threadId: Parameters<ProjectionStore.ProjectionStoreV2["Service"]["getThreadProjection"]>[0],
    runId: string,
    itemId: string,
    notice: OrchestrationV2RefusalNotice,
  ) {
    const key = `${threadId}:${itemId}`;
    if (handled.has(key)) return;
    handled.add(key);

    const preferences = (yield* settings.getSettings).refusalRecovery;
    if (!preferences.enabled || !preferences.repair.enabled) return;
    const quiet = yield* waitForQuiet(projections, threadId);
    const thread = quiet.thread;
    if (thread.deletedAt !== null || thread.archivedAt !== null) return;
    const provider = refusalProviderForInstance(thread.modelSelection.instanceId);
    if (provider === null || preferences.providers[provider]?.repair === false) return;

    const run = quiet.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) return;
    const message = yield* projections.getRunMessage(threadId, run.id);
    const request = message?.text ?? "";
    const resume = thread.refusalRecovery;
    // The ladder continues on our own rung runs and on a handoff target; a new user turn starts
    // it again. Carrying across a handoff matters, or a refused handoff would restart and loop.
    const carries =
      resume != null &&
      (message?.createdBy === "agent" ||
        resume.runId === runId ||
        (resume.handoff != null && thread.modelSelection.instanceId === resume.handoff.instanceId));
    const rungsUsed = carries ? resume.rung : 0;
    // The contract keeps the bucket a plain string; ours is the only writer, from the core list.
    const bucket = notice.bucket as RefusalBucket | null;
    const category = detectRefusalCategory(request);
    const plan = planRefusalRepair({
      class: notice.class,
      bucket,
      category,
      rungsUsed,
      request,
      ladder: preferences.repair.ladder,
    });
    const now = yield* DateTime.now;
    const record = (
      next: Partial<OrchestrationV2RefusalRecovery>,
    ): OrchestrationV2RefusalRecovery => ({
      ...resume,
      runId: run.id,
      class: notice.class,
      bucket: notice.bucket,
      category,
      rung: rungsUsed,
      outcome: "detected",
      ...(carries ? {} : { handoff: null, previous: null, pinnedUntil: null }),
      ...next,
    });
    const setThread = (next: Partial<OrchestrationV2RefusalRecovery>) =>
      threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`refusal-record:${key}`),
        threadId,
        refusalRecovery: record(next),
      });
    const park = Effect.fn("RefusalRecoveryWorker.park")(function* (
      next: Partial<OrchestrationV2RefusalRecovery>,
    ) {
      yield* setThread({ ...next, parkedAt: now });
      yield* threads
        .dispatch({
          type: "thread.environment-notice.record",
          commandId: CommandId.make(`refusal-park:${key}`),
          threadId,
          text: PARKED_NOTICE,
          refusalParked: true,
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("refusal park notice failed", cause)));
    });

    if (plan === null) {
      yield* Effect.logInfo(
        refusalLogLine({
          provider,
          class: notice.class,
          bucket,
          rung: rungsUsed,
          model: thread.modelSelection.model,
          outcome: "parked",
        }),
      );
      yield* park({ rung: 3, outcome: "parked" });
      return;
    }

    // The revert needs the refused run's own checkpoint; without one, park rather than send the
    // refused span back to the model.
    const checkpoint =
      run.checkpointId === null
        ? undefined
        : quiet.checkpoints.find((candidate) => candidate.id === run.checkpointId);
    const providerThreadId = quiet.providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    )?.id;
    const items = quiet.turnItems.filter((item) => item.runId === run.id);
    // The configured mode is the default. A turn with no step before the notice has nothing to
    // keep, so it drops whole; the notice's own message must not count as the kept step.
    const noticeIndex = items.findIndex((item) => item.id === itemId);
    const beforeNotice = noticeIndex === -1 ? items : items.slice(0, noticeIndex);
    const priorAnswer = beforeNotice.findLast((item) => item.type === "assistant_message")?.id;
    const cutMode =
      preferences.repair.cutMode !== "drop-whole-turn" && priorAnswer !== undefined
        ? preferences.repair.cutMode
        : "drop-whole-turn";
    const fromItemId =
      cutMode === "drop-whole-turn"
        ? items.find((item) => item.type === "user_message")?.id
        : priorAnswer;
    if (checkpoint === undefined || providerThreadId === undefined || fromItemId === undefined) {
      yield* Effect.logWarning("refusal recovery has no checkpoint to revert to", {
        threadId,
        runId: run.id,
      });
      yield* park({ outcome: "no-checkpoint" });
      return;
    }

    const target = plan.handoff
      ? yield* handoffSelection({ settings, instances, from: thread.modelSelection })
      : null;
    const handoff = target !== null && target.instanceId !== thread.modelSelection.instanceId;

    yield* Effect.logInfo(
      refusalLogLine({
        provider,
        class: notice.class,
        bucket,
        rung: plan.rung,
        model: thread.modelSelection.model,
        outcome: handoff ? "handoff" : "revert",
      }),
    );

    yield* rollback.execute({
      threadId,
      providerThreadId,
      checkpointId: checkpoint.id,
      scopeId: checkpoint.scopeId,
      restoreFiles: false,
      requestId: CommandId.make(`refusal-revert:${key}`),
      fromItemId: TurnItemId.make(fromItemId),
      ...(cutMode === "drop-whole-turn" ? {} : { keepLater: true }),
      ...(cutMode === "annotate" ? { annotate: true } : {}),
    });

    // Reasoning extraction never hands off; it drops the trace request and asks for the answer only.
    const rungText = plan.reword ? rewordReasoningExtraction(plan.text) : plan.text;
    const dispatch: OrchestrationV2Command = {
      type: "message.dispatch",
      commandId: CommandId.make(`refusal-rung-${plan.rung}:${key}`),
      threadId,
      messageId: MessageId.make(`refusal-rung-${plan.rung}:${key}`),
      text: rungText,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
      ...(handoff && target !== null ? { modelSelection: target } : {}),
    };
    yield* threads.dispatch(dispatch);

    const stickyMs = preferences.repair.stickyMinutes * 60_000;
    yield* setThread({
      rung: plan.rung,
      outcome: handoff ? "handoff" : "revert",
      parkedAt: null,
      ...(handoff && target !== null
        ? {
            handoff: target,
            previous: thread.modelSelection,
            pinnedUntil: DateTime.makeUnsafe(DateTime.toEpochMillis(now) + stickyMs),
          }
        : {}),
    });
  });

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      if (event.type !== "turn-item.updated") return Effect.void;
      const { payload } = event;
      if (payload.type !== "system_notice" || payload.refusal === undefined) return Effect.void;
      const notice = payload.refusal;
      if (payload.runId === null) return Effect.void;
      return repair(event.threadId, payload.runId, payload.id, notice).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("refusal recovery failed", { threadId: event.threadId, cause }),
        ),
      );
    }),
  );

  /** Pins expire: go back to the selection the handoff replaced, once it is still the pinned one. */
  const expirePins = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const candidates = yield* projections.getRefusalPinCandidates(now);
    for (const thread of candidates) {
      const recovery = thread.refusalRecovery;
      if (recovery?.previous == null || recovery.handoff == null) continue;
      if (thread.modelSelection.instanceId !== recovery.handoff.instanceId) continue;
      yield* threads
        .dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`refusal-unpin:${thread.id}:${recovery.runId}`),
          threadId: thread.id,
          modelSelection: recovery.previous,
        })
        .pipe(
          Effect.andThen(
            threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`refusal-unpin-meta:${thread.id}:${recovery.runId}`),
              threadId: thread.id,
              refusalRecovery: { ...recovery, handoff: null, pinnedUntil: null },
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("refusal pin expiry failed", { threadId: thread.id, cause }),
          ),
        );
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("refusal pin sweep failed", cause)));

  return expirePins;
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const expirePins = yield* makeWorker;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("refusal-pin-expiry", expirePins);
  }),
);
