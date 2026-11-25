import { createPluginSummaryAtoms } from "@t3tools/client-runtime/state/plugins";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

export const { pluginCatalogsAtom, pluginStatusByEnvironmentAtom, managedPluginEnvironmentsAtom } =
  createPluginSummaryAtoms({
    connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
    pluginCatalog: serverEnvironment.pluginCatalog,
    pluginView: serverEnvironment.pluginView,
  });

/**
 * Environments a plugin runs for one thread each; new work is never routed to them. Kept
 * identical while its members are unchanged, so a plugin refresh does not re-render the composer.
 */
export const managedPluginEnvironmentIdsAtom = Atom.make((get): ReadonlySet<string> => {
  const next = new Set(
    get(managedPluginEnvironmentsAtom).map((resource) => resource.environmentId),
  );
  const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every((environmentId) => previous.has(environmentId))
    ? previous
    : next;
});
