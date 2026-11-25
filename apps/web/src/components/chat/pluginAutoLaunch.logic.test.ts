import { expect, it } from "vite-plus/test";

import type { ComposerThreadDraftState } from "../../composerDraftStore";
import {
  launcherCarriesSend,
  launcherDraftContent,
  launcherMessage,
  type LauncherAttachment,
} from "./pluginAutoLaunch.logic";

it("offers a launcher every first send that starts one thread", () => {
  const send = { message: "Fix the flaky test", hasAttachments: false, multipleModels: false };
  expect(launcherCarriesSend(send)).toBe(true);
  expect(launcherCarriesSend({ ...send, message: "/review the last commit" })).toBe(true);
  // The plugin refuses what it cannot carry, so the message never silently runs on this machine.
  expect(launcherCarriesSend({ ...send, hasAttachments: true })).toBe(true);
  for (const local of [
    { ...send, message: "  \n" },
    { ...send, multipleModels: true },
    { ...send, message: "/usage-limits" },
    { ...send, message: "/clear" },
    { ...send, message: "/side what does this do?" },
  ]) {
    expect(launcherCarriesSend(local)).toBe(false);
  }
});

it("takes a draft's images and files along and names what it cannot carry", () => {
  const empty = {
    prompt: "Look at this capture",
    images: [],
    files: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
    replyTo: null,
  } as unknown as ComposerThreadDraftState;
  expect(launcherDraftContent(null)).toEqual({ attachments: [], other: false });
  expect(launcherDraftContent(empty)).toEqual({ attachments: [], other: false });

  const image = { type: "image", id: "image-1" };
  const file = { type: "file", id: "file-1" };
  const attached = {
    ...empty,
    images: [image],
    files: [file],
    persistedAttachments: [{ id: "image-1" }],
  } as unknown as ComposerThreadDraftState;
  expect(launcherDraftContent(attached)).toEqual({ attachments: [image, file], other: false });
  expect(
    launcherDraftContent({
      ...attached,
      terminalContexts: [{ id: "terminal-1" }],
    } as unknown as ComposerThreadDraftState).other,
  ).toBe(true);
});

it("sends a launcher the message without the marks that name its attachments in the draft", () => {
  const file = { type: "file", id: "b4faa887" } as LauncherAttachment;
  const marked = "[trace.har](t3-context://v1/file/file_b4faa887) What does this capture show?";
  expect(launcherMessage(marked, [file])).toBe("What does this capture show?");
  expect(launcherMessage(marked, [])).toBe(marked);
});
