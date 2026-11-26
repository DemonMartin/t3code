import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  EventId,
  isOrchestrationV2RunItemTruncated,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  CheckpointScopeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { withTurnStartReservation, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import { resolveCodexRollbackTurnCount } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { layerNoTaskFolders } from "./ProviderTurnStartService.testkit.ts";

const unrelatedProject = Option.some({
  workspaceRoot: "/nonexistent/t3-rollback-project",
} as never);
const layerCheckpointRollbackService = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      layerNoTaskFolders,
      Layer.mock(ServerConfig.ServerConfig)({ worktreesDir: "/synthetic-worktrees" } as never),
      ServerSettings.layerTest(),
      Layer.mock(GitWorkflow.GitWorkflowService)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(unrelatedProject) }),
    ),
  ),
);

it.effect.each(["initial", "waiting"])(
  "rejects a non-ready checkpoint from %s before opening a session or restoring files",
  (state) => {
    const threadId = ThreadId.make("thread:rollback-non-ready");
    const providerThreadId = ProviderThreadId.make("provider-thread:rollback-non-ready");
    const providerSessionId = ProviderSessionId.make("provider-session:rollback-non-ready");
    const checkpointId = CheckpointId.make("checkpoint:rollback-non-ready");
    const scopeId = CheckpointScopeId.make("checkpoint-scope:rollback-non-ready");
    const providerInstanceId = ProviderInstanceId.make("provider_rollback_non_ready");
    const restore = vi.fn(() => Effect.die("checkpoint restore must not run"));
    const open = vi.fn(() => Effect.die("provider session open must not run"));
    const resolveRuntimePolicy = vi.fn(() => Effect.die("runtime policy resolution must not run"));
    const readEntered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let projection = {
      thread: {
        worktreePath: process.cwd(),
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
        deletedAt: null,
      },
      providerThread: { id: providerThreadId, providerSessionId, providerInstanceId },
      checkpoint: {
        id: checkpointId,
        scopeId,
        status: state === "waiting" ? "ready" : "stale",
        appRunOrdinal: 0,
      },
      scope: { id: scopeId, cwd: process.cwd() },
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const getThread = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThread"]>(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(projection.thread)),
    );
    const getCheckpointRollbackContext = vi.fn(() => Effect.succeed(projection));
    const testLayer = layerCheckpointRollbackService.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            restore,
            discardRepositorySnapshots: () => Effect.void,
          }),
          Layer.mock(EventSink.EventSinkV2)({}),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread,
            getCheckpointRollbackContext,
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: resolveRuntimePolicy }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const holder =
        state === "waiting"
          ? yield* withWorkspaceLease(process.cwd(), Deferred.await(release)).pipe(
              Effect.forkChild({ startImmediately: true }),
            )
          : undefined;
      const rollback = yield* service
        .execute({
          threadId,
          providerThreadId,
          checkpointId,
          scopeId,
        })
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      if (state === "waiting") {
        yield* Deferred.await(readEntered);
        projection = {
          ...projection,
          checkpoint: { ...projection.checkpoint!, status: "stale" },
        };
        yield* Deferred.succeed(release, undefined);
        if (holder !== undefined) yield* Fiber.join(holder);
      }
      const error = yield* Fiber.join(rollback);

      assert.deepEqual(getThread.mock.calls, [[threadId]]);
      assert.deepEqual(getCheckpointRollbackContext.mock.calls, [
        [
          threadId,
          {
            threadId,
            providerThreadId,
            checkpointId,
            scopeId,
          },
        ],
      ]);
      assert.equal(error.reason, "rollback-target-invalid");
      assert.equal(
        error.message,
        `Rollback target ${checkpointId} for provider thread ${providerThreadId} on thread ${threadId} is incomplete or invalid.`,
      );
      assert.equal(error.cause, undefined);
      assert.equal(resolveRuntimePolicy.mock.calls.length, 0);
      assert.equal(open.mock.calls.length, 0);
      assert.equal(restore.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  },
);

it.effect.each([
  { order: "cleanup-first", restoreFiles: true },
  { order: "rollback-first", restoreFiles: true },
  { order: "cleanup-first", restoreFiles: false, unmanaged: true },
  { order: "cleanup-first", restoreFiles: true, leavesFolder: true },
  { order: "cleanup-first", restoreFiles: false, leavesFolder: true },
  { order: "cleanup-first", restoreFiles: true, leavesFolder: true, shared: true },
  { order: "cleanup-first", restoreFiles: true, leavesFolder: true, createFails: true },
])("locks rollback with %s", (row) =>
  Effect.gen(function* () {
    const { order, restoreFiles, unmanaged, leavesFolder, shared, createFails } = row;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceRoot = yield* fileSystem.realPath(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rollback-" }),
    );
    const worktreesDir = path.join(workspaceRoot, "worktrees");
    const worktreePath = unmanaged
      ? path.join(workspaceRoot, "elsewhere", "feature")
      : path.join(worktreesDir, "repo", "feature");
    yield* fileSystem.makeDirectory(path.join(worktreePath, ".git"), { recursive: true });
    const threadId = ThreadId.make("rollback-worktree");
    const projectId = ProjectId.make("rollback-worktree-project");
    const providerThreadId = ProviderThreadId.make("rollback-worktree-provider-thread");
    const providerSessionId = ProviderSessionId.make("rollback-worktree-provider-session");
    const providerInstanceId = ProviderInstanceId.make("rollback-worktree-provider-instance");
    const checkpointId = CheckpointId.make("rollback-worktree-checkpoint");
    const scopeId = CheckpointScopeId.make("rollback-worktree-scope");
    const branch = "feature/rollback";
    const release = Deferred.makeUnsafe<void>();
    const openEntered = Deferred.makeUnsafe<void>();
    const calls: string[] = [];
    let cleanupEntered = false;
    const providerThread = { id: providerThreadId, providerSessionId, providerInstanceId };
    const projection = {
      thread: {
        id: threadId,
        projectId,
        worktreePath,
        branch,
        activeProviderThreadId: providerThreadId,
        modelSelection: { instanceId: providerInstanceId, model: "test-model" },
        deletedAt: null,
      },
      providerThread,
      providerSession: undefined,
      checkpoint: { id: checkpointId, scopeId, status: "ready", appRunOrdinal: 0 },
      scope: { id: scopeId, cwd: worktreePath },
      runsToRollback: [],
      targetAttempt: undefined,
      rolledBackAttemptIds: [],
      staleCheckpoints: [],
      staleProviderThreads: [],
      rootNodes: [],
      providerTurns: [],
    } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
    const testLayer = CheckpointRollbackService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ThreadCommandExecutor.layer,
          NodeServices.layer,
          layerNoTaskFolders,
          Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
          ServerSettings.layerTest(),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: (id) => {
              assert.equal(id, projectId);
              return Effect.succeedSome({ workspaceRoot } as never);
            },
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            pruneWorktrees: (input) =>
              Effect.sync(() => {
                assert.deepEqual(input, { cwd: workspaceRoot });
                calls.push("prune");
              }),
            createWorktree: (input) =>
              Effect.gen(function* () {
                assert.deepEqual(input, {
                  cwd: workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                });
                calls.push("create");
                if (createFails) return yield* Effect.die("the branch is gone");
                yield* fileSystem
                  .makeDirectory(path.join(worktreePath, ".git"), { recursive: true })
                  .pipe(Effect.orDie);
                return {} as never;
              }),
          }),
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            discardRepositorySnapshots: () => Effect.void,
            restore: () =>
              Effect.gen(function* () {
                assert.isTrue(
                  yield* fileSystem.exists(path.join(worktreePath, ".git")).pipe(Effect.orDie),
                );
                calls.push("files");
              }),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            write: () =>
              Effect.sync(() => {
                calls.push("projection");
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThread: () => Effect.succeed(projection.thread),
            getCheckpointRollbackContext: () => Effect.succeed(projection),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: shared
                  ? [
                      {
                        id: ThreadId.make("rollback-worktree-sharer"),
                        projectId,
                        worktreePath,
                        deletedAt: null,
                        lineage: {},
                      },
                    ]
                  : [],
                archivedThreads: [],
              } as never),
            getCheckpointContext: () => Effect.succeed({ checkpointScopes: [] } as never),
            getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            open: (input) =>
              Effect.gen(function* () {
                assert.equal(input.runtimePolicy.cwd, worktreePath);
                if (!(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie))) {
                  return yield* new ProviderWorkspaceMissingError({
                    threadId,
                    cwd: worktreePath,
                  });
                }
                calls.push("session");
                yield* Deferred.succeed(openEntered, undefined);
                if (order === "rollback-first") yield* Deferred.await(release);
                return {} as never;
              }),
          }),
          Layer.mock(RuntimePolicy.RuntimePolicyV2)({
            resolve: ({ thread }) => {
              assert.equal(thread.worktreePath, worktreePath);
              return Effect.succeed({ cwd: thread.worktreePath } as never);
            },
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
          // A failed `git worktree remove` can leave the folder without its checkout.
          if (leavesFolder) {
            yield* fileSystem.makeDirectory(worktreePath);
            yield* fileSystem.writeFileString(path.join(worktreePath, "unsaved.txt"), "keep");
          }
          calls.push("cleanup");
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const rollback = yield* service
        .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
        .pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") assert.deepEqual(calls, []);
      if (order === "rollback-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "rollback-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "rollback-first") assert.isFalse(cleanupEntered);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      if (unmanaged || shared) {
        const error = yield* Fiber.join(rollback).pipe(Effect.flip);
        assert.equal(error._tag, "CheckpointRollbackExecutionError");
        assert.deepEqual(calls, ["cleanup"]);
        if (shared) {
          assert.equal(error.reason, "shared-workspace");
          assert.isTrue(yield* fileSystem.exists(path.join(worktreePath, "unsaved.txt")));
        }
        return;
      }
      if (createFails) {
        yield* Fiber.join(rollback).pipe(Effect.exit);
        assert.deepEqual(calls, ["cleanup", "prune", "create"]);
        assert.equal(
          yield* fileSystem.readFileString(path.join(worktreePath, "unsaved.txt")),
          "keep",
        );
        assert.deepEqual(yield* fileSystem.readDirectory(path.dirname(worktreePath)), ["feature"]);
        return;
      }
      yield* Fiber.join(rollback);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      const rollbackCalls = restoreFiles
        ? ["session", "files", "projection"]
        : ["session", "projection"];
      const recreates = !leavesFolder || restoreFiles;
      assert.deepEqual(
        calls,
        order === "cleanup-first"
          ? ["cleanup", ...(recreates ? ["prune", "create"] : []), ...rollbackCalls]
          : [...rollbackCalls, "cleanup"],
      );
      if (!recreates) {
        assert.isTrue(yield* fileSystem.exists(path.join(worktreePath, "unsaved.txt")));
      }
    }).pipe(Effect.provide(testLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { restoreFiles: true, status: "ready" },
  { restoreFiles: false, status: "ready" },
  // A failed capture still pins the conversation.
  { restoreFiles: false, status: "error" },
])(
  "holds turn starts inside the worktree during rollback with restoreFiles $restoreFiles to a $status checkpoint",
  ({ restoreFiles, status }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.realPath(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rollback-reservation-" }),
      );
      const worktreesDir = path.join(workspaceRoot, "worktrees");
      const worktreePath = path.join(worktreesDir, "repo", "feature");
      yield* fileSystem.makeDirectory(path.join(worktreePath, ".git"), { recursive: true });
      const threadId = ThreadId.make("rollback-reservation");
      const providerThreadId = ProviderThreadId.make("rollback-reservation-provider-thread");
      const providerInstanceId = ProviderInstanceId.make("rollback-reservation-provider");
      const checkpointId = CheckpointId.make("rollback-reservation-checkpoint");
      const scopeId = CheckpointScopeId.make("rollback-reservation-scope");
      const release = Deferred.makeUnsafe<void>();
      const openEntered = Deferred.makeUnsafe<void>();
      const restoreEntered = Deferred.makeUnsafe<void>();
      const releaseRestore = Deferred.makeUnsafe<void>();
      const calls: string[] = [];
      const projection = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("rollback-reservation-project"),
          worktreePath,
          branch: "feature/rollback-reservation",
          activeProviderThreadId: providerThreadId,
          modelSelection: { instanceId: providerInstanceId, model: "test-model" },
          deletedAt: null,
        },
        providerThread: {
          id: providerThreadId,
          providerSessionId: ProviderSessionId.make("rollback-reservation-session"),
          providerInstanceId,
        },
        providerSession: undefined,
        checkpoint: { id: checkpointId, scopeId, status, appRunOrdinal: 0 },
        scope: { id: scopeId, cwd: worktreePath },
        runsToRollback: [],
        targetAttempt: undefined,
        rolledBackAttemptIds: [],
        staleCheckpoints: [],
        staleProviderThreads: [],
        rootNodes: [],
        providerTurns: [],
      } as unknown as ProjectionStore.ProjectionCheckpointRollbackContext;
      const testLayer = CheckpointRollbackService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ThreadCommandExecutor.layer,
            NodeServices.layer,
            Layer.mock(ServerConfig.ServerConfig)({ worktreesDir } as never),
            ServerSettings.layerTest(),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () => Effect.succeedSome({ workspaceRoot } as never),
            }),
            layerNoTaskFolders,
            Layer.mock(GitWorkflow.GitWorkflowService)({}),
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              discardRepositorySnapshots: () => Effect.void,
              restore: () =>
                Deferred.succeed(restoreEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseRestore)),
                  Effect.andThen(Effect.sync(() => calls.push("files"))),
                ),
            }),
            Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.succeed([]) }),
            IdAllocator.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThread: () => Effect.succeed(projection.thread),
              getCheckpointRollbackContext: () => Effect.succeed(projection),
              getShellSnapshot: () =>
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 0,
                  threads: [],
                  archivedThreads: [],
                }),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              open: () =>
                Deferred.succeed(openEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({} as never),
                ),
            }),
            Layer.mock(RuntimePolicy.RuntimePolicyV2)({
              resolve: () => Effect.succeed({ cwd: worktreePath } as never),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
        const rollback = yield* service
          .execute({ threadId, providerThreadId, checkpointId, scopeId, restoreFiles })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(openEntered);
        // A synchronous realPath lets the forked start reach the reservation
        // before the next assertion, so "not entered" means "waiting".
        const startTurn = withTurnStartReservation(
          FileSystem.makeNoop({ realPath: (target) => Effect.succeed(target) }),
          path,
          path.join(worktreePath, "packages", "app"),
          Effect.sync(() => calls.push("turn start")),
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const turnStart = yield* startTurn;
        if (restoreFiles) {
          assert.deepEqual(calls, []);
          yield* Deferred.succeed(release, undefined);
          // The reservation must still be held while files are being restored,
          // not only while the provider rollback is in flight.
          yield* Deferred.await(restoreEntered);
          const duringRestore = yield* startTurn;
          assert.deepEqual(calls, []);
          yield* Deferred.succeed(releaseRestore, undefined);
          yield* Fiber.join(duringRestore);
        } else {
          // Nothing is rewritten, so the turn start must not wait for the provider.
          yield* Fiber.join(turnStart);
          yield* Deferred.succeed(release, undefined);
        }
        yield* Fiber.join(rollback);
        yield* Fiber.join(turnStart);
        assert.deepEqual(
          calls,
          restoreFiles ? ["files", "turn start", "turn start"] : ["turn start"],
        );
      }).pipe(Effect.provide(testLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const seedRollbackHistory = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("rollback-history");
  const providerThreadId = ProviderThreadId.make("rollback-history-provider");
  const providerSessionId = ProviderSessionId.make("rollback-history-session");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const modelSelection = { instanceId: providerInstanceId, model: "test" };
  const scopeId = CheckpointScopeId.make("rollback-history-root");
  const otherScopeId = CheckpointScopeId.make("rollback-history-child");
  const repositoryScopeId = CheckpointScopeId.make("rollback-history-repository");
  const runId = (ordinal: number) => RunId.make(`rollback-history-run-${ordinal}`);
  const nodeId = (ordinal: number) => NodeId.make(`rollback-history-node-${ordinal}`);
  const attemptId = (ordinal: number) => RunAttemptId.make(`rollback-history-attempt-${ordinal}`);
  const turnId = (ordinal: number) => ProviderTurnId.make(`rollback-history-turn-${ordinal}`);
  const checkpointId = (ordinal: number) =>
    CheckpointId.make(`rollback-history-checkpoint-${ordinal}`);
  type EventInput<Event = OrchestrationV2DomainEvent> = Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id" | "occurredAt" | "threadId">
    : never;
  let sequence = 0;
  const apply = (event: EventInput) =>
    store.apply({
      ...event,
      id: EventId.make(`rollback-history-event-${sequence++}`),
      threadId,
      occurredAt: now,
    } as OrchestrationV2DomainEvent);
  yield* apply({
    type: "thread.created",
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("rollback-history-project"),
      title: "Rollback history",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: process.cwd(),
      activeProviderThreadId: providerThreadId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const providerThread = {
    id: providerThreadId,
    driver,
    providerInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: 1,
    lastRunOrdinal: 6,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  yield* apply({ type: "provider-thread.updated", payload: providerThread });
  for (const id of [scopeId, otherScopeId]) {
    yield* apply({
      type: "checkpoint-scope.created",
      payload: {
        id,
        threadId,
        runId: runId(1),
        nodeId: nodeId(1),
        parentScopeId: id === scopeId ? null : scopeId,
        providerThreadId,
        kind: id === scopeId ? "root_run" : "subagent",
        ordinalWithinParent: 0,
        advancesAppRunCount: id === scopeId,
        cwd: process.cwd(),
        createdAt: now,
      },
    });
  }
  const statuses = [
    "completed",
    "completed",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ] as const;
  for (const [index, status] of statuses.entries()) {
    const ordinal = index + 1;
    yield* apply({
      type: "run.created",
      payload: {
        id: runId(ordinal),
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`rollback-history-message-${ordinal}`),
        rootNodeId: nodeId(ordinal),
        activeAttemptId: attemptId(ordinal),
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: checkpointId(ordinal),
        contextHandoffId: null,
      },
    });
    yield* apply({
      type: "node.updated",
      payload: {
        id: nodeId(ordinal),
        threadId,
        runId: runId(ordinal),
        parentNodeId: null,
        rootNodeId: nodeId(ordinal),
        kind: "root_turn",
        status,
        countsForRun: true,
        providerThreadId,
        providerTurnId: turnId(ordinal),
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: scopeId,
        startedAt: now,
        completedAt: now,
      },
    });
    // Rollback must exclude every attempt of discarded runs, including an inactive retry.
    for (const attemptOrdinal of ordinal === 7 ? [6.5, 7] : [ordinal]) {
      yield* apply({
        type: "run-attempt.created",
        runId: runId(ordinal),
        payload: {
          id: attemptId(attemptOrdinal),
          runId: runId(ordinal),
          attemptOrdinal: attemptOrdinal === ordinal ? 2 : 1,
          rootNodeId: nodeId(ordinal),
          providerInstanceId,
          providerThreadId,
          providerTurnId: turnId(attemptOrdinal),
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* apply({
        type: "provider-turn.updated",
        payload: {
          id: turnId(attemptOrdinal),
          providerThreadId,
          nodeId: nodeId(ordinal),
          runAttemptId: attemptId(attemptOrdinal),
          nativeTurnRef: { driver, nativeId: `native-turn-${attemptOrdinal}`, strength: "strong" },
          ordinal: attemptOrdinal * 2,
          status: status === "rolled_back" ? "completed" : status,
          startedAt: now,
          completedAt: now,
        },
      });
    }
  }
  // A continuation shares the target attempt; its first provider turn is no longer the boundary.
  yield* apply({
    type: "provider-turn.updated",
    payload: {
      id: turnId(2.5),
      providerThreadId,
      nodeId: nodeId(2),
      runAttemptId: attemptId(2),
      nativeTurnRef: { driver, nativeId: "native-turn-2-continuation", strength: "strong" },
      ordinal: 5,
      status: "completed",
      startedAt: now,
      completedAt: now,
    },
  });
  for (let ordinal = 0; ordinal <= 8; ordinal++) {
    yield* apply({
      type: "checkpoint.captured",
      payload: {
        id: checkpointId(ordinal),
        threadId,
        scopeId: ordinal === 8 ? otherScopeId : scopeId,
        runId: ordinal === 0 ? null : runId(Math.min(ordinal, 7)),
        nodeId: nodeId(Math.max(1, Math.min(ordinal, 7))),
        parentCheckpointId: null,
        ordinalWithinScope: ordinal,
        appRunOrdinal: ordinal === 0 ? null : ordinal,
        ref: CheckpointRef.make(`refs/t3/rollback-history/${ordinal}`),
        status: ordinal === 7 ? "stale" : "ready",
        files: [],
        capturedAt: now,
      },
    });
  }

  // A tracked repository records only the turns that changed it: runs 2 and 4 here.
  yield* apply({
    type: "checkpoint-scope.created",
    payload: {
      id: repositoryScopeId,
      threadId,
      runId: runId(2),
      nodeId: nodeId(2),
      parentScopeId: scopeId,
      providerThreadId,
      kind: "manual",
      ordinalWithinParent: 1,
      advancesAppRunCount: false,
      cwd: process.cwd(),
      label: "api",
      repositoryPath: process.cwd(),
      createdAt: now,
    },
  });
  for (const ordinal of [2, 4]) {
    yield* apply({
      type: "checkpoint.captured",
      payload: {
        id: CheckpointId.make(`rollback-history-repository-checkpoint-${ordinal}`),
        threadId,
        scopeId: repositoryScopeId,
        runId: runId(ordinal),
        nodeId: nodeId(ordinal),
        parentCheckpointId: null,
        ordinalWithinScope: ordinal,
        appRunOrdinal: null,
        ref: CheckpointRef.make(`refs/t3/rollback-history/repository/${ordinal}`),
        status: "ready",
        files: [],
        capturedAt: now,
      },
    });
  }

  // Run 2's rows: the one that opens it, then four things the agent did.
  const itemId = (ordinal: number) => TurnItemId.make(`rollback-history-item-${ordinal}`);
  for (const ordinal of [200, 201, 202, 203, 204]) {
    yield* apply({
      type: "turn-item.updated",
      payload: {
        id: itemId(ordinal),
        threadId,
        runId: runId(2),
        nodeId: nodeId(2),
        providerThreadId,
        providerTurnId: turnId(2),
        nativeItemRef: { driver, nativeId: `native-item-${ordinal}`, strength: "strong" },
        parentItemId: null,
        ordinal,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "reasoning",
        text: `step ${ordinal}`,
        streaming: false,
      },
    });
  }

  const rollbackCounts: number[] = [];
  const cuts: Array<ProviderAdapter.ProviderAdapterV2TurnCut | undefined> = [];
  /** What the provider reports as the first item it cut; absent leaves the item asked for. */
  const cutFrom: { ordinal?: number; next?: number } = {};
  const restored: CheckpointId[] = [];
  const deletedRefs: CheckpointId[] = [];
  const discardedRepositoryOrdinals: number[] = [];
  const committed: OrchestrationV2DomainEvent[] = [];
  const detached: ProviderSessionId[] = [];
  const serviceLayer = layerCheckpointRollbackService.pipe(
    Layer.provide(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        IdAllocator.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({
          restore: ({ targets }) =>
            Effect.sync(() => {
              restored.push(
                ...targets.map((target) => checkpointId(target.checkpoint.ordinalWithinScope)),
              );
            }),
          deleteStaleRefs: ({ checkpoints }) =>
            Effect.sync(() => {
              deletedRefs.push(...checkpoints.map((checkpoint) => checkpoint.id));
            }),
          discardRepositorySnapshots: ({ ordinals }) =>
            Effect.sync(() => {
              discardedRepositoryOrdinals.push(...ordinals);
            }),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: ({ events }) =>
            Effect.gen(function* () {
              for (const event of events) yield* store.apply(event);
              committed.push(...events);
              return [];
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EventSink.EventSinkWriteError({
                    eventCount: events.length,
                    cause,
                  }),
              ),
            ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () =>
            Effect.succeed({
              rollbackThread: (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
                Effect.gen(function* () {
                  rollbackCounts.push(yield* resolveCodexRollbackTurnCount(input));
                  if (input.target.type === "provider_turn") cuts.push(input.target.cut);
                  return {
                    providerThread: input.providerThread,
                    ...(cutFrom.ordinal === undefined ? {} : { cutFromOrdinal: cutFrom.ordinal }),
                    ...(cutFrom.next === undefined ? {} : { cutToOrdinal: cutFrom.next }),
                  };
                }),
            } as never),
          detach: ({ providerSessionId }) =>
            Effect.sync(() => {
              detached.push(providerSessionId);
            }),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
      ),
    ),
  );
  const rollback = (
    ordinal: number,
    restoreFiles?: boolean,
    fromItemId?: TurnItemId,
    keepLater?: boolean,
    switchTo?: ModelSelection,
  ) =>
    Effect.gen(function* () {
      const service = yield* CheckpointRollbackService.CheckpointRollbackServiceV2;
      yield* service.execute({
        threadId,
        providerThreadId,
        ...(switchTo === undefined ? {} : { modelSelection: switchTo }),
        scopeId,
        checkpointId: checkpointId(ordinal),
        ...(restoreFiles === undefined ? {} : { restoreFiles }),
        ...(fromItemId === undefined ? {} : { fromItemId }),
        ...(keepLater === true ? { keepLater: true } : {}),
      });
    }).pipe(Effect.provide(serviceLayer));

  return {
    store,
    now,
    apply,
    threadId,
    providerThreadId,
    providerThread,
    modelSelection,
    detached,
    runId,
    nodeId,
    checkpointId,
    rollback,
    rollbackCounts,
    itemId,
    cuts,
    cutFrom,
    restored,
    deletedRefs,
    discardedRepositoryOrdinals,
    repositoryScopeId,
    committed,
  };
});

it.layer(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "rollback history reads",
  (it) => {
    it.effect("rolls back later terminal runs despite obsolete unrelated SQLite payloads", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory;
        const sql = yield* SqlClient.SqlClient;
        const { threadId, runId, nodeId, checkpointId } = history;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES ('rollback-obsolete-transcript', ${threadId}, ${runId(1)}, ${nodeId(1)},
            NULL, NULL, NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(history.now)},
            '{"obsolete":"transcript"}')`;
        yield* sql`UPDATE orchestration_v2_projection_runs
          SET payload_json = '{"obsolete":"run"}' WHERE run_id = ${runId(1)}`;
        yield* sql`UPDATE orchestration_v2_projection_nodes
          SET payload_json = '{"obsolete":"node"}' WHERE node_id = ${nodeId(1)}`;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
          WHERE checkpoint_id IN (${checkpointId(0)}, ${checkpointId(1)}, ${checkpointId(7)}, ${checkpointId(8)})`;
        assert.equal(
          (yield* Effect.exit(history.store.getThreadProjection(threadId)))._tag,
          "Failure",
        );

        yield* history.rollback(2);

        assert.deepEqual(history.rollbackCounts, [4]);
        assert.deepEqual(history.restored, [checkpointId(2)]);
        assert.sameMembers(history.deletedRefs, [3, 4, 5, 6].map(checkpointId));
        const runs = yield* sql<{ ordinal: number; status: string }>`
          SELECT ordinal, status FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} ORDER BY ordinal`;
        assert.deepEqual(
          runs.map((run) => run.status),
          [
            "completed",
            "completed",
            "rolled_back",
            "rolled_back",
            "rolled_back",
            "rolled_back",
            "rolled_back",
          ],
        );
        const nodes = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} ORDER BY node_id`;
        assert.deepEqual(
          nodes.map((node) => node.status),
          runs.map((run) => run.status),
        );
        const checkpoints = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_checkpoints
          WHERE thread_id = ${threadId} AND scope_id != ${history.repositoryScopeId}
          ORDER BY ordinal_within_scope`;
        assert.deepEqual(
          checkpoints.map((checkpoint) => checkpoint.status),
          ["ready", "ready", "ready", "stale", "stale", "stale", "stale", "stale", "ready"],
        );
        // The repository keeps its state at the target and loses what the discarded runs recorded,
        // including the snapshots that have no record.
        const repositoryCheckpoints = yield* sql<{ status: string }>`
          SELECT status FROM orchestration_v2_projection_checkpoints
          WHERE scope_id = ${history.repositoryScopeId} ORDER BY ordinal_within_scope`;
        assert.deepEqual(
          repositoryCheckpoints.map((checkpoint) => checkpoint.status),
          ["ready", "stale"],
        );
        assert.deepEqual(history.discardedRepositoryOrdinals, [3, 4, 5, 6]);
      }),
    );

    it.effect("rewinds the conversation to a run whose snapshot capture failed", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_checkpoints
          SET status = 'error', payload_json = json_set(payload_json, '$.status', 'error')
          WHERE checkpoint_id = ${history.checkpointId(2)}`;

        yield* history.rollback(2, false);

        assert.deepEqual(history.rollbackCounts, [4]);
        assert.deepEqual(history.restored, []);
      }),
    );

    it.effect(
      "rewinds stopped runs repeatedly without counting discarded provider turns again",
      () =>
        Effect.gen(function* () {
          const history = yield* seedRollbackHistory;
          yield* history.rollback(5);
          yield* history.rollback(2);
          yield* history.rollback(0);
          yield* history.rollback(0);

          assert.deepEqual(history.rollbackCounts, [1, 3, 3]);
          assert.sameMembers(history.deletedRefs, [1, 2, 3, 4, 5, 6].map(history.checkpointId));
          assert.sameMembers(
            history.committed
              .filter((event) => event.type === "run.updated")
              .map((event) => event.payload.id),
            [1, 2, 3, 4, 5, 6].map(history.runId),
          );
          const records = yield* history.store.getThreadRecords(history.threadId, [
            "runs",
            "nodes",
            "checkpoints",
          ]);
          assert.isTrue(records.runs.every((run) => run.status === "rolled_back"));
          assert.isTrue(records.nodes.every((node) => node.status === "rolled_back"));
          assert.sameMembers(
            records.checkpoints
              .filter((checkpoint) => checkpoint.status === "ready")
              .map((checkpoint) => checkpoint.id),
            [history.checkpointId(0), history.checkpointId(8)],
          );
        }),
    );

    it.effect("cuts the kept run at a step and hides what the provider dropped", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory;
        // The step that produced item 203 began with item 202.
        history.cutFrom.ordinal = 202;

        yield* history.rollback(2, false, history.itemId(203));

        // Later runs go as in any rewind; files stay, whatever the caller asked.
        assert.deepEqual(history.rollbackCounts, [4]);
        assert.deepEqual(history.restored, []);
        assert.deepEqual(
          history.cuts.map((cut) => [cut?.item.ordinal, cut?.items.map((item) => item.ordinal)]),
          [[203, [200, 201, 202, 203, 204]]],
        );
        assert.deepEqual(history.cuts[0]?.item.nativeItemId, "native-item-203");
        // Read through the run's records: other tests leave rows a full projection cannot decode.
        const visible = () =>
          Effect.gen(function* () {
            const cutRun = yield* history.store.getRun(history.threadId, history.runId(2));
            const refs = yield* history.store.getRunItemRefs(history.threadId, history.runId(2));
            return refs
              .map((ref) => ref.ordinal)
              .filter((ordinal) => !isOrchestrationV2RunItemTruncated(cutRun!, { ordinal }));
          });
        assert.deepEqual(yield* visible(), [200, 201]);
        const run = yield* history.store.getRun(history.threadId, history.runId(2));
        assert.equal(run?.status, "completed");
        assert.deepEqual(
          run?.truncations?.map((cut) => cut.fromOrdinal),
          [202],
        );

        // A second cut sees only what the first left, and never takes the run's opening row.
        history.cutFrom.ordinal = 0;
        yield* history.rollback(2, false, history.itemId(201));
        assert.deepEqual(
          history.cuts[1]?.items.map((item) => item.ordinal),
          [200, 201],
        );
        assert.deepEqual(yield* visible(), [200]);
      }),
    );

    it.effect("takes one step out of a run and leaves the later runs alone", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory;
        // The step is items 202 and 203; item 204 belongs to the next one.
        history.cutFrom.ordinal = 202;
        history.cutFrom.next = 204;

        yield* history.rollback(2, false, history.itemId(203), true);

        assert.deepEqual(
          history.cuts.map((cut) => [cut?.item.ordinal, cut?.only]),
          [[203, true]],
        );
        // The store is shared with the tests above, which cut this run too: read the new cut.
        const run = yield* history.store.getRun(history.threadId, history.runId(2));
        const cut = run?.truncations?.at(-1);
        assert.deepEqual([cut?.fromOrdinal, cut?.toOrdinal], [202, 204]);
        assert.deepEqual(
          [200, 201, 202, 203, 204].filter(
            (ordinal) => !isOrchestrationV2RunItemTruncated({ truncations: [cut!] }, { ordinal }),
          ),
          [200, 201, 204],
        );
        // Nothing is rewound: no run is rolled back and no checkpoint goes stale.
        assert.isFalse(history.committed.some((event) => event.type === "checkpoint.captured"));
        assert.deepEqual(
          history.committed.flatMap((event) =>
            event.type === "run.updated" ? [[event.payload.id, event.payload.status]] : [],
          ),
          [[history.runId(2), "completed"]],
        );
        assert.deepEqual(history.deletedRefs, []);
        const records = yield* history.store.getThreadRecords(history.threadId, [
          "providerThreads",
        ]);
        assert.equal(records.providerThreads[0]?.lastRunOrdinal, 6);
      }),
    );

    it.effect("skips a pending rollback once the thread is deleted", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory;
        const thread = yield* history.store.getThread(history.threadId);
        yield* history.store.apply({
          id: EventId.make("rollback-history-deleted"),
          type: "thread.deleted",
          threadId: history.threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: history.now,
          payload: { ...thread, deletedAt: history.now, updatedAt: history.now },
        });

        yield* history.rollback(2);

        assert.deepEqual(history.rollbackCounts, []);
        assert.deepEqual(history.restored, []);
        assert.deepEqual(history.committed, []);
      }),
    );

    it.effect("goes back to another agent's turn and makes that agent the thread's again", () =>
      Effect.gen(function* () {
        const history = yield* seedRollbackHistory;
        // Runs 3 and 4 went to another agent, which is the thread's agent now.
        const otherSelection = { instanceId: ProviderInstanceId.make("claude"), model: "opus" };
        const other = {
          ...history.providerThread,
          id: ProviderThreadId.make("rollback-history-other"),
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: otherSelection.instanceId,
          providerSessionId: ProviderSessionId.make("rollback-history-other-session"),
          nativeThreadRef: {
            driver: ProviderDriverKind.make("claudeAgent"),
            nativeId: "other-native",
            strength: "strong" as const,
          },
          firstRunOrdinal: 3,
          lastRunOrdinal: 4,
        };
        yield* history.apply({ type: "provider-thread.updated", payload: other });
        const thread = yield* history.store.getThread(history.threadId);
        yield* history.apply({
          type: "thread.provider-switched",
          payload: {
            ...thread,
            providerInstanceId: otherSelection.instanceId,
            modelSelection: otherSelection,
          },
        });
        for (const ordinal of [3, 4]) {
          const run = yield* history.store.getRun(history.threadId, history.runId(ordinal));
          yield* history.apply({
            type: "run.updated",
            runId: run!.id,
            payload: { ...run!, providerThreadId: other.id },
          });
        }

        yield* history.rollback(2, false, undefined, undefined, history.modelSelection);

        const after = yield* history.store.getThread(history.threadId);
        assert.equal(after.activeProviderThreadId, history.providerThreadId);
        assert.deepEqual(after.modelSelection, history.modelSelection);
        // The other agent's conversation still holds runs 3 and 4: it starts over when used again.
        const records = yield* history.store.getThreadRecords(history.threadId, [
          "providerThreads",
          "runs",
        ]);
        const reset = records.providerThreads.find((candidate) => candidate.id === other.id);
        assert.deepEqual(
          [reset?.nativeThreadRef, reset?.providerSessionId, reset?.lastRunOrdinal],
          [null, null, null],
        );
        assert.deepEqual(history.detached, [other.providerSessionId]);
        assert.deepEqual(
          records.runs.filter((run) => run.ordinal > 2).map((run) => run.status),
          ["rolled_back", "rolled_back", "rolled_back", "rolled_back", "rolled_back"],
        );
      }),
    );
  },
);
