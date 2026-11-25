import { SlidersHorizontalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ComposerControl } from "../chat/ComposerControl";
import { useComposerMenuProps } from "../chat/composerEventScope";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "../chat/threadDetailsPanelStyles";
import type { PluginLaunchOptionsControl } from "../chat/usePluginLaunchOptions";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { PluginChoicePicker } from "./PluginChoicePicker";

/** One picker per setting a draft's launcher offers, beside the Run on control it belongs to. */
export function PluginLaunchOptionPickers({
  control,
  displayMode = "toolbar",
}: {
  control: PluginLaunchOptionsControl;
  displayMode?: "toolbar" | "panel";
}) {
  const composerMenuProps = useComposerMenuProps();
  const panel = displayMode === "panel";
  return control.options.map((option) => {
    const value = control.values[option.name] ?? option.value;
    const { create } = option;
    return (
      <PluginChoicePicker
        key={option.name}
        label={option.label}
        value={value}
        choices={option.choices}
        onPick={(picked) => control.pick(option.name, picked)}
        create={
          create ? { form: create, save: (input) => control.create(option, input) } : undefined
        }
        trigger={
          panel ? (
            <ThreadDetailsControl part="select" />
          ) : (
            <ComposerControl size="xs" data-composer-context-control />
          )
        }
        popupProps={panel ? undefined : composerMenuProps}
      >
        <SlidersHorizontalIcon
          aria-hidden
          className={cn("size-3 shrink-0", panel && THREAD_DETAILS_PANEL_ICON_CLASS)}
        />
        <ComposerContextLabel displayMode={displayMode}>
          {option.choices.find((choice) => choice.value === value)?.label ?? value}
        </ComposerContextLabel>
      </PluginChoicePicker>
    );
  });
}
