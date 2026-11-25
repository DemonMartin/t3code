import { expect, it } from "vite-plus/test";

import { launcherCarriesSend } from "./pluginAutoLaunch.logic";

it("sends through a launcher only what the launcher can carry", () => {
  const send = { message: "Fix the flaky test", hasAttachments: false, multipleModels: false };
  expect(launcherCarriesSend(send)).toBe(true);
  expect(launcherCarriesSend({ ...send, message: "/review the last commit" })).toBe(true);
  for (const local of [
    { ...send, message: "  \n" },
    { ...send, hasAttachments: true },
    { ...send, multipleModels: true },
    { ...send, message: "/usage-limits" },
    { ...send, message: "/clear" },
    { ...send, message: "/side what does this do?" },
  ]) {
    expect(launcherCarriesSend(local)).toBe(false);
  }
});
