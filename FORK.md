# About this fork

This branch (`agentbox`) is an unofficial fork of T3 Code. It builds on the plugin-host branch
[`t3/create-plugin-system`](https://github.com/djgilcrease/t3code/tree/t3/create-plugin-system)
of djgilcrease/t3code, which itself tracks [pingdotgg/t3code](https://github.com/pingdotgg/t3code).
It is not affiliated with or endorsed by the T3 Code maintainers; see [TRADEMARK.md](TRADEMARK.md).

The changes let a plugin make its own environment the default place a chat runs, so that
"open a project, write a message, send" starts the chat in a fresh sandbox, as cloud coding
agents do. They are generic host features; the plugin that uses them is
[DemonMartin/t3-sandboxes](https://github.com/DemonMartin/t3-sandboxes) (branch `agentbox`).

## What changed

**Plugins**

- A launcher view (`location: "environment-launcher"`) may name an `autoLaunch` command. The
  client runs it on the first send of a new draft; an `environment-launch` result claims the
  send, any other result leaves it to the normal send, and a failure is shown without sending.
- A managed environment may carry a `resume` action. The client runs it when the user turns to
  a thread on a stopped environment: opening it, sending a message, or running a thread command
  such as Settle. The command waits for the environment and then runs.
- Launcher views may return `status` blocks; the client renders them as the setup steps of the
  thread being started, in place of the launch dialog.

**Web client**

- A draft whose project has an auto launcher shows the launcher as its "Run on" target; picking
  a machine opts that draft out. Workspace-mode controls that do not apply are hidden.
- New drafts always open on the project of the environment that owns a plugin-managed
  environment, never on the managed environment itself, including after a reload.
- Plugin-managed environments are not offered as "Run on", Auto balance or
  "Add to another machine" targets.
- A stopped managed environment shows a quiet "starting" status instead of a connection error.

**Server**

- With `T3CODE_CODEX_EXTERNAL_SANDBOX=1`, Codex's read-only and workspace-write modes use its
  external-sandbox policy. Inside a container Codex's own bubblewrap sandbox cannot start; the
  container is the sandbox.

Mobile is unchanged.

## Building

As upstream: `vp i`, then `vp run --filter t3 build`. The controller and every sandbox image
must run the same build.
