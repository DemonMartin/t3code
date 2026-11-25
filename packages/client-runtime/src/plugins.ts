import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type {
  PluginAction,
  PluginBlock,
  PluginInput,
  PluginCatalog,
  PluginStatusAction,
  PluginView,
} from "@t3tools/contracts";
import {
  PluginEnvironmentLaunchResult,
  PluginNoticeResult,
  PluginRelayResult,
  PluginSecretResult,
  PluginViewResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeEnvironmentLaunchResult = Schema.decodeUnknownOption(PluginEnvironmentLaunchResult);
export function pluginEnvironmentLaunchResult(value: unknown) {
  return Option.getOrNull(decodeEnvironmentLaunchResult(value));
}

const decodeSecretResult = Schema.decodeUnknownOption(PluginSecretResult);
export function pluginSecretResult(value: unknown): PluginSecretResult | null {
  return Option.getOrNull(decodeSecretResult(value));
}

const decodeViewResult = Schema.decodeUnknownOption(PluginViewResult);
export function pluginViewResult(value: unknown): PluginViewResult | null {
  return Option.getOrNull(decodeViewResult(value));
}

export type PluginForm = Extract<PluginBlock, { readonly kind: "form" }>;

/** Passwords are never populated from server defaults. */
export function pluginFormDefaults(form: PluginForm): PluginInput {
  return Object.fromEntries(
    form.fields.map((field) => [
      field.name,
      field.kind === "password" ? "" : (field.value ?? (field.kind === "boolean" ? false : "")),
    ]),
  );
}

export function pluginFormInput(form: PluginForm, values: PluginInput): PluginInput | null {
  const input: Record<string, PluginInput[string]> = { ...form.input };
  for (const field of form.fields) {
    const value = values[field.name];
    if (field.required && (value === undefined || value === null || value === "")) return null;
    if (field.kind === "number") {
      if (value === "" || value === undefined) continue;
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      input[field.name] = number;
    } else if (field.kind === "select") {
      if ((value === undefined || value === "") && !field.required) continue;
      if (!field.options?.some((option) => option.value === value)) return null;
      if (value !== undefined) input[field.name] = value;
    } else if (field.kind === "boolean") {
      input[field.name] = value === true;
    } else {
      input[field.name] = typeof value === "string" ? value : "";
    }
  }
  return input;
}

/** Plugin links may open a sign-in page, never execute a URL scheme in the client. */
export function pluginLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function pluginSettingsPages(catalog: PluginCatalog) {
  return catalog.plugins
    .filter((plugin) => plugin.status === "active")
    .flatMap((plugin) =>
      plugin.views
        .filter((view) => view.location === "settings-page")
        .map((view) => ({
          pluginId: plugin.id,
          viewId: view.id,
          title: view.title,
        })),
    );
}

/** `autoLaunch` is null unless the view names a command its plugin registered. */
export function pluginEnvironmentLaunchers(catalog: PluginCatalog | null | undefined) {
  return (catalog?.plugins ?? []).flatMap((plugin) =>
    plugin.status === "active"
      ? plugin.views
          .filter((view) => view.location === "environment-launcher")
          .map((view) => {
            const command = plugin.commands.find((command) => command.id === view.autoLaunch);
            return {
              pluginId: plugin.id,
              viewId: view.id,
              title: view.title,
              autoLaunch: command
                ? { commandId: command.id, permission: command.permission }
                : null,
            };
          })
      : [],
  );
}
export type PluginEnvironmentLauncher = ReturnType<typeof pluginEnvironmentLaunchers>[number];
export type PluginAutoLauncher = PluginEnvironmentLauncher & {
  readonly autoLaunch: NonNullable<PluginEnvironmentLauncher["autoLaunch"]>;
};

/** The launcher a new draft's first send starts through, when a plugin asks for that. */
export function pluginAutoLauncher(
  catalog: PluginCatalog | null | undefined,
): PluginAutoLauncher | null {
  return (
    pluginEnvironmentLaunchers(catalog).find(
      (launcher): launcher is PluginAutoLauncher => launcher.autoLaunch !== null,
    ) ?? null
  );
}

/** The thread a launch started, once its environment runs and this client is connected to it. */
export function pluginLaunchDestination(
  resources: ReadonlyArray<{
    readonly owner: { readonly environmentId: string; readonly pluginId: string };
    readonly environmentId: string;
    readonly launchRequestId?: string | undefined;
    readonly state: string;
    readonly threadId?: string | undefined;
  }>,
  isConnected: (environmentId: string) => boolean,
  launch: {
    readonly environmentId: string;
    readonly pluginId: string;
    readonly requestId: unknown;
  },
): { readonly environmentId: string; readonly threadId: string } | null {
  for (const resource of resources) {
    if (
      resource.owner.environmentId === launch.environmentId &&
      resource.owner.pluginId === launch.pluginId &&
      resource.launchRequestId === launch.requestId &&
      resource.state === "running" &&
      resource.threadId &&
      isConnected(resource.environmentId)
    )
      return { environmentId: resource.environmentId, threadId: resource.threadId };
  }
  return null;
}

export interface PluginLaunchStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly status: "done" | "running" | "pending" | "failed";
}
const LAUNCH_STEP_STATUS = {
  success: "done",
  warning: "running",
  muted: "pending",
  danger: "failed",
} as const;

/**
 * What a launcher view says about a launch in flight. Each status block is a step, its tone the
 * step's state, and the actions are the launch's controls. A launcher that predates steps shows
 * text only, which becomes one step. A view with neither, or with a form, is asking how to
 * launch: this launch no longer exists.
 */
export function pluginLaunchProgress(view: PluginView | null): {
  readonly withdrawn: boolean;
  readonly steps: ReadonlyArray<PluginLaunchStep>;
  readonly actions: ReadonlyArray<PluginAction>;
} {
  if (view === null) return { withdrawn: false, steps: [], actions: [] };
  const actions = view.blocks.flatMap((block) => (block.kind === "actions" ? block.actions : []));
  const steps = view.blocks.flatMap((block): PluginLaunchStep[] =>
    block.kind === "status" && block.label !== undefined
      ? [
          {
            id: block.id,
            label: block.label,
            detail: block.detail ?? null,
            status: LAUNCH_STEP_STATUS[block.tone ?? "muted"],
          },
        ]
      : [],
  );
  if (steps.length > 0) return { withdrawn: false, steps, actions };
  const text = view.blocks.flatMap((block) => (block.kind === "text" ? [block.text] : []));
  if (text.length === 0 || view.blocks.some((block) => block.kind === "form"))
    return { withdrawn: true, steps: [], actions: [] };
  return {
    withdrawn: false,
    steps: [
      {
        id: "launch",
        label: text.join(" · "),
        detail: null,
        status: actions.some((action) => action.id === "retry") ? "failed" : "running",
      },
    ],
    actions,
  };
}

export type PluginStatus = Extract<PluginBlock, { readonly kind: "status" }>;

export function pluginThreadDetailsViews(catalog: PluginCatalog) {
  return catalog.plugins
    .filter((plugin) => plugin.status === "active")
    .flatMap((plugin) =>
      plugin.views
        .filter((view) => view.location === "thread-details")
        .map((view) => ({ plugin, viewId: view.id })),
    );
}

/** The thread is added last, so a plugin's own input cannot name another thread. */
export function pluginStatusActionInput(
  action: PluginStatusAction,
  threadId: string,
  destination: string | null,
): PluginInput {
  return {
    ...action.input,
    ...(action.environment && destination !== null
      ? { [action.environment.name]: destination }
      : {}),
    threadId,
  };
}

/** An environment picker offers only other environments that run the same plugin. */
export function pluginActionDestinations<
  Target extends { readonly environmentId: string; readonly catalog: PluginCatalog | null },
>(targets: readonly Target[], sourceEnvironmentId: string, pluginId: string): readonly Target[] {
  return targets.filter(
    (target) =>
      target.environmentId !== sourceEnvironmentId &&
      target.catalog?.plugins.some(
        (plugin) => plugin.id === pluginId && plugin.status === "active",
      ) === true,
  );
}

/**
 * Two machines can share a name, such as two servers on one host. A destination whose name
 * matches the current machine or another destination shows its address as well.
 */
export function pluginDestinationLabel(
  target: { readonly label: string; readonly displayUrl: string | null },
  otherLabels: readonly string[],
): string {
  return target.displayUrl !== null && otherLabels.includes(target.label)
    ? `${target.label} (${target.displayUrl})`
    : target.label;
}

export interface PluginActionStep {
  readonly environmentId: string;
  readonly commandId: string;
  readonly input: PluginInput;
}
export type PluginActionReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string | null };

const decodeNoticeResult = Schema.decodeUnknownOption(PluginNoticeResult);
export function pluginNoticeResult(value: unknown): PluginNoticeResult | null {
  return Option.getOrNull(decodeNoticeResult(value));
}
const failed = (message: string | null, resolve: MFunctionType): PluginNoticeResult => ({
  $t3: "notice",
  tone: "danger",
  text: message ?? resolve(msg("The plugin command failed. Try again.")),
});

const decodeRelayResult = Schema.decodeUnknownOption(PluginRelayResult);
/** Enough for a large carried transfer; a plugin that never finishes still stops. */
const MAX_PLUGIN_RELAY_STEPS = 5_000;

/**
 * Runs a status action to its end, carrying each relayed step to the environment it names.
 * Null means it finished with nothing to show, or was cancelled.
 */
export async function runPluginAction(options: {
  readonly resolve?: MFunctionType;
  readonly start: PluginActionStep;
  readonly execute: (step: PluginActionStep) => Promise<PluginActionReply>;
  readonly onStatus?: (status: string) => void;
  readonly signal?: AbortSignal;
}): Promise<PluginNoticeResult | null> {
  let step = options.start;
  for (let count = 0; count < MAX_PLUGIN_RELAY_STEPS; count++) {
    if (options.signal?.aborted) return null;
    const reply = await options.execute(step);
    if (!reply.ok) return failed(reply.message, options.resolve ?? mFallback);
    const relay = Option.getOrNull(decodeRelayResult(reply.value));
    if (relay === null) return Option.getOrNull(decodeNoticeResult(reply.value));
    if (relay.status !== undefined) options.onStatus?.(relay.status);
    step = {
      environmentId: relay.environmentId ?? step.environmentId,
      commandId: relay.command,
      input: relay.input,
    };
  }
  return failed(
    (options.resolve ?? mFallback)(msg("The plugin did not finish. Try again.")),
    options.resolve ?? mFallback,
  );
}

const GRAPH_COLORS = ["#0284c7", "#c026d3", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"];

/** Pending parents keep their lane and color until their node is reached. */
export function pluginGraphLayout(
  nodes: readonly { readonly id: string; readonly parents: readonly string[] }[],
) {
  let lanes: { id: string; color: string }[] = [];
  let nextColor = 0;
  let columns = 1;
  const rows = nodes.map((node) => {
    const existing = lanes.findIndex((lane) => lane.id === node.id);
    const column = existing < 0 ? lanes.length : existing;
    const color =
      existing < 0 ? GRAPH_COLORS[nextColor++ % GRAPH_COLORS.length]! : lanes[column]!.color;
    const before = [...lanes];
    if (existing < 0) lanes.push({ id: node.id, color });
    const next = [...lanes];
    next.splice(column, 1);
    node.parents.forEach((id, i) => {
      if (!next.some((lane) => lane.id === id)) {
        const lane = {
          id,
          color: i === 0 ? color : GRAPH_COLORS[nextColor++ % GRAPH_COLORS.length]!,
        };
        if (i === 0) next.splice(Math.min(column, next.length), 0, lane);
        else next.push(lane);
      }
    });
    const edges: { from: number; to: number; start: number; end: number; color: string }[] = [];
    before.forEach((lane, from) => {
      if (lane.id === node.id) edges.push({ from, to: column, start: 0, end: 22, color });
      else
        edges.push({
          from,
          to: next.findIndex((item) => item.id === lane.id),
          start: 0,
          end: 44,
          color: lane.color,
        });
    });
    node.parents.forEach((parent) => {
      const to = next.findIndex((lane) => lane.id === parent);
      edges.push({ from: column, to, start: 22, end: 44, color: next[to]!.color });
    });
    columns = Math.max(columns, before.length, column + 1, next.length);
    lanes = next;
    return {
      id: node.id,
      column,
      color,
      paths: edges.map((edge) => ({
        color: edge.color,
        d: `M ${10 + edge.from * 16} ${edge.start} C ${10 + edge.from * 16} 22 ${10 + edge.to * 16} 22 ${10 + edge.to * 16} ${edge.end}`,
      })),
    };
  });
  return { width: columns * 16 + 4, rows };
}

export function pluginThreadPanels(catalog: PluginCatalog, hasRepository: boolean) {
  return catalog.plugins
    .filter((plugin) => plugin.status === "active")
    .flatMap((plugin) =>
      plugin.views
        .filter(
          (view) => view.location === "thread-panel" && (!view.requiresRepository || hasRepository),
        )
        .map((view) => ({ plugin, view })),
    );
}
