import { startProductionBrowserHarness } from "./harness.mjs";

export default async function globalSetup() {
  return startProductionBrowserHarness();
}
