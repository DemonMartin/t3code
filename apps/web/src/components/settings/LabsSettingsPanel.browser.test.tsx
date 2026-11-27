import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  workflowsEnabled: true,
  mixed: false,
  refusalRecovery: ({} as Partial<typeof DEFAULT_UNIFIED_SETTINGS>["refusalRecovery"])!,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({
    ...DEFAULT_UNIFIED_SETTINGS,
    workflowsEnabled: state.workflowsEnabled,
    refusalRecovery: state.refusalRecovery,
  })) as never,
  useScopedSettingsMixed: () => state.mixed,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({ control, children }: { control: ReactNode; children?: ReactNode }) => (
    <div>
      {control}
      {children}
    </div>
  )) as never,
}));

import { RefusalRecoveryRow, WorkflowSkippedRunsRow } from "./LabsSettingsPanel";

describe("WorkflowSkippedRunsRow", () => {
  it("saves the number of skipped runs kept on blur and on Enter", async () => {
    state.workflowsEnabled = true;
    state.mixed = false;
    state.updateSettings.mockReset();
    await using _screen = await render(<WorkflowSkippedRunsRow />, { router: false });

    const field = page.getByRole("textbox", { name: "Skipped runs kept" });
    await expect.element(field).toHaveValue("500");
    await userEvent.clear(field);
    await userEvent.type(field, "50");
    await userEvent.tab();
    expect(state.updateSettings).toHaveBeenCalledWith({ workflowSkippedRunsKept: 50 });
    await userEvent.clear(field);
    await userEvent.type(field, "40");
    await userEvent.keyboard("{Enter}");
    expect(state.updateSettings).toHaveBeenLastCalledWith({ workflowSkippedRunsKept: 40 });
    await expect.element(field).toHaveFocus();
  });

  it("saves to every target when they hold different numbers, even the first one's", async () => {
    state.workflowsEnabled = true;
    state.mixed = true;
    state.updateSettings.mockReset();
    await using _screen = await render(<WorkflowSkippedRunsRow />, { router: false });

    const field = page.getByRole("textbox", { name: "Skipped runs kept" });
    await expect.element(field).toHaveValue("");
    await expect.element(field).toHaveAttribute("placeholder", "Mixed");
    await userEvent.type(field, "500");
    await userEvent.tab();
    expect(state.updateSettings).toHaveBeenCalledWith({ workflowSkippedRunsKept: 500 });
  });

  it("shows nothing while workflows are off", async () => {
    state.workflowsEnabled = false;
    await using screen = await render(<WorkflowSkippedRunsRow />, { router: false });
    expect(screen.container.textContent).toBe("");
  });
});

describe("RefusalRecoveryRow", () => {
  const disabled = () => {
    state.refusalRecovery = { ...DEFAULT_UNIFIED_SETTINGS.refusalRecovery, enabled: false };
  };
  const enabled = () => {
    state.refusalRecovery = { ...DEFAULT_UNIFIED_SETTINGS.refusalRecovery, enabled: true };
  };

  it("keeps the layers hidden until recovery is on, then saves one switch at a time", async () => {
    disabled();
    state.updateSettings.mockReset();
    await using screen = await render(<RefusalRecoveryRow />, { router: false });

    expect(screen.container.textContent).not.toContain("Strip refusal trigger strings");
    await userEvent.click(page.getByRole("switch", { name: "Refusal recovery" }));
    expect(state.updateSettings).toHaveBeenCalledWith({
      refusalRecovery: { ...state.refusalRecovery, enabled: true },
    });

    enabled();
    await screen.rerender(<RefusalRecoveryRow />);
    await userEvent.click(page.getByRole("switch", { name: "Strip refusal trigger strings" }));
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      refusalRecovery: {
        ...state.refusalRecovery,
        strip: { ...state.refusalRecovery.strip!, enabled: false },
      },
    });
  });

  it("leaves one provider out without touching the others", async () => {
    enabled();
    state.refusalRecovery = { ...state.refusalRecovery, providers: {} };
    state.updateSettings.mockReset();
    await using _screen = await render(<RefusalRecoveryRow />, { router: false });

    await userEvent.click(page.getByRole("switch", { name: "Refusal recovery in Claude Code" }));
    expect(state.updateSettings).toHaveBeenCalledWith({
      refusalRecovery: { ...state.refusalRecovery, providers: { claude: { enabled: false } } },
    });
  });

  it("defaults to rewriting the refused step and offers the harder cuts", async () => {
    enabled();
    state.updateSettings.mockReset();
    await using screen = await render(<RefusalRecoveryRow />, { router: false });

    const mode = screen.getByRole("combobox", { name: "What a repair does with the refused step" });
    await expect.element(mode).toHaveTextContent("Rewrite the refused step");
    await mode.click();
    expect(page.getByRole("option", { name: "Drop the refused answer" })).toBeInTheDocument();
    await page.getByRole("option", { name: "Drop the whole turn" }).click();
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      refusalRecovery: {
        ...state.refusalRecovery,
        repair: { ...state.refusalRecovery.repair!, cutMode: "drop-whole-turn" },
      },
    });

    // The handoff model follows the other provider unless one is named.
    await expect
      .element(screen.getByRole("combobox", { name: "Handoff model" }))
      .toHaveTextContent("Other provider's first model");
  });
});
