import { expect, it } from "vite-plus/test";

import { launcherCarriesSend } from "./pluginAutoLaunch.logic";

it("offers a launcher every first send that starts one thread", () => {
  const send = { message: "Fix the flaky test", hasAttachments: false, multipleModels: false };
  expect(launcherCarriesSend(send)).toBe(true);
  expect(launcherCarriesSend({ ...send, message: "/review the last commit" })).toBe(true);
  // The plugin refuses attachments itself, so the message never silently runs on this machine.
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
