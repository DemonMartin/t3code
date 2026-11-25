import {
  createPluginSummaryAtoms,
  managedEnvironmentOwners,
} from "@t3tools/client-runtime/state/plugins";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

export const { pluginCatalogsAtom, pluginStatusByEnvironmentAtom, managedPluginEnvironmentsAtom } =
  createPluginSummaryAtoms({
    connectedEnvironmentIdsAtom: environmentSummaries.connectedEnvironmentIdsAtom,
    pluginCatalog: serverEnvironment.pluginCatalog,
    pluginView: serverEnvironment.pluginView,
  });

/**
 * The owning environment of every plugin-managed environment. Such an environment runs one
 * thread, so new work is never routed to it. Saved connections name their owner before any plugin
 * has answered. Kept identical while unchanged, so a plugin refresh does not re-render the composer.
 */
export const managedEnvironmentOwnersAtom = Atom.make((get): ReadonlyMap<string, string> => {
  const next = managedEnvironmentOwners(
    get(environmentCatalog.catalogValueAtom).entries,
    get(managedPluginEnvironmentsAtom),
  );
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, string>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every(([environmentId, owner]) => previous.get(environmentId) === owner)
    ? previous
    : next;
});
