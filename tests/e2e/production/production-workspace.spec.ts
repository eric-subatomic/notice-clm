import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

type HarnessState = {
  origin: string;
  workspaceId: string;
  admin: { subject: string; email: string; displayName: string };
  viewer: { subject: string; email: string; displayName: string };
  adminToken: string;
  viewerToken: string;
};

async function harnessState(): Promise<HarnessState> {
  const stateFile = join(process.cwd(), "work", "playwright", "production-harness", "state.json");
  return JSON.parse(await readFile(stateFile, "utf8")) as HarnessState;
}

test("signed production identities drive a durable browser mutation and enforce viewer denial", async ({ browser }) => {
  const state = await harnessState();
  const adminContext = await browser.newContext({
    extraHTTPHeaders: { "cf-access-jwt-assertion": state.adminToken },
  });
  const adminPage = await adminContext.newPage();

  await adminPage.goto(state.origin);
  await expect(adminPage.getByRole("button", { name: "Notice home" })).toBeVisible();
  await expect(adminPage.locator(".sync-line")).toHaveCount(0);
  await expect(adminPage.locator(".workspace-error")).toHaveCount(0);

  const adminSession = await adminPage.evaluate(async () => {
    const response = await fetch("/api/session");
    return { status: response.status, body: await response.json() };
  });
  expect(adminSession.status).toBe(200);
  expect(adminSession.body).toMatchObject({
    mode: "production",
    identitySource: "cloudflare-access",
    role: "admin",
    workspace: { id: state.workspaceId },
    user: { email: state.admin.email, displayName: state.admin.displayName },
  });

  await adminPage.getByRole("button", { name: /Open account menu for/ }).click();
  await expect(adminPage.getByRole("link", { name: /Sign out of Notice/ })).toBeVisible();
  await adminPage.keyboard.press("Escape");

  await adminPage.getByRole("button", { name: /Start from template/ }).first().click();
  const generator = adminPage.getByRole("dialog");
  await expect(generator.getByRole("heading", { name: "Choose governed or starter paper" })).toBeVisible();
  await generator.getByRole("button", { name: /Continue/ }).click();
  await expect(generator.getByRole("heading", { name: "Confirm the contract details" })).toBeVisible();
  await generator.getByLabel(/Counterparty/).fill("Browser Evidence Counterparty");
  await generator.getByLabel("Contract amount").fill("42000");
  await generator.getByRole("button", { name: /Continue/ }).click();
  await expect(generator.getByRole("heading", { name: "Review before creating the working draft" })).toBeVisible();
  await generator.getByRole("button", { name: /Open working draft/ }).click();

  await expect(adminPage.getByRole("heading", { name: "Browser Evidence Counterparty" })).toBeVisible();
  await expect(adminPage.locator(".clm-toast")).toContainText("Working draft created");
  await expect(adminPage.getByText("Saved working draft v1", { exact: false })).toBeVisible();

  const relationshipRoute = "**/api/agreements/*/relationships";
  await adminPage.route(relationshipRoute, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      json: { error: { message: "Synthetic relationship outage." } },
    });
  });
  await adminPage.getByRole("tab", { name: "Contract details" }).click();
  const relationshipPanel = adminPage.locator(".relationship-panel");
  await expect(relationshipPanel.getByRole("alert")).toContainText("Synthetic relationship outage.");
  await adminPage.unroute(relationshipRoute);
  await relationshipPanel.getByRole("button", { name: "Retry" }).click();
  await expect(relationshipPanel.getByRole("alert")).toHaveCount(0);
  await expect(relationshipPanel.locator(".relationship-columns")).toBeVisible();
  await adminPage.getByLabel("Department").fill("Durable Browser Department");
  await adminPage.getByRole("button", { name: "Save changes" }).click();
  await expect(adminPage.locator(".clm-toast")).toContainText("Agreement details saved");

  await adminPage.reload();
  await expect(adminPage.getByRole("heading", { name: "Browser Evidence Counterparty" })).toBeVisible();
  await expect(adminPage.locator(".sync-line")).toHaveCount(0);
  await expect(adminPage.getByRole("tab", { name: "Contract details" })).toHaveAttribute("aria-selected", "true");
  await expect(adminPage.getByLabel("Department")).toHaveValue("Durable Browser Department");

  await adminPage.getByRole("button", { name: "Setup & access" }).click();
  await expect(adminPage.getByRole("heading", { name: "Govern the workspace without editing configuration files." })).toBeVisible();
  const docuSealProvider = adminPage.locator(".provider-list article").filter({ hasText: "DocuSeal e-signature" });
  await docuSealProvider.getByRole("button", { name: "Test" }).click();
  await expect(adminPage.locator(".clm-toast")).toContainText("DocuSeal e-signature connection test passed");
  const scannerProvider = adminPage.locator(".provider-list article").filter({ hasText: "Document scanning" });
  await scannerProvider.getByRole("button", { name: "Test" }).click();
  await expect(adminPage.locator(".clm-toast")).toContainText("Document scanning connection test passed");

  await adminPage.getByRole("tab", { name: /^Groups/ }).click();
  await expect(adminPage.getByRole("heading", { name: "Workspace access" })).toBeVisible();
  const accessPanel = adminPage.locator(".member-admin");
  await accessPanel.getByRole("textbox", { name: "Member name" }).fill(state.viewer.displayName);
  await accessPanel.getByRole("textbox", { name: "Member email" }).fill(state.viewer.email);
  await accessPanel.getByRole("combobox", { name: "Member role" }).selectOption("viewer");
  await accessPanel.getByRole("button", { name: "Add member" }).click();
  await expect(adminPage.locator(".clm-toast")).toContainText("Workspace access is ready");

  const viewerContext = await browser.newContext({
    extraHTTPHeaders: { "cf-access-jwt-assertion": state.viewerToken },
  });
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(`${state.origin}/?view=agreements`);
  await expect(viewerPage.getByRole("button", { name: "Notice home" })).toBeVisible();
  await expect(viewerPage.getByText("Browser Evidence Counterparty", { exact: true })).toBeVisible();
  await expect(viewerPage.getByRole("button", { name: /Start from template/ })).toHaveCount(0);

  const viewerSession = await viewerPage.evaluate(async () => {
    const response = await fetch("/api/session");
    return { status: response.status, body: await response.json() };
  });
  expect(viewerSession.status).toBe(200);
  expect(viewerSession.body).toMatchObject({
    mode: "production",
    identitySource: "cloudflare-access",
    role: "viewer",
    user: { email: state.viewer.email, displayName: state.viewer.displayName },
  });

  const forbiddenCreate = await viewerPage.evaluate(async () => {
    const response = await fetch("/api/agreements", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({}),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(forbiddenCreate.status).toBe(403);
  expect(forbiddenCreate.body).toMatchObject({ error: { code: "permission_denied" } });

  await viewerContext.close();
  await adminContext.close();
});
