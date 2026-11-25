import { describe, expect, it } from "vite-plus/test";
import {
  pluginActionDestinations,
  pluginDestinationLabel,
  pluginStatusActionInput,
  runPluginAction,
  pluginFormDefaults,
  pluginSettingsPages,
  pluginFormInput,
  pluginLink,
  pluginSecretResult,
  pluginViewResult,
  pluginGraphLayout,
  pluginThreadPanels,
  pluginAutoLauncher,
  pluginChoiceCreateForm,
  pluginChoiceMatches,
  pluginCreatedChoice,
  pluginEnvironmentLaunchers,
  pluginLaunchContextWithOptions,
  pluginLaunchDestination,
  pluginLaunchOptions,
  pluginLaunchOptionValues,
  pluginLaunchProgress,
  type PluginForm,
} from "./plugins.ts";

const form: PluginForm = {
  id: "configure",
  kind: "form",
  label: "Save",
  command: "save",
  input: { account: "one" },
  fields: [
    { name: "token", label: "Token", kind: "password", value: "must-not-prefill", required: true },
    { name: "idle", label: "Idle minutes", kind: "number", value: 12 },
    { name: "enabled", label: "Enabled", kind: "boolean", value: true },
    {
      name: "strategy",
      label: "Strategy",
      kind: "select",
      value: "round-robin",
      options: [{ label: "Round robin", value: "round-robin" }],
    },
  ],
};
describe("portable plugin forms", () => {
  it("never prefills a password and preserves typed defaults", () => {
    expect(pluginFormDefaults(form)).toEqual({
      token: "",
      idle: 12,
      enabled: true,
      strategy: "round-robin",
    });
  });
  it("merges form values into the command payload using portable types", () => {
    expect(
      pluginFormInput(form, {
        token: "private",
        idle: "25",
        enabled: true,
        strategy: "round-robin",
      }),
    ).toEqual({
      account: "one",
      token: "private",
      idle: 25,
      enabled: true,
      strategy: "round-robin",
    });
  });
  it("rejects missing required fields, non-finite numbers, and unknown choices", () => {
    const defaults = pluginFormDefaults(form);
    expect(pluginFormInput(form, defaults)).toBeNull();
    expect(pluginFormInput(form, { ...defaults, token: "key", idle: "Infinity" })).toBeNull();
    expect(pluginFormInput(form, { ...defaults, token: "key", strategy: "unexpected" })).toBeNull();
  });
  it("accepts web sign-in links and rejects executable, relative, and credential-bearing URLs", () => {
    expect(pluginLink("https://provider.example/signin?state=one")).toBe(
      "https://provider.example/signin?state=one",
    );
    expect(pluginLink("http://localhost:3000/callback")).toBe("http://localhost:3000/callback");
    expect(pluginLink("javascript:alert(1)")).toBeNull();
    expect(pluginLink("file:///etc/passwd")).toBeNull();
    expect(pluginLink("/relative")).toBeNull();
    expect(pluginLink("https://token:secret@provider.example/")).toBeNull();
  });
});

it("allows an optional select to remain empty", () => {
  const optional: PluginForm = {
    ...form,
    fields: [
      { name: "region", label: "Region", kind: "select", options: [{ label: "US", value: "us" }] },
    ],
  };
  expect(pluginFormInput(optional, { region: "" })).toEqual({ account: "one" });
});

it("recognizes only bounded explicit secret feedback", () => {
  expect(pluginSecretResult({ $t3: "secret", label: "API key", value: "private" })).toEqual({
    $t3: "secret",
    label: "API key",
    value: "private",
  });
  expect(pluginSecretResult({ value: "private" })).toBeNull();
  expect(
    pluginSecretResult({ $t3: "secret", label: "API key", value: "x".repeat(20_000) }),
  ).toBeNull();
});

it("removes extension navigation when the last contributing page is disabled, removed, or withdrawn", () => {
  const plugin = {
    id: "example",
    name: "Example",
    version: "1.0.0",
    status: "active" as const,
    commands: [],
    views: [
      {
        id: "settings",
        title: "Example settings",
        location: "settings-page" as const,
        permission: "settings:write" as const,
      },
    ],
  };
  expect(pluginSettingsPages({ configurationError: false, plugins: [plugin] })).toEqual([
    { pluginId: "example", viewId: "settings", title: "Example settings" },
  ]);
  expect(
    pluginSettingsPages({
      configurationError: false,
      plugins: [{ ...plugin, status: "disabled" }],
    }),
  ).toEqual([]);
  expect(pluginSettingsPages({ configurationError: false, plugins: [] })).toEqual([]);
  expect(
    pluginSettingsPages({
      configurationError: false,
      plugins: [{ ...plugin, views: [{ ...plugin.views[0]!, location: "usage" }] }],
    }),
  ).toEqual([]);
});

describe("thread details actions", () => {
  const action = {
    id: "move",
    label: "Move",
    command: "move",
    input: { threadId: "another-thread", keep: 1 },
    environment: { name: "destination", label: "Move to" },
  };
  const active = { id: "rehome", name: "Rehome", version: "1.0.0", commands: [], views: [] };
  const catalog = (status: "active" | "disabled") => ({
    configurationError: false,
    plugins: [{ ...active, status }],
  });

  it("names the pressed thread even when the plugin's own input names another", () => {
    expect(pluginStatusActionInput(action, "pressed-thread", "env-b")).toEqual({
      keep: 1,
      destination: "env-b",
      threadId: "pressed-thread",
    });
  });
  it("sends the value picked from an action's list, and only one the action offered", () => {
    const idle = {
      id: "idle",
      label: "Idle stop",
      command: "idle",
      input: { seconds: "600", threadId: "another-thread" },
      choice: {
        name: "seconds",
        value: "600",
        options: [
          { label: "10 min", value: "600" },
          { label: "1 h", value: "3600" },
        ],
      },
    };
    expect(pluginStatusActionInput(idle, "pressed-thread", null, "3600")).toEqual({
      seconds: "3600",
      threadId: "pressed-thread",
    });
    expect(pluginStatusActionInput(idle, "pressed-thread", null, "86400")).toEqual({
      seconds: "600",
      threadId: "pressed-thread",
    });
  });
  it("offers only other environments where the plugin is running", () => {
    expect(
      pluginActionDestinations(
        [
          { environmentId: "source", catalog: catalog("active") },
          { environmentId: "running", catalog: catalog("active") },
          { environmentId: "disabled", catalog: catalog("disabled") },
          { environmentId: "loading", catalog: null },
        ],
        "source",
        "rehome",
      ).map((target) => target.environmentId),
    ).toEqual(["running"]);
  });
  it("shows a destination's address only when its name alone would be ambiguous", () => {
    const server = { label: "system76-pc", displayUrl: "http://localhost:16126" };
    expect(pluginDestinationLabel(server, ["macbook"])).toBe("system76-pc");
    expect(pluginDestinationLabel(server, ["system76-pc"])).toBe(
      "system76-pc (http://localhost:16126)",
    );
    expect(pluginDestinationLabel({ ...server, displayUrl: null }, ["system76-pc"])).toBe(
      "system76-pc",
    );
  });
  it("turns a failed command into a notice and passes a plugin's notice through", async () => {
    const start = { environmentId: "source", commandId: "move", input: {} };
    expect(
      await runPluginAction({ start, execute: async () => ({ ok: false, message: null }) }),
    ).toMatchObject({ tone: "danger" });
    const notice = { $t3: "notice", tone: "success", text: "Moved." };
    expect(
      await runPluginAction({ start, execute: async () => ({ ok: true, value: notice }) }),
    ).toEqual(notice);
    expect(
      await runPluginAction({ start, execute: async () => ({ ok: true, value: { any: 1 } }) }),
    ).toBeNull();
    // An action that ends by noting what it changed hands the text over and opens no dialog.
    const noted: Array<string> = [];
    expect(
      await runPluginAction({
        start,
        execute: async () => ({
          ok: true,
          value: { $t3: "thread-notice", text: "Idle stop set to 1 h" },
        }),
        onThreadNotice: (text) => noted.push(text),
      }),
    ).toBeNull();
    expect(noted).toEqual(["Idle stop set to 1 h"]);
  });
  it("carries relayed steps between environments until the plugin ends or the user cancels", async () => {
    const start = { environmentId: "source", commandId: "move", input: {} };
    const steps: Array<string> = [];
    const statuses: Array<string> = [];
    const execute = async (step: typeof start) => {
      steps.push(`${step.environmentId}:${step.commandId}`);
      const value =
        step.commandId === "move"
          ? { $t3: "relay", environmentId: "destination", command: "accept", input: { n: 1 } }
          : step.commandId === "accept"
            ? { $t3: "relay", command: "import", input: {}, status: "Copying work" }
            : { $t3: "notice", tone: "success", text: "Moved." };
      return { ok: true as const, value };
    };
    expect(
      await runPluginAction({ start, execute, onStatus: (status) => statuses.push(status) }),
    ).toMatchObject({ text: "Moved." });
    // A step without an environment stays where the previous one ran.
    expect(steps).toEqual(["source:move", "destination:accept", "destination:import"]);
    expect(statuses).toEqual(["Copying work"]);

    const controller = new AbortController();
    steps.length = 0;
    const cancelled = await runPluginAction({
      start,
      signal: controller.signal,
      execute: async (step) => {
        controller.abort();
        return execute(step);
      },
    });
    expect(cancelled).toBeNull();
    expect(steps).toEqual(["source:move"]);
  });
});

it("decodes bounded client-local navigation and rejects malformed pages", () => {
  const result = {
    $t3: "view",
    view: {
      title: "Details",
      blocks: [{ id: "patch", kind: "code", text: "diff --git a/file b/file" }],
    },
  };
  expect(pluginViewResult(result)).toEqual(result);
  expect(
    pluginViewResult({
      ...result,
      view: { ...result.view, blocks: [{ id: "patch", kind: "code", text: "x".repeat(16_385) }] },
    }),
  ).toBeNull();
  expect(
    pluginViewResult({
      ...result,
      view: { ...result.view, blocks: [...result.view.blocks, ...result.view.blocks] },
    }),
  ).toBeNull();
  expect(pluginViewResult({ $t3: "notice", text: "hello" })).toBeNull();
});

it("keeps branch colors through merges, joins parents once, and ends independent roots", () => {
  const graph = pluginGraphLayout([
    { id: "merge", parents: ["main", "side"] },
    { id: "side", parents: ["root"] },
    { id: "main", parents: ["root"] },
    { id: "root", parents: [] },
    { id: "other", parents: [] },
  ]);
  expect(graph.rows.map((row) => row.column)).toEqual([0, 1, 0, 0, 0]);
  expect(graph.rows[0]!.paths).toHaveLength(2);
  expect(graph.rows[1]!.color).not.toBe(graph.rows[2]!.color);
  expect(graph.rows[3]!.paths).toHaveLength(1);
  expect(graph.rows[4]!.paths).toEqual([]);
  expect(graph.width).toBe(36);
});

it("hides repository-required thread panels until a Git repository is confirmed", () => {
  const plugin = {
    id: "example",
    name: "Example",
    version: "1.0.0",
    status: "active" as const,
    commands: [],
    views: [
      {
        id: "history",
        title: "History",
        location: "thread-panel" as const,
        permission: "filesystem:read" as const,
        requiresRepository: true,
      },
      {
        id: "notes",
        title: "Notes",
        location: "thread-panel" as const,
        permission: "filesystem:read" as const,
      },
    ],
  };
  const catalog = { configurationError: false, plugins: [plugin] };
  expect(pluginThreadPanels(catalog, false).map(({ view }) => view.id)).toEqual(["notes"]);
  expect(pluginThreadPanels(catalog, true).map(({ view }) => view.id)).toEqual([
    "history",
    "notes",
  ]);
  expect(
    pluginThreadPanels({ ...catalog, plugins: [{ ...plugin, status: "disabled" }] }, true),
  ).toEqual([]);
});

it("starts new drafts through the launcher whose auto-launch command its plugin registered", () => {
  const view = {
    title: "New sandbox",
    location: "environment-launcher" as const,
    permission: "environment:maintain" as const,
  };
  const plugin = {
    id: "sandboxes",
    name: "Sandboxes",
    version: "1.0.0",
    status: "active" as const,
    commands: [
      {
        id: "launch",
        title: "Launch",
        description: "Start a sandboxed thread",
        permission: "environment:maintain" as const,
        agent: false,
      },
    ],
    views: [
      { ...view, id: "manual" },
      { ...view, id: "missing", autoLaunch: "withdrawn" },
      { ...view, id: "launcher", autoLaunch: "launch", autoLaunchOptions: "launch" },
      { ...view, id: "settings", location: "settings" as const, autoLaunch: "launch" },
    ],
  };
  const catalog = { configurationError: false, plugins: [plugin] };
  const auto = { commandId: "launch", permission: "environment:maintain" };
  expect(
    pluginEnvironmentLaunchers(catalog).map(({ viewId, autoLaunch }) => [viewId, autoLaunch]),
  ).toEqual([
    ["manual", null],
    ["missing", null],
    ["launcher", auto],
  ]);
  expect(pluginAutoLauncher(catalog)).toEqual({
    pluginId: "sandboxes",
    viewId: "launcher",
    title: "New sandbox",
    autoLaunch: auto,
    // The options command counts only when the plugin registered it, like the launch itself.
    autoLaunchOptions: auto,
  });
  expect(pluginEnvironmentLaunchers(catalog)[1]?.autoLaunchOptions).toBeNull();
  expect(
    pluginAutoLauncher({ ...catalog, plugins: [{ ...plugin, status: "stopped" }] }),
  ).toBeNull();
  expect(
    pluginAutoLauncher({ ...catalog, plugins: [{ ...plugin, views: plugin.views.slice(0, 2) }] }),
  ).toBeNull();
  expect(pluginAutoLauncher(null)).toBeNull();
});

it("starts a launch with the options the user picked, and the plugin's defaults otherwise", () => {
  const size = {
    name: "size",
    label: "Size",
    value: "low",
    choices: [
      { label: "Low", value: "low" },
      { label: "High", value: "high" },
    ],
  };
  const options = pluginLaunchOptions({
    $t3: "launch-options",
    options: [size, { ...size, name: "message", value: "replaced" }],
  });
  expect(options.map((option) => option.name)).toEqual(["size", "message"]);
  // Anything else a command answers offers nothing.
  expect(pluginLaunchOptions(null)).toEqual([]);
  expect(
    pluginLaunchOptions({ $t3: "launch-options", options: [{ ...size, name: "No" }] }),
  ).toEqual([]);

  const context = { message: "Fix the test", projectDirectory: "/work/app" };
  expect(pluginLaunchContextWithOptions(context, options, { size: "high" })).toEqual({
    size: "high",
    message: "Fix the test",
    projectDirectory: "/work/app",
  });
  // No pick, or one the option no longer offers, starts with the default.
  expect(pluginLaunchContextWithOptions(context, options, {}).size).toBe("low");
  expect(pluginLaunchContextWithOptions(context, options, { size: "huge" }).size).toBe("low");
  expect(pluginLaunchOptionValues(options, { size: "high" })).toEqual({
    size: "high",
    message: "replaced",
  });
});

it("searches a list by label and description, and finds the entry a save added", () => {
  const choices = [
    { label: "Low", value: "low", description: "4 cores · 16 GB" },
    { label: "High", value: "high", description: "16 cores · 64 GB" },
    { label: "Custom", value: "custom" },
  ];
  const matches = (query: string) => pluginChoiceMatches(choices, query).map(({ value }) => value);
  expect(matches("")).toEqual(["low", "high", "custom"]);
  expect(matches(" HIGH ")).toEqual(["high"]);
  expect(matches("16")).toEqual(["low", "high"]);
  expect(matches("none")).toEqual([]);

  expect(pluginCreatedChoice(["low", "high"], choices)?.value).toBe("custom");
  expect(pluginCreatedChoice(["low", "high", "custom"], choices)).toBeNull();

  // A create form reads its fields like any plugin form: numbers parsed, its own input kept.
  const form = pluginChoiceCreateForm({
    label: "New size",
    command: "size-save",
    fields: [
      { name: "id", label: "Name", kind: "text", required: true },
      { name: "cpus", label: "Cores", kind: "number" },
    ],
    input: { scope: "sizes" },
  });
  expect(pluginFormInput(form, { id: "huge", cpus: "32" })).toEqual({
    scope: "sizes",
    id: "huge",
    cpus: 32,
  });
  expect(pluginFormInput(form, { id: "", cpus: "32" })).toBeNull();
});

it("opens a launch's thread only once its environment runs and is connected", () => {
  const launch = { environmentId: "controller", pluginId: "sandboxes", requestId: "request" };
  const resource = {
    owner: { environmentId: "controller", pluginId: "sandboxes" },
    environmentId: "sandbox",
    launchRequestId: "request",
    state: "running",
    threadId: "thread",
  };
  const destination = (
    resources: Parameters<typeof pluginLaunchDestination>[0],
    connected = ["sandbox"],
  ) => pluginLaunchDestination(resources, (id) => connected.includes(id), launch);

  expect(destination([resource])).toEqual({ environmentId: "sandbox", threadId: "thread" });
  expect(destination([resource], [])).toBeNull();
  expect(destination([{ ...resource, state: "starting" }])).toBeNull();
  expect(destination([{ ...resource, threadId: undefined }])).toBeNull();
  expect(destination([{ ...resource, launchRequestId: "another" }])).toBeNull();
  expect(
    destination([{ ...resource, owner: { environmentId: "controller", pluginId: "other" } }]),
  ).toBeNull();
});

it("reads a launch's steps and controls from its launcher view", () => {
  const cancel = { id: "cancel", label: "Cancel provisioning", command: "cancel", input: {} };
  const retry = { id: "retry", label: "Retry", command: "state", input: {} };
  const step = (id: string, tone: "success" | "warning" | "muted" | "danger", detail?: string) => ({
    id,
    kind: "status" as const,
    tone,
    label: id,
    ...(detail === undefined ? {} : { detail }),
    actions: [],
  });
  const view = (blocks: NonNullable<Parameters<typeof pluginLaunchProgress>[0]>["blocks"]) =>
    pluginLaunchProgress({ title: "New sandbox", blocks });

  expect(
    view([
      step("start", "success"),
      step("prepare", "warning", "pulling image"),
      step("agent", "muted"),
      { id: "control", kind: "actions", actions: [cancel] },
    ]),
  ).toEqual({
    withdrawn: false,
    steps: [
      { id: "start", label: "start", detail: null, status: "done" },
      { id: "prepare", label: "prepare", detail: "pulling image", status: "running" },
      { id: "agent", label: "agent", detail: null, status: "pending" },
    ],
    actions: [cancel],
    output: [],
  });
  expect(view([step("start", "danger", "image not found")]).steps[0]?.status).toBe("failed");

  // A launcher that predates steps reports one line of text, and offers retry once it stopped.
  const text = { id: "progress", kind: "text" as const, text: "starting: pulling image" };
  expect(view([text, { id: "control", kind: "actions", actions: [cancel] }]).steps).toEqual([
    { id: "launch", label: "starting: pulling image", detail: null, status: "running" },
  ]);
  expect(view([text, { id: "control", kind: "actions", actions: [retry] }]).steps[0]?.status).toBe(
    "failed",
  );

  // Without the launch the view falls back to its form: the launch was cancelled or deleted.
  expect(
    view([
      { id: "scope", kind: "text", text: "Starts from a pushed commit." },
      { id: "launch", kind: "form", label: "Start", command: "launch", fields: [], input: {} },
    ]).withdrawn,
  ).toBe(true);
  expect(view([]).withdrawn).toBe(true);
  // A view still loading says nothing either way.
  expect(pluginLaunchProgress(null)).toEqual({
    withdrawn: false,
    steps: [],
    actions: [],
    output: [],
  });

  // Code blocks are what the running step printed.
  expect(
    view([
      step("prepare", "warning"),
      { id: "log", kind: "code", text: "installing\nbuilding packages\n" },
    ]).output,
  ).toEqual(["installing", "building packages"]);
});
