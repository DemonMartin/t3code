# About this fork

[DemonMartin/t3code](https://github.com/DemonMartin/t3code), branch `agentbox`, is an unofficial fork of T3 Code. It builds on the plugin-host branch [`t3/create-plugin-system`](https://github.com/djgilcrease/t3code/tree/t3/create-plugin-system) of djgilcrease/t3code, which tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It is not affiliated with or endorsed by the T3 Code maintainers ([TRADEMARK.md](TRADEMARK.md)). The official downloads and apps are the upstream product and do not contain these changes.

The fork does three things.

- **Sandboxes by default.** A plugin can make its own environment the default place a chat runs: open a project, write a message, send, and the chat starts in a fresh sandbox, as cloud coding agents do. The changes are generic plugin-host features; the plugin that uses them is [DemonMartin/t3-sandboxes](https://github.com/DemonMartin/t3-sandboxes) (branch `agentbox`).
- **Control over what the agent has in its context.** A thread can be rewound to any step inside a turn, a single step can be cut out, a switch to another agent hands over much more of the thread, and the chat can be switched to show only what the current agent has.
- **Refusal recovery.** A refused turn is stripped of the sentinel strings that cause it, framed before it is sent, detected after it, and repaired instead of being left in the context. Off by default, under Settings → Labs.

## What changed

**For plugins**

- A launcher view (`location: "environment-launcher"`) may name an `autoLaunch` command. The client runs it on the first send of a new draft; an `environment-launch` result claims the send, any other result leaves it to the normal send, a failure is shown without sending.
- A launcher may name an `autoLaunchOptions` command that returns options for a new launch (for example a size). The composer shows them next to "Run on" and sends the picked values with the launch.
- While a launch runs, the launcher view's `status` blocks are shown as the setup steps of the thread being started, and its `code` blocks as the running step's output. This replaces the launch dialog for auto launches.
- A managed environment may carry a `resume` action. The client runs it when the user turns to a thread on a stopped environment (opening it, sending a message, or a thread command such as Settle), waits for it, then carries out what the user asked.
- A status action may offer a `choice` instead of a button, and launch options use the same control: a picker with a search field, a description beside each entry and an optional form to create a new entry.
- A status action's command may answer with a `thread-notice`; it is recorded in the thread it was run from and shown in the conversation like a model change.

**In the web client**

- A draft whose project has an auto launcher shows the launcher as its "Run on" target; picking a machine opts that draft out. Workspace-mode controls that do not apply are hidden.
- New drafts open on the project of the environment that owns a plugin-managed environment, never on the managed environment itself, including after a reload.
- Plugin-managed environments are not offered as "Run on", Auto balance, "Add to another machine" or provider-update targets. The update dialog names the installed and available version of each provider and no longer closes while its rows change.
- A stopped managed environment shows a quiet starting status instead of a connection error.
- The started thread opens once its messages are loaded, without an empty page in between.
- A draft's images and files go with the first send: the launch input carries `attachments`, each with `type`, `name`, `mimeType`, `sizeBytes` and a signed `url` on the draft's environment that the plugin reads the bytes from. The message text goes without the draft-only marks that name them. Other attached context (terminal output, annotations, replies) is flagged as `hasAttachments`, for the plugin to refuse.
- The client sends `notices: true` with the launch. A plugin that refuses the send answers with a `notice` result, and the client shows its text; the host itself shows a failed command without its reason. A refused send never runs on the host.

**In a thread: what the agent has in its context**

Upstream can go back to one of your own messages ("Edit from here"). The fork adds three things; the first two appear as icons when you hover a step (a tool call, the agent's thinking or a reply), the third in the header.

| Action                                | What leaves the conversation                           | What stays                                                                                                    |
| ------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Rewind to here** (clock)            | The step and everything after it, later turns included | Everything before it; your next message continues from there                                                  |
| **Cut out** (scissors)                | Only that step                                         | Everything before and after it                                                                                |
| **Edit from here** on a steer         | The steer and everything after it                      | Everything before it; the steer's text returns to the composer                                                |
| **Agent's view** (eye, in the header) | Nothing: it only changes what the chat shows           | The chat shows just the steps the thread's current agent has in its context; click again for the whole thread |

- A step is one model response: its thinking, text and tool calls with their results leave together. Hovering a tool call and rewinding or cutting therefore also takes the thinking that led to it.
- A turn that failed (an API error, a refusal) keeps a rollback point like any other, so its steps can be rewound to and the next message can go back to it. Upstream saves none for a failed turn.
- Files are never changed by a rewind or a cut, because file snapshots exist per turn. To also restore files, use "Edit from here" on your message.
- Supported by OpenCode 2 and Claude Code. Codex can only revert whole turns, so its steps show no icons; other agents likewise. Whether a turn's steps show the icons depends on the agent that ran that turn, not the current one.
- A rewind (any of them, "Edit from here" on a message included) to a turn another agent ran switches the thread back to that agent and the model it used, and continues that agent's own conversation from there. Every other agent whose conversation holds a turn the rewind discards starts over the next time it is used, from a full handoff of what is left; its session is closed.
- The eye appears only when the agent has less than the thread shows: after a switch of agent (a handoff can leave steps out and never carries the other agent's thinking), a cleared context, a restarted session or a compaction. A handed-over step counts as seen even where the handoff shortened it, and everything before a compaction is hidden although the agent keeps a summary of it.
- No marker is shown where a turn was rewound or cut; the turn simply ends at, or continues past, the steps that remain.

**Refusal recovery**

Five layers, each with its own switch, all behind one Labs toggle. The core is provider-agnostic (`packages/provider-core/src/server/refusal.ts`); what differs per provider sits in an adapter table in the same file.

- **Strip.** Every trigger string (`ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL_*`) is replaced with `[REDACTED:refusal-trigger]` in tool arguments, tool results, echoed text and the outbound prompt, recursively. It runs while every other layer is off: the string alone kills Claude Code on read and is harmless on other providers.
- **System prompt.** Both providers get an `<interaction-config>` block through a real system-prompt channel: `--append-system-prompt-file` on Claude, the session's `instructions.md` on OpenCode. Never a preamble in the user turn. Claude's five-bucket paragraph is amended, replaced or left alone (`amend`, `replace`, `off`).
- **Envelope.** A task that trips at least two buckets is wrapped with its scope, so the request itself carries the framing. Keyword pass, no model call.
- **Detection.** The structured refusal (`stop_reason: "refusal"`) where the provider has one — only Claude — and anchored, short final messages on providers without it. OpenCode has no structured signal, so it always takes the text heuristic and logs the matched span.
- **Repair.** The refused span is reverted first (a checkpoint rewind, so the refusal leaves the provider context), then one rung of a three-step ladder is sent as the agent: "continue without hedging", scope and authorization, then the task restated as a template. The cut removes only the refused answer by default; a switch makes it drop the whole turn instead. A category decides routing: cyber, bio and frontier-LLM hand off to the other provider alongside the first rung; reasoning extraction is reworded and never hands off. After the third the thread parks with a warning instead of looping, and that notice offers to switch provider. A handoff pins the thread to the accepting provider for an hour, then the previous selection comes back and the rung count survives.
- Nothing is sent, stripped or detected while the toggle is off, so an off install behaves byte-identically.

**In the server**

- With `T3CODE_CODEX_EXTERNAL_SANDBOX=1`, Codex's read-only and workspace-write modes use its external-sandbox policy. Inside a container Codex's own sandbox cannot start; the container is the sandbox.
- Launcher views may return `status` blocks.
- A switch to another agent hands over more of the thread: about 96 kB by default instead of 64 kB (`T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`, in tokens of four bytes: 24,000 by default, up to 64,000 = 256 kB; small context windows still get less). A long item is shortened, keeping more of its end, instead of being dropped whole, and tool calls, searches and the todo list are handed over as well as messages and shell commands. The agent's thinking is never handed over.
- OpenCode's own browser tools are denied in T3 sessions; they only attach inside OpenCode's desktop app, so agents use T3's preview tools instead.
- If Claude ends a request with a refusal and gives no notice, the thread shows “Claude declined this request” in the activity timeline. When Claude provides its own notice, the timeline shows that text once.

**For provider adapters**

- `checkpoint.rollback` takes `fromItemId` (rewind to that step) and `keepLater` (cut only that step). The rollback target then carries a `cut` with the item and the run's items; the adapter answers with `cutFromOrdinal`, and for a cut of one step `cutToOrdinal`, so the timeline hides exactly what the provider dropped. A run records its cuts in `truncations`.
- An adapter declares `threads.canRollbackWithinTurn` and `threads.canCutStep`; the provider status flag `supportsStepRollback` shows the icons.
- A rollback whose turn was run by another provider thread than the active one goes there: the effect carries the turn's `modelSelection`, the rollback emits `thread.provider-switched` (or `thread.model-selection-updated`) and makes that provider thread active. Other root provider threads with discarded runs lose their native thread and session (`nativeThreadRef`, `providerSessionId` null); a provider thread without a native thread is treated as having seen nothing when the next handoff is built.
- A steer is a `user_message` item inside its run, so editing from it is a rewind with `fromItemId` set to it. Its item ref carries `messageId`: OpenCode 2 finds the steer by the id the adapter sent it under, Claude takes the prompt entry just before the response that followed it.
- OpenCode 2 reverts at the step's own message to rewind. It has no call that removes one message, so a cut exports the session, deletes it and imports it again under the same id without that message (its subagents' sessions, which a delete takes along, are put back after it); these are OpenCode's experimental export and import endpoints.
- Claude rewinds by resuming from the transcript entry before the step. A cut edits the session's transcript file: the step's entries are removed and what hung off them is linked to the entry before.
- A handoff sent to clients carries `deliveredItemIds`, the items the target agent was handed, which the agent's view reads.

Mobile and desktop clients are unchanged; the features above are in the web client the server hosts.

## Install and run

There are no packaged builds of this fork. Run the server from source and use its web client; everything else in the official guide ([docs/user/install.md](docs/user/install.md)) applies as written.

```sh
git clone https://github.com/DemonMartin/t3code.git && cd t3code   # branch agentbox is the default
# Vite+ (vp) and Node 24 are required, as upstream: see docs/operations/00_development.md
vp i
vp run --filter t3 build
node apps/server/dist/bin.mjs serve --host 127.0.0.1 --port 3773 --no-browser
```

Differences from the official guide:

- **No desktop app, mobile app or `npx t3` for this fork.** The official apps can still connect to a server running this fork as a remote environment, but they show upstream behaviour (no automatic launch, no launch steps).
- **Plugins.** Register plugins by path in `plugins.json` under the T3 home (`T3CODE_HOME`, default `~/.t3`), as described in [docs/user/plugins.md](docs/user/plugins.md). For the Sandboxes plugin, follow the README of [DemonMartin/t3-sandboxes](https://github.com/DemonMartin/t3-sandboxes).
- **Sandbox images** must contain this same build with `t3` on `PATH`; rebuild the image whenever you rebuild the server. Inside a container set `T3CODE_CODEX_EXTERNAL_SANDBOX=1`.
- **Updating.** `git pull`, then `vp i && vp run --filter t3 build`, rebuild your sandbox image and restart the server. `vp i` also rebuilds `packages/plugin-sdk`, whose compiled output the server consumes; a stale copy silently drops newer plugin fields.

The branch is rebased on the plugin-host branch from time to time, so expect force-pushes.

---

## Keeping the fork up to date

The branch is a short series of commits on top of the plugin-host branch, one per feature, so it can be rebased when that branch moves:

```sh
git fetch origin                                   # djgilcrease/t3code
git rebase origin/t3/create-plugin-system          # resolve, then:
vp i && vp run -r typecheck && vp run --filter t3 build
```

To keep that cheap, fork code lives in its own files where it can, and upstream files only call into them:

| Feature                            | Fork-owned files                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rewind and cut, server             | `apps/server/src/orchestration-v2/Adapters/ClaudeStepCut.ts`, `packages/provider-opencode/src/server/v2/stepCut.ts`                                                                                                   |
| Rewind and cut, web                | `apps/web/src/components/chat/useStepRewind.tsx`, `TimelineStepRewindButton.tsx` (also `SteerRewindButton`)                                                                                                           |
| Agent's view                       | `packages/client-runtime/src/state/agentContext.ts`                                                                                                                                                                   |
| Auto launch, launch steps, pickers | `apps/web/src/components/chat/usePluginAutoLaunch.ts`, `usePluginLaunchOptions.ts`, `apps/web/src/components/plugins/PluginLaunchSteps.tsx`, `PluginChoicePicker.tsx`, `apps/web/src/state/managedEnvironmentWake.ts` |
| Refusal recovery                   | `packages/provider-core/src/server/refusal.ts`, `apps/server/src/orchestration-v2/RefusalRecoveryWorker.ts`                                                                                                           |

The places where upstream files are edited, and so where a rebase can conflict: `ProjectionStore.ts` (which rows a cut hides, the expired-pin query), `CheckpointRollbackService.ts` and `Orchestrator.ts` (the rollback command, the refusal state), `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/settings.ts`, `ProviderEventIngestor.ts` and `RuntimePolicy.ts` (the strip hook and the preamble), `ChatView.tsx`, `BranchToolbar.tsx` and `LabsSettingsPanel.tsx`.
