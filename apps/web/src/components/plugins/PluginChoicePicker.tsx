import {
  pluginChoiceCreateForm,
  pluginChoiceMatches,
  pluginCreatedChoice,
  pluginFormDefaults,
  pluginFormInput,
} from "@t3tools/client-runtime/plugins";
import type { PluginChoiceCreate, PluginChoiceOption, PluginInput } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckIcon, PlusIcon } from "lucide-react";
import {
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxSearchInput,
} from "../ui/combobox";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface PluginChoiceCreator {
  readonly form: PluginChoiceCreate;
  /** Runs the plugin's command with the form's values. Resolves with what went wrong, or null. */
  readonly save: (input: PluginInput) => Promise<string | null>;
}

/**
 * A list a plugin offers, as a searchable picker: each entry's label, its description beside it,
 * and a check on the current one. A plugin may also offer a form that adds an entry; the entry
 * the list gains from a save is picked for the user.
 */
export function PluginChoicePicker({
  label,
  value,
  choices,
  disabled = false,
  onPick,
  create,
  trigger,
  popupProps,
  children,
}: {
  /** The list's name: the trigger shows only the current entry, so this is what it is called. */
  label: string;
  value: string;
  choices: ReadonlyArray<PluginChoiceOption>;
  disabled?: boolean;
  onPick: (value: string) => void;
  create?: PluginChoiceCreator | undefined;
  /** The control the picker opens from, in the look of the place it sits in. */
  trigger: ReactElement;
  popupProps?: Partial<ComponentProps<typeof PopoverPopup>> | undefined;
  children: ReactNode;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  // The values offered when a save went out; the list's next new value is that save's entry.
  const offeredBeforeSave = useRef<ReadonlyArray<string> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pickCreated = useEffectEvent((createdValue: string) => onPick(createdValue));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- picks the entry the plugin's refreshed list gained from a save
  useEffect(() => {
    const created =
      offeredBeforeSave.current === null
        ? null
        : pluginCreatedChoice(offeredBeforeSave.current, choices);
    if (created === null) return;
    offeredBeforeSave.current = null;
    pickCreated(created.value);
  }, [choices]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setCreating(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={<PopoverTrigger render={trigger} disabled={disabled} aria-label={label} />}
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="start"
        padding="none"
        width="sm"
        initialFocus={searchRef}
        {...popupProps}
      >
        {creating && create ? (
          <PluginChoiceCreateForm
            create={create}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              offeredBeforeSave.current = choices.map((choice) => choice.value);
              close();
            }}
          />
        ) : (
          <>
            <Combobox
              inline
              open
              items={choices}
              filteredItems={pluginChoiceMatches(choices, query)}
              filter={null}
              autoHighlight
              itemToStringLabel={(choice: PluginChoiceOption) => choice.label}
              isItemEqualToValue={(a: PluginChoiceOption, b: PluginChoiceOption) =>
                a.value === b.value
              }
              value={choices.find((choice) => choice.value === value) ?? null}
              onValueChange={(choice) => {
                if (!choice) return;
                close();
                if (choice.value !== value) onPick(choice.value);
              }}
            >
              <ComboboxSearchInput
                ref={searchRef}
                aria-label={gt("Search", { $context: "search field placeholder" })}
                placeholder={gt("Search", { $context: "search field placeholder" })}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <ComboboxEmpty>
                <T>No matches found.</T>
              </ComboboxEmpty>
              <div className="flex max-h-64 min-h-0 flex-col">
                <ComboboxList>
                  {(choice: PluginChoiceOption) => (
                    <ComboboxItem key={choice.value} value={choice}>
                      <span className="min-w-0 truncate">{choice.label}</span>
                      {choice.description === undefined ? null : (
                        <span className="ms-auto min-w-0 shrink truncate text-muted-foreground text-xs">
                          {choice.description}
                        </span>
                      )}
                      <span className="flex size-3.5 shrink-0 items-center justify-center">
                        {choice.value === value ? <CheckIcon aria-hidden /> : null}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </div>
            </Combobox>
            {create ? (
              <div className="flex border-border/60 border-t p-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setCreating(true)}
                >
                  <PlusIcon aria-hidden />
                  {create.form.label}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function PluginChoiceCreateForm({
  create,
  onCancel,
  onSaved,
}: {
  create: PluginChoiceCreator;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const gt = useGT();
  const form = pluginChoiceCreateForm(create.form);
  const [draft, setDraft] = useState<PluginInput>({});
  const values = { ...pluginFormDefaults(form), ...draft };
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="flex flex-col gap-2.5 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const input = pluginFormInput(form, values);
        setInvalid(input === null);
        if (input === null) return;
        setSaving(true);
        setError(null);
        void create
          .save(input)
          .then((failure) => {
            if (failure === null) onSaved();
            else setError(failure);
          })
          .finally(() => setSaving(false));
      }}
    >
      <p className="font-medium text-sm">{create.form.label}</p>
      {form.fields.map((field, index) => (
        <label key={field.name} className="flex flex-col gap-1 text-muted-foreground text-xs">
          {field.label}
          {field.kind === "boolean" ? (
            <Switch
              size="sm"
              checked={values[field.name] === true}
              disabled={saving}
              onCheckedChange={(checked) => setDraft({ ...draft, [field.name]: Boolean(checked) })}
            />
          ) : (
            <Input
              size="sm"
              // A list's form asks for a name and a few numbers; other kinds read as text.
              type={field.kind === "number" || field.kind === "password" ? field.kind : "text"}
              step={field.kind === "number" ? "any" : undefined}
              autoFocus={index === 0}
              autoComplete="off"
              required={field.required}
              disabled={saving}
              value={String(values[field.name] ?? "")}
              onChange={(event) => setDraft({ ...draft, [field.name]: event.target.value })}
            />
          )}
        </label>
      ))}
      {invalid ? (
        <p role="alert" className="text-destructive text-xs">
          <T>Complete the required fields with valid values.</T>
        </p>
      ) : error === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" disabled={saving} onClick={onCancel}>
          {gt("Cancel")}
        </Button>
        <Button type="submit" size="xs" disabled={saving}>
          {gt("Save")}
        </Button>
      </div>
    </form>
  );
}
