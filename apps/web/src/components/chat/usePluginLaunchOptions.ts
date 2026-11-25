import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  pluginLaunchOptions,
  pluginLaunchOptionValues,
  type PluginAutoLauncher,
  type PluginLaunchOption,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  PluginCommandInput,
  type PluginInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useContext } from "react";

import { m } from "~/i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { pluginCatalogsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";

const NO_OPTIONS: ReadonlyArray<PluginLaunchOption> = [];
const NO_PICKS: Readonly<Record<string, string>> = {};
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ environmentId: EnvironmentId, command: PluginCommandInput }),
  ),
);

/**
 * What a launcher offers for one project and branch, asked once: the request is the key, so
 * typing asks nothing and a change of project or branch asks again. Any failure offers nothing.
 */
const launchOptionsAtom = Atom.family((request: string) =>
  Atom.make(
    Effect.promise(async () => {
      const decoded = Option.getOrNull(decodeRequest(request));
      if (decoded === null) return NO_OPTIONS;
      const outcome = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.executePluginCommand,
        { environmentId: decoded.environmentId, input: decoded.command },
        { label: "plugin-launch-options", reportFailure: false },
      );
      return outcome._tag === "Success" ? pluginLaunchOptions(outcome.value) : NO_OPTIONS;
    }),
  ).pipe(Atom.setIdleTTL("1 minute")),
);

// What the user picked for each draft's launch. In memory only, like the draft's other launch state.
const launchOptionPicksAtom = Atom.make<ReadonlyMap<ThreadId, Readonly<Record<string, string>>>>(
  new Map<ThreadId, Readonly<Record<string, string>>>(),
).pipe(Atom.keepAlive);

export interface PluginLaunchOptionsControl {
  readonly options: ReadonlyArray<PluginLaunchOption>;
  /** What the user picked; an option they left alone is absent. */
  readonly picked: Readonly<Record<string, string>>;
  /** What each option is set to, with the plugin's defaults filled in. */
  readonly values: Readonly<Record<string, string>>;
  readonly pick: (name: string, value: string) => void;
  /** Runs an option's create command, then asks for the options again. Resolves with what went wrong, or null. */
  readonly create: (option: PluginLaunchOption, input: PluginInput) => Promise<string | null>;
}

/**
 * The settings a draft's launcher lets the user choose before the first send. Null while the
 * launcher offers none, so nothing is shown and nothing is reserved for them.
 */
export function usePluginLaunchOptions(input: {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  /** Null unless the launcher is the draft's target and no launch is under way. */
  readonly launcher: PluginAutoLauncher | null;
  readonly context: PluginInput | null;
}): PluginLaunchOptionsControl | null {
  const registry = useContext(RegistryContext);
  const { environmentId, launcher, threadId } = input;
  const command = launcher?.autoLaunchOptions ?? null;
  const request =
    command === null || launcher === null || input.context === null
      ? ""
      : JSON.stringify({
          environmentId,
          command: {
            pluginId: launcher.pluginId,
            commandId: command.commandId,
            permission: command.permission,
            input: input.context,
          },
        });
  const optionsAtom = launchOptionsAtom(request);
  const options = AsyncResult.getOrElse(useAtomValue(optionsAtom), () => NO_OPTIONS);
  const picked = useAtomValue(launchOptionPicksAtom).get(threadId) ?? NO_PICKS;
  const commands =
    useAtomValue(pluginCatalogsAtom)
      .find((row) => row.environmentId === environmentId)
      ?.catalog?.plugins.find((plugin) => plugin.id === launcher?.pluginId)?.commands ?? [];
  if (launcher === null || options.length === 0) return null;
  return {
    options,
    picked,
    values: pluginLaunchOptionValues(options, picked),
    pick: (name, value) =>
      appAtomRegistry.update(launchOptionPicksAtom, (current) =>
        new Map(current).set(threadId, { ...current.get(threadId), [name]: value }),
      ),
    create: async (option, values) => {
      const descriptor = commands.find((candidate) => candidate.id === option.create?.command);
      if (!descriptor) return m(msg("The plugin command failed. Try again."));
      const outcome = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.executePluginCommand,
        {
          environmentId,
          input: {
            pluginId: launcher.pluginId,
            commandId: descriptor.id,
            permission: descriptor.permission,
            input: values,
          },
        },
        { label: "plugin-launch-option-create", reportFailure: false },
      );
      if (outcome._tag === "Success") {
        registry.refresh(optionsAtom);
        return null;
      }
      if (isAtomCommandInterrupted(outcome)) return m(msg("Cancelled."));
      const failure = squashAtomCommandFailure(outcome);
      return failure instanceof Error
        ? failure.message
        : m(msg("The plugin command failed. Try again."));
    },
  };
}
