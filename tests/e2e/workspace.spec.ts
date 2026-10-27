import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openEvaluationWorkspace(page: Page, path = "/") {
  await page.goto(path);
  const compactViewport = (page.viewportSize()?.width ?? 1_280) <= 780;
  await expect(page.getByRole("button", { name: compactViewport ? "Open navigation" : "Notice home" })).toBeVisible();
  await expect(page.locator(".sync-line")).toHaveCount(0);
  await expect(page.locator(".workspace-error")).toHaveCount(0);
}

async function expectNoViewportOverflow(page: Page) {
  const measurement = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      viewportWidth: window.innerWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      offenders: Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${element.classList.length ? `.${Array.from(element.classList).join(".")}` : ""}`,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          };
        })
        .filter(({ right }) => right > window.innerWidth + 2)
        .slice(0, 10),
    };
  });
  expect(
    measurement.rootScrollWidth,
    `root overflow at ${measurement.viewportWidth}px: ${JSON.stringify(measurement.offenders)}`,
  ).toBeLessThanOrEqual(measurement.viewportWidth + 2);
  expect(
    measurement.bodyScrollWidth,
    `body overflow at ${measurement.viewportWidth}px: ${JSON.stringify(measurement.offenders)}`,
  ).toBeLessThanOrEqual(measurement.viewportWidth + 2);
}

async function expectNoMaterialAxeViolations(page: Page, context: string) {
  await page.evaluate(async () => {
    const finiteAnimations = document.getAnimations().filter((animation) =>
      animation.effect?.getTiming().iterations !== Infinity,
    );
    await Promise.all(finiteAnimations.map((animation) => animation.finished.catch(() => undefined)));
  });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      targets: violation.nodes.flatMap((node) => node.target),
    })), `${context} serious or critical axe violations`).toEqual([]);
}

test("deep links survive reload and browser back navigation", async ({ page }) => {
  const deepLink = "/?view=workspace&agreement=1&tab=details";
  let evaluationRelationshipRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/agreements/1/relationships") evaluationRelationshipRequests += 1;
  });
  await openEvaluationWorkspace(page, deepLink);

  await expect(page.getByRole("heading", { name: "Helio Systems" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Contract details" })).toHaveAttribute("aria-selected", "true");
  const relationshipPanel = page.locator(".relationship-panel");
  await expect(relationshipPanel.getByRole("status")).toContainText("Evaluation relationship sample");
  await expect(relationshipPanel.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".agreement-custom-fields")).toHaveCount(0);
  await expect(page).toHaveURL(/view=workspace&agreement=1&tab=details/);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Helio Systems" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Contract details" })).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "Approvals" }).click();
  await expect(page.getByRole("heading", { name: "Approval without the chase." })).toBeVisible();
  await expect(page).toHaveURL(/view=approvals/);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Helio Systems" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Contract details" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/view=workspace&agreement=1&tab=details/);
  expect(evaluationRelationshipRequests).toBe(0);
});

test("persisted evaluation records that reuse a sample ID keep durable workspace behavior", async ({ page }) => {
  const persistedAgreement = {
    id: 1,
    version: 3,
    party: "Persisted Legacy One",
    initials: "PL",
    side: "Sell-side",
    type: "Services Agreement",
    value: 1_250,
    valueMinor: 125_000,
    currencyCode: "USD",
    stage: "Review",
    owner: "Evaluation administrator",
    ownerUserId: "evaluation-admin",
    nextAction: "Review saved agreement",
    due: "This week",
    crm: "None",
    crmRecord: "",
    tags: ["Persisted record"],
    updated: "Just now",
    updatedAt: "2026-08-20T16:00:00.000Z",
    department: "Legal",
    risk: "Low",
    approvalStatus: "Required",
    signatureStatus: "Not sent",
    effectiveDate: "",
    expirationDate: "",
  };
  const firstPageAgreement = {
    ...persistedAgreement,
    id: 99,
    party: "First Page Record",
    initials: "FP",
    updatedAt: "2026-08-20T16:01:00.000Z",
  };
  let relationshipRequests = 0;
  await page.route("**/api/agreements**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    if (url.pathname === "/api/agreements") {
      const continuation = url.searchParams.get("cursor");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: continuation
          ? { agreements: [persistedAgreement], totalMatched: 2, nextCursor: null, hasMore: false }
          : { agreements: [firstPageAgreement], totalMatched: 2, nextCursor: "page-two", hasMore: true },
      });
      return;
    }
    if (url.pathname === "/api/agreements/1/relationships") {
      relationshipRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", json: { parties: [], relationships: [], truncated: false } });
      return;
    }
    if (url.pathname === "/api/agreements/1/versions") {
      await route.fulfill({ status: 200, contentType: "application/json", json: { versions: [], sourceDocuments: [], workflowBasis: null } });
      return;
    }
    await route.continue();
  });
  await page.route("**/api/admin/configuration/custom-field**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: pathname.endsWith("custom-field-values") ? { customFieldValues: [] } : { customFields: [] },
    });
  });

  await openEvaluationWorkspace(page, "/?view=workspace&agreement=1&tab=details");
  await expect(page.getByRole("heading", { name: "Helio Systems" })).toBeVisible();
  await expect(page.locator(".relationship-panel").getByText("Evaluation relationship sample")).toBeVisible();
  await page.getByRole("button", { name: "Back to Contracts", exact: true }).click();
  await page.getByRole("button", { name: "Load more agreements" }).click();
  await page.getByRole("button", { name: "Open Persisted Legacy One" }).click();
  await expect(page.getByRole("heading", { name: "Persisted Legacy One" })).toBeVisible();
  await page.getByRole("tab", { name: "Contract details" }).click();
  const relationshipPanel = page.locator(".relationship-panel");
  await expect(relationshipPanel.getByText("Evaluation relationship sample")).toHaveCount(0);
  await expect(relationshipPanel.locator(".relationship-columns")).toBeVisible();
  await expect(relationshipPanel.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".agreement-custom-fields")).toBeVisible();
  await expect(page.locator(".details-side")).not.toContainText("Maya Chen");
  await expect(page.locator(".details-side")).not.toContainText("Confirm usage true-up");
  await expect.poll(() => relationshipRequests).toBe(1);
});

test("the agreement register queries the full estate and keeps continuation cursors bound to that query", async ({ page }) => {
  const agreement = (id: number, party: string, valueMinor: number, currencyCode: string, updatedAt: string) => ({
    id,
    version: 1,
    party,
    initials: party.split(" ").map((word) => word[0]).join("").slice(0, 2),
    side: "Sell-side",
    type: "Services Agreement",
    value: Math.round(valueMinor / 100),
    valueMinor,
    currencyCode,
    stage: "Review",
    owner: "Evaluation administrator",
    nextAction: "Review agreement",
    due: "This week",
    crm: "None",
    crmRecord: "",
    tags: ["Pagination fixture"],
    updated: "Just now",
    updatedAt,
    department: "Legal",
    risk: "Low",
    approvalStatus: "Required",
    signatureStatus: "Not sent",
    effectiveDate: "",
    expirationDate: "",
  });
  const firstAgreement = agreement(90_101, "First Saved Page", 10_005, "USD", "2026-08-19T16:00:00.000Z");
  const secondAgreement = {
    ...agreement(90_102, "Second Saved Page", 12_345, "EUR", "2026-08-20T16:00:00.000Z"),
    side: "Buy-side",
    risk: "High",
  };
  let pageAttempts = 0;
  const fullRegisterSearch = { q: "", side: "", stage: "", risk: "", sort: "", hasCursor: true };
  await page.route("**/api/agreements**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const url = new URL(route.request().url());
    if (url.searchParams.get("q") === "Second Saved Page") {
      fullRegisterSearch.q = url.searchParams.get("q") ?? "";
      fullRegisterSearch.side = url.searchParams.get("side") ?? "";
      fullRegisterSearch.stage = url.searchParams.get("stage") ?? "";
      fullRegisterSearch.risk = url.searchParams.get("risk") ?? "";
      fullRegisterSearch.sort = url.searchParams.get("sort") ?? "";
      fullRegisterSearch.hasCursor = url.searchParams.has("cursor");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { agreements: [secondAgreement], totalMatched: 1, nextCursor: null, hasMore: false },
      });
      return;
    }
    if (!url.searchParams.has("cursor")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: { agreements: [firstAgreement], totalMatched: 2, nextCursor: "opaque-page-two", hasMore: true },
      });
      return;
    }
    pageAttempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (pageAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        json: { error: { code: "fixture_failure", message: "Synthetic continuation failure." } },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { agreements: [firstAgreement, secondAgreement], totalMatched: 2, nextCursor: null, hasMore: false },
    });
  });

  await openEvaluationWorkspace(page, "/?view=agreements");
  const register = page.locator(".agreements-card");
  await expect(register).toContainText("Loaded 1 of 2 matching saved agreements");
  await expect(page.locator(".portfolio-strip")).toContainText("Loaded workspace records · 1 of 2 saved agreements");

  const search = page.getByRole("textbox", { name: "Search agreement register" });
  await search.fill("Second Saved Page");
  await expect(register).toContainText("1 saved match");
  await expect(register.locator(".agreement-row").filter({ hasText: "Second Saved Page" })).toContainText("€123.45");
  await page.getByLabel("Filter by contract direction").selectOption("Buy-side");
  await page.getByLabel("Filter by stage").selectOption("Review");
  await page.getByLabel("Filter by risk").selectOption("High");
  await page.getByLabel("Sort agreements").selectOption("Value");
  await expect.poll(() => fullRegisterSearch.sort).toBe("Value");
  expect(fullRegisterSearch.q).toBe("Second Saved Page");
  expect(fullRegisterSearch.side).toBe("Buy-side");
  expect(fullRegisterSearch.stage).toBe("Review");
  expect(fullRegisterSearch.risk).toBe("High");
  expect(fullRegisterSearch.hasCursor).toBe(false);
  await register.getByRole("button", { name: "Reset" }).click();
  await expect(register.getByRole("button", { name: "Load more agreements" })).toBeVisible();

  await register.getByRole("button", { name: "Load more agreements" }).click();
  await expect(register.getByRole("alert")).toContainText("Synthetic continuation failure.");
  await register.getByRole("button", { name: "Retry" }).click();
  await expect(register).toContainText("Loading more agreements…");
  await expect(register).toContainText("All 2 matching saved agreements are loaded");
  await expect(register.locator(".agreement-row").filter({ hasText: "First Saved Page" })).toHaveCount(1);
  await expect(register.locator(".agreement-row").filter({ hasText: "Second Saved Page" })).toHaveCount(1);
  await expect(register.getByRole("button", { name: "Load more agreements" })).toHaveCount(0);

  await register.getByRole("button", { name: "Open Helio Systems" }).click();
  await expect(page.getByRole("heading", { name: "Helio Systems" })).toBeVisible();
  await expect(page).toHaveURL(/view=workspace&agreement=1/);
});

test("320px and 375px layouts do not create page-level horizontal overflow", async ({ page }) => {
  const views = [
    { path: "/", ready: /contracts? need(s)? a next move|No contracts need a next move/ },
    { path: "/?view=approvals", ready: "Approval without the chase." },
    { path: "/?view=workspace&agreement=1&tab=details", ready: "Helio Systems" },
  ] as const;

  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 });
    for (const view of views) {
      await openEvaluationWorkspace(page, view.path);
      await expect(page.getByRole("heading", { name: view.ready })).toBeVisible();
      await expectNoViewportOverflow(page);
    }
  }
});

test("contract paper and horizontal data regions remain accessible on desktop and mobile", async ({ page }) => {
  test.setTimeout(60_000);
  for (const viewport of [{ width: 1_280, height: 900 }, { width: 320, height: 812 }]) {
    await page.setViewportSize(viewport);
    await openEvaluationWorkspace(page, "/?view=workspace&agreement=1&tab=document");

    const stages = page.getByRole("region", { name: /Contract lifecycle stages\. Current stage:/ });
    await expect(stages).toHaveAttribute("tabindex", "0");
    await page.locator(".agreement-actions button:not(:disabled)").last().focus();
    await page.keyboard.press("Tab");
    await expect(stages).toBeFocused();
    const stageGeometry = await stages.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    if (viewport.width === 320) {
      expect(stageGeometry.scrollWidth).toBeGreaterThan(stageGeometry.clientWidth);
      expect(["auto", "scroll"]).toContain(stageGeometry.overflowX);
    }

    const sampleChanges = page.getByRole("button", { name: /Sample changes visible|Show sample changes/ });
    await expect(sampleChanges).toBeVisible();
    if (await sampleChanges.getAttribute("aria-pressed") !== "true") await sampleChanges.click();
    await expect(page.locator(".contract-paper del").first()).toBeVisible();
    await expect(page.locator(".paper-top")).toBeVisible();
    await expect(page.locator(".signature-lines span").first()).toBeVisible();
    await expect(page.locator(".contract-paper > footer")).toBeVisible();
    await expectNoMaterialAxeViolations(page, `${viewport.width}px contract paper and stage rail`);

    await openEvaluationWorkspace(page, "/?view=integrations");
    const fieldMap = page.getByRole("region", { name: "Canonical CRM projection field map" });
    await expect(fieldMap).toHaveAttribute("tabindex", "0");
    await page.locator(".integration-card > button:not(:disabled)").last().focus();
    await page.keyboard.press("Tab");
    await expect(fieldMap).toBeFocused();
    const mapGeometry = await fieldMap.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    if (viewport.width === 320) {
      expect(mapGeometry.scrollWidth).toBeGreaterThan(mapGeometry.clientWidth);
      expect(["auto", "scroll"]).toContain(mapGeometry.overflowX);
    }
    await expectNoMaterialAxeViolations(page, `${viewport.width}px CRM projection field map`);
  }
});

test("mobile navigation traps focus, makes content inert, and restores focus", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openEvaluationWorkspace(page);

  const opener = page.locator('button[aria-label="Open navigation"]');
  const navigation = page.getByRole("dialog", { name: "Product navigation" });
  const close = page.getByRole("button", { name: "Close navigation" });
  const content = page.locator(".clm-main");

  await opener.click();
  await expect(opener).toHaveAttribute("aria-expanded", "true");
  await expect(navigation).toHaveAttribute("aria-modal", "true");
  await expect(close).toBeFocused();
  expect(await content.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await expect(content).toHaveAttribute("aria-hidden", "true");
  await expectNoMaterialAxeViolations(page, "mobile navigation");

  const firstNavigationButton = navigation.locator("button:visible").first();
  const lastNavigationButton = navigation.locator("button:visible").last();
  await lastNavigationButton.focus();
  await page.keyboard.press("Tab");
  await expect(firstNavigationButton).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(lastNavigationButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(opener).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#product-navigation")).toHaveAttribute("aria-hidden", "true");
  expect(await content.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  await expect(content).not.toHaveAttribute("aria-hidden", "true");
  await expect(opener).toBeFocused();
});

test("320px and 375px navigation scrolls to every destination and clause filters stay usable", async ({ page }) => {
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 568 });
    await openEvaluationWorkspace(page);

    await page.getByRole("button", { name: "Open navigation" }).click();
    const navigation = page.getByRole("dialog", { name: "Product navigation" });
    const setup = navigation.getByRole("button", { name: "Setup & access" });
    await setup.scrollIntoViewIfNeeded();
    const geometry = await navigation.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(["auto", "scroll"]).toContain(geometry.overflowY);
    const setupBox = await setup.boundingBox();
    expect(setupBox).not.toBeNull();
    expect(setupBox!.y + setupBox!.height).toBeLessThanOrEqual(568);
    await expectNoMaterialAxeViolations(page, `${width}px fully scrolled navigation`);

    await page.keyboard.press("Escape");
    await openEvaluationWorkspace(page, "/?view=library");
    const filters = page.locator(".library-filters");
    await expect(filters).toBeVisible();
    await expect(filters.getByRole("button", { name: /All language/ })).toBeVisible();
    await expect(filters.getByRole("button", { name: /Data & security/ })).toBeVisible();
    await filters.getByRole("button", { name: /Risk/ }).click();
    await expect(filters.getByRole("button", { name: /Risk/ })).toHaveAttribute("aria-pressed", "true");
    await expectNoViewportOverflow(page);
    await expectNoMaterialAxeViolations(page, `${width}px clause filters`);
  }
});

test("portfolio work shows loading, error, retry, and empty states without false zeroes", async ({ page }) => {
  let workAttempts = 0;
  await page.route("**/api/reports/portfolio?**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        generatedAt: "2026-08-20T12:00:00.000Z",
        asOfDate: "2026-08-20",
        portfolio: {
          agreements: 3,
          stages: [{ key: "Review", count: 3 }],
          risks: [{ key: "Low", count: 3 }],
          currencies: [{ currencyCode: "USD", agreements: 3, valueMinor: "900719925474099300" }],
          renewals: { through: "2026-11-18", count: 1 },
        },
        work: {
          approvals: { pending: 0, overdue: 0, changesRequested: 0 },
          signatures: [],
          obligations: { open: 0, overdue: 0, complete: 0 },
          obligationSchedules: [],
        },
      },
    });
  });
  await page.route("**/api/work-items?**", async (route) => {
    workAttempts += 1;
    if (workAttempts === 1) {
      await route.fulfill({ status: 503, contentType: "application/json", json: { error: { message: "Synthetic queue outage." } } });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: { items: [], page: { hasMore: false, nextCursor: null, snapshotAt: "2026-08-20T12:00:00.000Z" }, summary: { totalMatched: 0, totalMatchedCapped: false, statusCounts: [] } },
    });
  });

  await openEvaluationWorkspace(page, "/?view=portfolio");
  await expect(page.getByRole("heading", { name: "Decisions first. Portfolio context right behind them." })).toBeVisible();
  await expect(page.locator(".portfolio-report .enterprise-state.loading")).toContainText("Building portfolio insights");
  await expect(page.locator(".portfolio-kpis")).toHaveCount(0);
  const queue = page.locator(".enterprise-work-priority");
  await expect(queue.getByRole("alert")).toContainText("Synthetic queue outage.");
  await queue.getByRole("button", { name: "Retry" }).click();
  await expect(queue.getByText("This queue is clear")).toBeVisible();
  await expect(page.locator(".portfolio-kpis")).toContainText("3");
  await expect(page.locator(".portfolio-breakdowns")).toContainText("USD 9,007,199,254,740,993.00");

  const queueTabs = queue.getByRole("tablist", { name: "Work queue type" });
  await expect(queueTabs).toHaveAttribute("aria-orientation", "horizontal");
  const tabs = queueTabs.getByRole("tab");
  await expect(tabs).toHaveCount(5);
  for (let index = 0; index < await tabs.count(); index += 1) {
    const tab = tabs.nth(index);
    const tabId = await tab.getAttribute("id");
    const controls = await tab.getAttribute("aria-controls");
    expect(tabId).toBeTruthy();
    expect(controls).toBeTruthy();
    const panel = page.locator(`#${controls}`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute("aria-labelledby", tabId!);
    await expect(tab).toHaveAttribute("tabindex", index === 0 ? "0" : "-1");
  }
  const approvalsTab = queueTabs.getByRole("tab", { name: /^Approvals/ });
  const signaturesTab = queueTabs.getByRole("tab", { name: /^Signatures/ });
  const historyTab = queueTabs.getByRole("tab", { name: /^History/ });
  await approvalsTab.focus();
  await approvalsTab.press("ArrowRight");
  await expect(signaturesTab).toBeFocused();
  await expect(signaturesTab).toHaveAttribute("aria-selected", "true");
  await expect(signaturesTab).toHaveAttribute("tabindex", "0");
  await expect(queue.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "work-queue-tab-signatures");
  await signaturesTab.press("End");
  await expect(historyTab).toBeFocused();
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await historyTab.press("Home");
  await expect(approvalsTab).toBeFocused();
  await expect(approvalsTab).toHaveAttribute("aria-selected", "true");
  await approvalsTab.press("ArrowLeft");
  await expect(historyTab).toBeFocused();
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await expectNoMaterialAxeViolations(page, "portfolio loading/error/empty states");
});

test("enterprise setup tabs are keyboard complete and mobile OCR profile evidence stays accessible", async ({ page }) => {
  await page.route("**/api/admin/integrations", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        integrations: [
          {
            id: "docuseal",
            label: "DocuSeal e-signature",
            provider: "docuseal",
            configured: true,
            required: true,
            testable: true,
            detail: "Production configuration is complete.",
            lastTest: { status: "passed", testedAt: "2026-08-20T12:00:00.000Z", detail: "DocuSeal compatibility verified." },
            selectedOcrProfile: null,
          },
          {
            id: "scanner",
            label: "Document scanning",
            provider: "custom_gateway",
            configured: true,
            required: true,
            testable: true,
            detail: "Signed customer-hosted scanner gateway is configured.",
            lastTest: { status: "passed", testedAt: "2026-08-20T12:00:00.000Z", detail: "Scanner gateway access verified." },
            selectedOcrProfile: {
              execution: "customer-hosted-scanner-gateway",
              modelId: "acme-vision-v2",
              profileId: "contracts-en-v1",
            },
          },
        ],
      },
    });
  });

  await page.setViewportSize({ width: 1_280, height: 900 });
  await openEvaluationWorkspace(page, "/?view=admin&section=readiness");
  const setup = page.locator(".enterprise-setup-center");
  const setupTabs = setup.getByRole("tablist", { name: "Enterprise setup sections" });
  await expect(setupTabs).toHaveAttribute("aria-orientation", "horizontal");
  const tabs = setupTabs.getByRole("tab");
  await expect(tabs).toHaveCount(11);
  for (let index = 0; index < await tabs.count(); index += 1) {
    const tab = tabs.nth(index);
    const tabId = await tab.getAttribute("id");
    const controls = await tab.getAttribute("aria-controls");
    expect(tabId).toBeTruthy();
    expect(controls).toBeTruthy();
    const panel = setup.locator(`#${controls}`);
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute("aria-labelledby", tabId!);
    await expect(tab).toHaveAttribute("tabindex", index === 0 ? "0" : "-1");
  }

  const readinessTab = setupTabs.getByRole("tab", { name: /^Readiness/ });
  const entitiesTab = setupTabs.getByRole("tab", { name: /^Entities/ });
  const agentsTab = setupTabs.getByRole("tab", { name: /^Agent governance/ });
  await readinessTab.focus();
  await readinessTab.press("ArrowRight");
  await expect(entitiesTab).toBeFocused();
  await expect(entitiesTab).toHaveAttribute("aria-selected", "true");
  await expect(entitiesTab).toHaveAttribute("tabindex", "0");
  await expect(page).toHaveURL(/view=admin&section=entities/);
  await expect(setup.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "enterprise-setup-tab-entities");
  await entitiesTab.press("End");
  await expect(agentsTab).toBeFocused();
  await expect(agentsTab).toHaveAttribute("aria-selected", "true");
  await agentsTab.press("Home");
  await expect(readinessTab).toBeFocused();
  await expect(readinessTab).toHaveAttribute("aria-selected", "true");
  await readinessTab.press("ArrowLeft");
  await expect(agentsTab).toBeFocused();
  await expect(agentsTab).toHaveAttribute("aria-selected", "true");

  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 812 });
    await openEvaluationWorkspace(page, "/?view=admin&section=readiness");
    await page.getByRole("button", { name: "↻ Refresh evidence" }).click();
    const mobileSetup = page.locator(".enterprise-setup-center");
    const mobileTabs = mobileSetup.getByRole("tablist", { name: "Enterprise setup sections" });
    const scannerProvider = page.locator(".provider-list article").filter({ hasText: "Document scanning" });
    await expect(scannerProvider).toContainText("Customer-hosted OCR via signed gateway");
    await expect(scannerProvider.locator("code")).toHaveText(["acme-vision-v2", "contracts-en-v1"]);
    const tabGeometry = await mobileTabs.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(tabGeometry.scrollWidth).toBeGreaterThan(tabGeometry.clientWidth);
    expect(["auto", "scroll"]).toContain(tabGeometry.overflowX);
    await expectNoViewportOverflow(page);
    await expectNoMaterialAxeViolations(page, `${width}px enterprise setup with customer-hosted OCR`);
  }
});

test("URL-addressable enterprise setup creates and versions governed paper", async ({ page }) => {
  const templateId = "6f32a952-85b8-4a17-9d6f-4ffcf9f33ee6";
  const versionIds = ["7f32a952-85b8-4a17-9d6f-4ffcf9f33ee7", "8f32a952-85b8-4a17-9d6f-4ffcf9f33ee8"];
  const templates: Array<Record<string, unknown>> = [];
  const versions: Array<Record<string, unknown>> = [];
  let initialAttemptKey = "";
  let initialAttempts = 0;
  const playbookId = "9f32a952-85b8-4a17-9d6f-4ffcf9f33ee9";
  const playbookVersionId = "af32a952-85b8-4a17-9d6f-4ffcf9f33eea";
  const playbooks: Array<Record<string, unknown>> = [];
  const playbookVersions: Array<Record<string, unknown>> = [];
  let playbookAttemptKey = "";
  let playbookAttempts = 0;

  await page.route("**/api/admin/configuration/templates*", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: { templates, versions } });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    if (request.method() === "POST" && body.action === "create_with_version") {
      initialAttempts += 1;
      const idempotencyKey = request.headers()["idempotency-key"] ?? "";
      expect(idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if (initialAttempts > 1) expect(idempotencyKey).toBe(initialAttemptKey);
      else initialAttemptKey = idempotencyKey;
      const template = { id: templateId, version: 1, name: body.name, description: body.description, agreementType: body.agreementType, side: body.side, status: "draft", currentPublishedVersion: null, createdByUserId: "fixture-admin" };
      const version = { id: versionIds[0], templateId, version: 1, status: "draft", body: body.body, variableSchema: body.variableSchema, contentSha256: "a".repeat(64), changeSummary: body.changeSummary, createdByUserId: "fixture-admin" };
      if (initialAttempts === 1) {
        templates.push(template);
        versions.push(version);
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "Idempotency-Replayed": "true" }, json: { template: templates[0], templateVersion: versions[0], replay: true } });
      return;
    }
    if (request.method() === "POST" && body.action === "create_version") {
      const semanticVersion = versions.length + 1;
      const version = { id: versionIds[semanticVersion - 1], templateId, version: semanticVersion, status: "draft", body: body.body, variableSchema: body.variableSchema, contentSha256: String.fromCharCode(96 + semanticVersion).repeat(64), changeSummary: body.changeSummary, createdByUserId: "fixture-admin" };
      versions.push(version);
      templates[0]!.version = Number(templates[0]!.version) + 1;
      await route.fulfill({ status: 201, contentType: "application/json", json: { templateVersion: version } });
      return;
    }
    if (request.method() === "PATCH" && body.action === "publish_version") {
      const version = versions.find((entry) => entry.id === body.versionId)!;
      version.status = "published";
      templates[0]!.status = "published";
      templates[0]!.currentPublishedVersion = version.version;
      templates[0]!.version = Number(templates[0]!.version) + 1;
      await route.fulfill({ status: 200, contentType: "application/json", json: { template: templates[0], templateVersion: version } });
      return;
    }
    await route.fulfill({ status: 400, contentType: "application/json", json: { error: { message: "Unexpected template fixture request." } } });
  });

  await page.route("**/api/admin/configuration/playbooks*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", json: url.searchParams.has("id") ? { playbooks, versions: playbookVersions } : { playbooks } });
      return;
    }
    const body = request.postDataJSON() as Record<string, unknown>;
    if (request.method() === "POST" && body.action === "create_with_version") {
      playbookAttempts += 1;
      const idempotencyKey = request.headers()["idempotency-key"] ?? "";
      expect(idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      if (playbookAttempts > 1) expect(idempotencyKey).toBe(playbookAttemptKey);
      else playbookAttemptKey = idempotencyKey;
      const playbook = { id: playbookId, version: 1, name: body.name, description: body.description, scope: body.scope, status: "draft", currentPublishedVersion: null, createdByUserId: "fixture-admin" };
      const playbookVersion = { id: playbookVersionId, playbookId, version: 1, status: "draft", rules: body.rules, contentSha256: "b".repeat(64), changeSummary: body.changeSummary, createdByUserId: "fixture-admin" };
      if (playbookAttempts === 1) {
        playbooks.push(playbook);
        playbookVersions.push(playbookVersion);
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "Idempotency-Replayed": "true" }, json: { playbook: playbooks[0], playbookVersion: playbookVersions[0], replay: true } });
      return;
    }
    await route.fulfill({ status: 400, contentType: "application/json", json: { error: { message: "Unexpected playbook fixture request." } } });
  });

  await openEvaluationWorkspace(page, "/?view=admin&section=templates");
  const setup = page.locator(".enterprise-setup-center");
  await expect(setup.getByRole("heading", { name: "Templates", exact: true })).toBeVisible();
  await expect(setup.getByRole("tab", { name: /Templates/ })).toHaveAttribute("aria-selected", "true");
  for (const label of ["Readiness", "Entities", "Counterparties", "Groups", "Custom fields", "Templates", "Workflows", "Authorities", "Intake forms", "Playbooks", "Agent governance"]) {
    await expect(setup.getByRole("tab", { name: new RegExp(label, "i") })).toBeVisible();
  }
  await expect(page).toHaveURL(/view=admin&section=templates/);

  await setup.getByLabel("Template name *").fill("E2E governed services paper");
  await setup.getByLabel("Change summary *").fill("Initial reviewed E2E template body");
  await setup.getByRole("button", { name: "Create draft & version" }).click();
  await expect(setup.getByRole("alert")).toContainText(/fetch|network|failed/i);
  await setup.getByRole("button", { name: "Create draft & version" }).click();
  await expect(setup.getByRole("status")).toContainText("Draft template and immutable version created");
  expect(initialAttempts).toBe(2);
  await expect(setup).toContainText("E2E governed services paper");
  await expect(setup).toContainText("Draft v1");

  await setup.getByRole("button", { name: "Publish", exact: true }).click();
  await setup.getByLabel("Audit reason *").fill("Independent E2E review of the exact template digest");
  await setup.getByLabel(/I reviewed the selected record/).check();
  await setup.getByRole("button", { name: "Confirm publication" }).click();
  await expect(setup.getByRole("status")).toContainText("Governed template version published");

  await setup.getByLabel("Template task").selectOption(templateId);
  await expect(setup.getByRole("heading", { name: "Draft the next governed version" })).toBeVisible();
  await expect(setup.getByLabel("Template name *")).toBeDisabled();
  await setup.getByLabel("Template body *").fill("{{type}}\n\nRevision for {{organization}} and {{party}}.");
  await setup.getByLabel("Change summary *").fill("Second immutable governed paper version");
  await setup.getByRole("button", { name: "Create next immutable version" }).click();
  await expect(setup.getByRole("status")).toContainText("New immutable draft version created");
  await expect(setup).toContainText("Draft v2");
  await expect(setup.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
  await expectNoMaterialAxeViolations(page, "governed template create flow");

  await setup.getByRole("tab", { name: /Playbooks/ }).click();
  await expect(setup.getByRole("heading", { name: "Playbooks", exact: true })).toBeVisible();
  await setup.getByLabel("Playbook name *").fill("E2E governed liability position");
  await setup.getByRole("button", { name: "Create draft & immutable version" }).click();
  await expect(setup.getByRole("alert")).toContainText(/fetch|network|failed/i);
  await setup.getByRole("button", { name: "Create draft & immutable version" }).click();
  await expect(setup.getByRole("status")).toContainText("Draft playbook and immutable clause position created");
  expect(playbookAttempts).toBe(2);
  await expect(setup).toContainText("E2E governed liability position");
  await expect(setup).toContainText("Draft v1");
  await expectNoMaterialAxeViolations(page, "governed playbook create flow");
});

test("the account menu labels evaluation sessions and restores trigger focus on Escape", async ({ page }) => {
  await openEvaluationWorkspace(page);

  const trigger = page.getByRole("button", { name: /Open account menu for/ });
  await trigger.click();

  const menu = page.getByRole("region", { name: "Account and workspace" });
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("status")).toContainText("Evaluation session");
  await expect(menu.getByRole("status")).toContainText("No production identity session to end");
  await expect(menu.getByRole("link", { name: /Sign out of Notice/ })).toHaveCount(0);
  await expectNoMaterialAxeViolations(page, "account menu");

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});

test("an administrator can register a principal and issue an exact-resource read grant", async ({ page }, testInfo) => {
  await openEvaluationWorkspace(page);
  await page.getByRole("button", { name: "Setup & access" }).click();
  await expect(page.getByRole("heading", { name: "Govern the workspace without editing configuration files." })).toBeVisible();
  await page.getByRole("tab", { name: /Agent governance/ }).click();
  await expect(page).toHaveURL(/view=admin&section=agents/);

  const governance = page.locator(".agent-governance-admin");
  await expect(governance.getByRole("heading", { name: "Agent governance" })).toBeVisible();
  await expect(governance).toHaveAttribute("aria-busy", "false");

  const unique = `${Date.now()}-${testInfo.retry}-${crypto.randomUUID().slice(0, 8)}`;
  const principalName = `E2E read agent ${unique}`;
  const commonName = `e2e-read-${unique}.access`;
  const principalForm = governance.locator(".agent-principal-form");
  await principalForm.getByRole("textbox", { name: "Display name" }).fill(principalName);
  await principalForm.getByRole("textbox", { name: "Verified common name" }).fill(commonName);
  await principalForm.getByRole("button", { name: "Register principal" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Service principal registered without storing a bearer secret" })).toBeVisible();
  const principalRow = governance.locator(".agent-admin-list article").filter({ hasText: principalName });
  await expect(principalRow).toContainText(commonName);
  await expect(principalRow.locator(".agent-status")).toHaveText("active");

  const grantForm = governance.locator(".agent-grant-form");
  await grantForm.getByLabel("Principal").selectOption({ label: principalName });
  await grantForm.getByLabel("Agreement resource").selectOption({ label: "Helio Systems · Master Services Agreement" });
  await grantForm.getByLabel("Delegated action").selectOption({ label: "Read agreement" });
  await grantForm.getByLabel("Expires after").selectOption("1");
  await grantForm.getByRole("button", { name: "Create grant" }).click();

  await expect(page.getByRole("status").filter({ hasText: "Time-limited exact-resource agent grant created" })).toBeVisible();
  const grantRow = governance.locator(".agent-admin-list.grants article").filter({ hasText: principalName }).first();
  await expect(grantRow).toContainText("agreement.read");
  await expect(grantRow).toContainText("agreement:1");
  await expect(grantRow.locator(".agent-status")).toHaveText("active");
  await expect(governance.getByRole("heading", { name: "Human plan review inbox" })).toBeVisible();
  await expect(governance).toContainText("active principals");
  await expect(governance).toContainText("active grant records");
});

test("human agent-plan review leads with the server-compiled approval effect", async ({ page }) => {
  const planId = "1f32a952-85b8-4a17-9d6f-4ffcf9f33ee1";
  const principalId = "2f32a952-85b8-4a17-9d6f-4ffcf9f33ee2";
  const grantId = "3f32a952-85b8-4a17-9d6f-4ffcf9f33ee3";
  const planSha256 = "d".repeat(64);
  const basisHash = "b".repeat(64);
  const documentSha256 = "a".repeat(64);
  const now = "2026-08-19T12:00:00.000Z";
  const expiresAt = "2026-08-19T13:00:00.000Z";
  const summary = {
    id: planId,
    principalId,
    grantId,
    actionId: "approval.request",
    target: { type: "agreement", id: "1" },
    status: "pending_approval",
    riskTier: "high",
    planSha256,
    expectedVersion: 7,
    basisHash,
    blockers: [],
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  const proposedDiff = {
    schemaVersion: "1.0",
    actionId: "approval.request",
    mode: "ensure_required",
    input: { mode: "ensure_required", due: "2026-09-30" },
    target: {
      resourceType: "agreement",
      resourceId: "1",
      version: 7,
      basisHash,
      documentVersion: 3,
      documentSha256,
    },
    policy: {
      requiredRoles: ["Legal", "Finance"],
      currentExactBasisLanes: [{
        id: "4f32a952-85b8-4a17-9d6f-4ffcf9f33ee4",
        role: "Legal",
        status: "Approved",
        version: 2,
      }],
      missingRoles: ["Legal", "Finance"],
      obsoleteApprovalIds: ["4f32a952-85b8-4a17-9d6f-4ffcf9f33ee4"],
      reasons: [{ code: "APPROVAL_POLICY_REQUIRED_ROLES", message: "Current policy requires Legal and Finance approval lanes." }],
    },
    effect: {
      kind: "ensure_required_approval_lanes",
      noOp: false,
      willMutate: true,
      createdRoles: ["Legal", "Finance"],
      supersededApprovalIds: ["4f32a952-85b8-4a17-9d6f-4ffcf9f33ee4"],
      approvalStatus: "Pending",
      nextAction: "Complete Legal and Finance approval",
      agreementVersion: 8,
    },
    blockers: [],
  };
  const detail = {
    ...summary,
    durableStatus: "pending_approval",
    review: {
      evaluatedAt: now,
      effectiveStatus: "pending_approval",
      eligible: true,
      blockers: [],
      currentBasis: { agreementVersion: 7, basisHash, documentVersion: 3, documentSha256 },
    },
    input: { mode: "ensure_required", due: "2026-09-30" },
    inputSha256: "c".repeat(64),
    workingDocument: { version: 3, sha256: documentSha256 },
    policyVersion: "api-smoke-approval-routing-v1",
    before: { agreement: { id: 1, party: "Helio Systems", approvalStatus: "Required" } },
    proposedDiff,
    provenance: {
      servicePrincipal: { id: principalId, name: "Review fixture agent", version: 1 },
      grant: { id: grantId, policyVersion: "api-smoke-approval-routing-v1" },
      sponsor: { userId: "evaluation-user", role: "admin" },
    },
    decision: null,
    execution: null,
  };
  let recordedDecision: Record<string, unknown> | null = null;

  await page.route("**/api/admin/agent-plans?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plans: [summary], nextCursor: null }),
    });
  });
  await page.route(`**/api/v1/plans/${planId}/decisions`, async (route) => {
    recordedDecision = await route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        decision: { planId, planSha256, decision: "approved", reason: recordedDecision?.reason },
        planStatus: "approved",
      }),
    });
  });
  await page.route(`**/api/v1/plans/${planId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ plan: detail }),
    });
  });

  await openEvaluationWorkspace(page);
  await page.getByRole("button", { name: "Setup & access" }).click();
  await page.getByRole("tab", { name: /Agent governance/ }).click();
  const card = page.locator(".agent-plan-card").filter({ hasText: "approval.request" });
  await expect(card).toContainText("pending approval");
  await card.getByRole("button", { name: "Review exact plan" }).click();

  const dialog = page.getByRole("dialog", { name: "Review approval.request against the exact persisted target" });
  await expect(dialog.getByRole("heading", { name: "Ensure the policy-required approval lanes" })).toBeVisible();
  await expect(dialog).toContainText("The service principal did not choose an approver or author these effects");
  await expect(dialog).toContainText("Legal + Finance");
  await expect(dialog).toContainText("1 stale lane");
  await expect(dialog).toContainText("Agreement v8 · Complete Legal and Finance approval");

  const reason = dialog.getByRole("textbox", { name: "Decision reason *" });
  const confirmation = dialog.getByRole("checkbox");
  const approve = dialog.getByRole("button", { name: /Approve exact plan/ });
  await expectNoMaterialAxeViolations(page, "agent approval-routing plan review");
  await expect(approve).toBeDisabled();
  await reason.fill("I reviewed the exact server-derived Legal and Finance routing effect.");
  await expect(approve).toBeDisabled();
  await confirmation.check();
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(page.getByRole("status")).toContainText("Agent plan approved");
  expect(recordedDecision).toEqual({
    expectedStatus: "pending_approval",
    planDigest: planSha256,
    decision: "approved",
    reason: "I reviewed the exact server-derived Legal and Finance routing effect.",
    confirmed: true,
  });
});

test("approval decisions require both a reason and explicit review confirmation", async ({ page }) => {
  await openEvaluationWorkspace(page, "/?view=approvals");

  const card = page.locator(".approval-card").filter({ hasText: "Helio Systems" });
  await card.getByRole("button", { name: /Review & approve/ }).click();

  const dialog = page.getByRole("dialog", { name: "Review before you approve" });
  const reason = dialog.getByRole("textbox", { name: "Decision reason *" });
  const confirmation = dialog.getByRole("checkbox");
  const submit = dialog.getByRole("button", { name: /Confirm approval/ });

  await expectNoMaterialAxeViolations(page, "approval review");
  await expect(submit).toBeDisabled();
  await reason.fill("The evaluation terms and recorded review context are acceptable.");
  await expect(submit).toBeDisabled();
  await confirmation.check();
  await expect(submit).toBeEnabled();
  await confirmation.uncheck();
  await expect(submit).toBeDisabled();
  await confirmation.check();
  await submit.click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Evaluation decision and reason recorded locally");
});

test("an Unassessed agreement cannot record risk until rationale and confirmation are present", async ({ page }) => {
  const documentSha256 = "a".repeat(64);
  const basisHash = "b".repeat(64);
  const unassessedAgreement = {
    id: 5,
    version: 1,
    party: "Lumen Freight",
    initials: "LF",
    side: "Sell-side",
    type: "Mutual NDA",
    value: 0,
    stage: "Review",
    owner: "Iris Meyer",
    nextAction: "Assess risk before approval",
    due: "Friday",
    crm: "None",
    crmRecord: "",
    tags: ["Evaluation", "Risk review"],
    updated: "Just now",
    department: "Legal",
    risk: "Unassessed",
    approvalStatus: "Required",
    signatureStatus: "Not sent",
    effectiveDate: "",
    expirationDate: "",
  };
  let recordedRisk: Record<string, unknown> | null = null;
  await page.route("**/api/agreements", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = await response.json() as { agreements?: Array<{ id: number }> };
    await route.fulfill({
      response,
      json: {
        ...payload,
        agreements: [...(payload.agreements ?? []).filter((agreement) => agreement.id !== 5), unassessedAgreement],
      },
    });
  });
  await page.route("**/api/agreements/5/versions**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("version")) {
      await route.fulfill({ status: 200, contentType: "text/plain", body: "Reviewed Lumen Freight working paper." });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        versions: [{ version: 1, sha256: documentSha256 }],
        sourceDocuments: [],
        workflowBasis: {
          agreementVersion: 1,
          riskAssessment: { basisHash, documentVersion: 1, documentSha256 },
          approval: { basisHash: "c".repeat(64), documentVersion: 1, documentSha256 },
        },
      },
    });
  });
  await page.route("**/api/operations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON() as { entity?: string; action?: string; record?: Record<string, unknown> };
    if (body.entity !== "risk" || body.action !== "assess") return route.continue();
    recordedRisk = body.record ?? null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      json: {
        agreement: { ...unassessedAgreement, version: 2, risk: "Low", updated: "Just now" },
        event: { id: "risk-event-5", agreementId: 5, type: "Comment", actor: "Evaluation administrator", detail: "Recorded a low-risk assessment.", createdAt: "Just now" },
        riskBasisHash: basisHash,
      },
    });
  });

  await openEvaluationWorkspace(page, "/?view=workspace&agreement=5&tab=details");
  const editor = page.locator(".risk-assessment-editor");
  const rationale = editor.getByRole("textbox", { name: "Assessment rationale *" });
  const confirmation = editor.getByRole("checkbox");
  const submit = editor.getByRole("button", { name: "Record risk assessment" });

  await expectNoMaterialAxeViolations(page, "risk assessment");
  await expect(editor).toContainText("Current record: Unassessed");
  await expect(submit).toBeDisabled();
  await rationale.fill("The saved evaluation terms support the selected low-risk classification.");
  await expect(submit).toBeDisabled();
  await confirmation.check();
  await expect(submit).toBeEnabled();
  await submit.click();

  await expect(editor).toContainText("Current record: Low");
  await expect(page.locator(".clm-toast")).toContainText("Low risk assessment recorded against the exact saved paper");
  expect(recordedRisk).toMatchObject({
    agreementId: 5,
    agreementVersion: 1,
    level: "Low",
    rationale: "The saved evaluation terms support the selected low-risk classification.",
    basisHash,
    documentVersion: 1,
    documentSha256,
    confirmed: true,
  });
});

test("completed signed evidence cannot activate without a review reason and confirmation", async ({ page }) => {
  await page.route("**/api/agreements", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = await response.json() as { agreements?: Array<{ id: number }> };
    await route.fulfill({
      response,
      json: {
        ...payload,
        agreements: [...(payload.agreements ?? []), {
          id: 90_003,
          version: 7,
          party: "Aster Evidence Fixture",
          initials: "AE",
          side: "Sell-side",
          type: "Order Form",
          value: 96_000,
          stage: "Signature",
          owner: "Evaluation administrator",
          nextAction: "Review completed signature evidence",
          due: "Today",
          crm: "None",
          crmRecord: "",
          tags: ["Synthetic E2E evidence"],
          updated: "Just now",
          department: "Legal",
          risk: "Low",
          approvalStatus: "Approved",
          signatureStatus: "completed_review_required",
          effectiveDate: "2026-08-19",
          expirationDate: "2027-08-19",
        }],
      },
    });
  });
  await page.route("**/api/signatures**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        signaturePackets: [{
          id: "0e4a62c3-2788-4b75-8a2d-70544f4e3276",
          version: 4,
          agreementId: 90_003,
          status: "completed_review_required",
          signers: [{ role: "Counterparty", name: "Aster signer", email: "signer@aster.example", status: "completed" }],
          documentVersion: 2,
          documentSha256: "a".repeat(64),
          basisHash: "b".repeat(64),
          evidenceDocumentId: "548b7d43-e2e2-46bb-8c1e-f7dc4a59e923",
          finalArtifactSha256: "c".repeat(64),
          completedAt: "2026-08-19T12:00:00.000Z",
          activeKey: "agreement:90003",
          createdAt: "2026-08-19T11:00:00.000Z",
          updatedAt: "2026-08-19T12:00:00.000Z",
        }],
      }),
    });
  });

  await openEvaluationWorkspace(page, "/?view=signatures");
  const card = page.locator(".signature-card").filter({ hasText: "Aster Evidence Fixture" });
  await expect(card).toContainText("Evidence review required");
  await card.getByRole("button", { name: /Review signed evidence/ }).click();

  const dialog = page.getByRole("dialog", { name: "Review the final signed artifact before activation" });
  const reason = dialog.getByRole("textbox", { name: "Review reason *" });
  const confirmation = dialog.getByRole("checkbox");
  const submit = dialog.getByRole("button", { name: /Confirm review and activate/ });

  await expectNoMaterialAxeViolations(page, "signed-evidence review");
  await expect(dialog).toContainText("remains in Signature");
  await expect(submit).toBeDisabled();
  await reason.fill("I verified the final artifact, every signer, and the exact approved basis.");
  await expect(submit).toBeDisabled();
  await confirmation.check();
  await expect(submit).toBeEnabled();
  await confirmation.uncheck();
  await expect(submit).toBeDisabled();
});

test("a human can create, pause, and evidence a recurring obligation through exact gates", async ({ page }) => {
  // Keep the fixed calendar fixtures in the future without pausing UI timers.
  await page.clock.setFixedTime(new Date("2026-08-19T12:00:00.000Z"));
  type ObligationMutationFixture =
    | { entity: "obligation"; action: "create"; record: { agreementId: number; title: string; source: string; dueDate: string; ownerUserId: string; recurrence: { unit: string; interval: number; timezone: string; endDate?: string; reminderLeadDays: number[] }; confirmed: true } }
    | { entity: "obligation"; action: "reassign"; record: { scheduleId: string; version: number; newOwnerUserId: string; reason: string; includeOpenOccurrences: true; confirmed: true } }
    | { entity: "obligation"; action: "schedule_status"; record: { scheduleId: string; version: number; status: "active" | "paused" | "ended"; reason: string; confirmed: true } }
    | { entity: "obligation"; action: "complete"; record: { id: string; version: number; evidence: string; overrideReason?: string; confirmed: true } };
  const userId = "production-obligation-admin";
  const newOwnerUserId = "production-obligation-legal";
  const scheduleId = "cf49bb57-d98e-4f9f-a6b2-a16d8ccf6e16";
  const obligationId = "599fc9d8-c229-47cb-bcc0-f21d73c0c030";
  const mutations: Array<{ key?: string; body: ObligationMutationFixture }> = [];
  let schedule: Record<string, unknown> | null = null;
  let obligation: Record<string, unknown> | null = null;
  let evidence: Record<string, unknown> | null = null;
  let failFirstCreation = true;

  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        mode: "production",
        workspace: { id: "workspace-obligation-e2e", slug: "obligation-e2e", name: "Obligation E2E" },
        user: { id: userId, email: "admin@obligation-e2e.example", displayName: "Avery Admin" },
        role: "admin",
        permissions: ["agreement:read", "approval:read", "audit:read", "obligation:read", "obligation:write", "obligation:fulfill"],
      }),
    });
  });
  await page.route("**/api/agreements", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agreements: [{
        id: 90_101,
        version: 4,
        party: "Cedar Analytics",
        initials: "CA",
        side: "Buy-side",
        type: "Data Services Agreement",
        value: 72_000,
        stage: "Active",
        owner: "Avery Admin",
        nextAction: "Track post-signature work",
        due: "Current",
        crm: "None",
        crmRecord: "",
        tags: ["Production E2E"],
        updated: "Just now",
        department: "Legal",
        risk: "Low",
        approvalStatus: "Approved",
        signatureStatus: "Completed",
        effectiveDate: "2026-08-01",
        expirationDate: "2028-07-31",
      }] }),
    });
  });
  await page.route("**/api/language-blocks", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ languageBlocks: [] }) });
  });
  await page.route("**/api/signatures**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signaturePackets: [] }) });
  });
  await page.route("**/api/operations", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          approvals: [],
          obligations: obligation ? [obligation] : [],
          obligationSchedules: schedule ? [schedule] : [],
          obligationEvidence: evidence ? [evidence] : [],
          eligibleObligationOwners: [{ userId, displayName: "Avery Admin", role: "admin" }, { userId: newOwnerUserId, displayName: "Morgan Legal", role: "legal" }],
          events: [],
        }),
      });
      return;
    }
    const body = route.request().postDataJSON() as ObligationMutationFixture;
    mutations.push({ key: route.request().headers()["idempotency-key"], body });
    if (body.action === "create") {
      if (failFirstCreation) {
        failFirstCreation = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "synthetic_ambiguous_failure", message: "Synthetic ambiguous creation failure" } }) });
        return;
      }
      schedule = {
        id: scheduleId,
        agreementId: body.record.agreementId,
        version: 1,
        title: body.record.title,
        source: body.record.source,
        owner: "Avery Admin",
        ownerUserId: userId,
        timezone: body.record.recurrence.timezone,
        recurrenceUnit: body.record.recurrence.unit,
        recurrenceInterval: body.record.recurrence.interval,
        anchorDate: body.record.dueDate,
        endDate: body.record.recurrence.endDate,
        reminderLeadDays: body.record.recurrence.reminderLeadDays,
        status: "active",
        nextOccurrenceNumber: 2,
        nextOccurrenceDate: "2027-01-15",
        nextMaterializationDate: "2027-01-08",
        createdAt: "2026-08-19T12:00:00.000Z",
        updatedAt: "2026-08-19T12:00:00.000Z",
      };
      obligation = {
        id: obligationId,
        version: 1,
        agreementId: body.record.agreementId,
        scheduleId,
        occurrenceNumber: 1,
        title: body.record.title,
        dueDate: body.record.dueDate,
        owner: "Avery Admin",
        ownerUserId: userId,
        status: "Open",
        cadence: "Quarterly",
        source: body.record.source,
        timezone: body.record.recurrence.timezone,
        reminderLeadDays: body.record.recurrence.reminderLeadDays,
        nextReminderDate: "2026-12-16",
      };
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ schedule, obligation, event: { id: "event-create", agreementId: 90_101, type: "Obligation", actor: "Avery Admin", detail: "Created schedule", createdAt: "2026-08-19T12:00:00.000Z" }, replay: false }) });
      return;
    }
    if (body.action === "schedule_status") {
      schedule = { ...schedule!, status: body.record.status, version: 3, updatedAt: "2026-08-19T12:05:00.000Z" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schedule, event: { id: "event-pause", agreementId: 90_101, type: "Obligation", actor: "Avery Admin", detail: "Paused schedule", createdAt: "2026-08-19T12:05:00.000Z" } }) });
      return;
    }
    if (body.action === "reassign") {
      schedule = { ...schedule!, owner: "Morgan Legal", ownerUserId: newOwnerUserId, version: 2, updatedAt: "2026-08-19T12:03:00.000Z" };
      obligation = { ...obligation!, owner: "Morgan Legal", ownerUserId: newOwnerUserId, version: 2 };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ schedule, updatedOpenOccurrences: [obligation], event: { id: "event-reassign", agreementId: 90_101, type: "Obligation", actor: "Avery Admin", detail: "Reassigned schedule", createdAt: "2026-08-19T12:03:00.000Z" } }) });
      return;
    }
    if (body.action === "complete") {
      obligation = { ...obligation!, status: "Complete", version: 3, completionEvidence: body.record.evidence, completedByUserId: userId, completedAt: "2026-08-19T12:10:00.000Z" };
      evidence = { id: "e0c1a19d-31f4-4a1b-985a-66b41d78acec", agreementId: 90_101, obligationId, evidenceText: body.record.evidence, evidenceSha256: "a".repeat(64), submittedByUserId: userId, overrideReason: body.record.overrideReason ?? null, provenance: "native", createdAt: "2026-08-19T12:10:00.000Z" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ obligation, evidence, event: { id: "event-complete", agreementId: 90_101, type: "Obligation", actor: "Avery Admin", detail: "Completed occurrence", createdAt: "2026-08-19T12:10:00.000Z" } }) });
      return;
    }
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: { message: "Unexpected test mutation" } }) });
  });

  await openEvaluationWorkspace(page, "/?view=obligations");
  await page.getByRole("button", { name: "Add obligation schedule" }).click();
  const createDialog = page.getByRole("dialog", { name: "Turn an executed promise into owned work" });
  await createDialog.getByLabel("Obligation *").fill("Deliver quarterly usage report");
  await createDialog.getByLabel("Contract source *").fill("Order Form § 4.3 reporting");
  await createDialog.getByLabel("First due date *").fill("2026-10-15");
  await createDialog.getByLabel("Recurrence *").selectOption("quarter");
  await createDialog.getByLabel("Calendar timezone *").selectOption("America/Detroit");
  await createDialog.getByLabel("Inclusive end date (optional)").fill("2027-10-15");
  await createDialog.getByRole("checkbox", { name: "30 days before" }).check();
  const createConfirmation = createDialog.getByRole("checkbox", { name: /I reviewed the executed source/ });
  const createButton = createDialog.getByRole("button", { name: /Create schedule & occurrence/ });
  await expect(createButton).toBeDisabled();
  await createConfirmation.check();
  await expect(createButton).toBeEnabled();
  await expectNoMaterialAxeViolations(page, "recurring obligation creation");
  await createButton.click();

  await expect(createDialog).toContainText("Protected retry ready");
  await expect(page.getByRole("alert")).toContainText("Synthetic ambiguous creation failure");
  const firstCreateAttempt = mutations.find((mutation) => mutation.body.action === "create");
  expect(firstCreateAttempt?.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  await page.reload();
  await expect(page.getByRole("button", { name: "Notice home" })).toBeVisible();
  await expect(page.locator(".sync-line")).toHaveCount(0);
  await page.getByRole("button", { name: "Add obligation schedule" }).click();
  const recoveredCreateDialog = page.getByRole("dialog", { name: "Turn an executed promise into owned work" });
  await expect(recoveredCreateDialog).toContainText("Protected retry ready");
  await expect(recoveredCreateDialog.getByLabel("Obligation *")).toBeDisabled();
  await recoveredCreateDialog.getByRole("button", { name: /Retry exact schedule/ }).click();
  await expect(recoveredCreateDialog).toHaveCount(0);

  const createMutations = mutations.filter((mutation) => mutation.body.action === "create");
  expect(createMutations).toHaveLength(2);
  expect(createMutations[1].key).toBe(createMutations[0].key);
  expect(createMutations[1].body).toEqual(createMutations[0].body);
  const createMutation = createMutations[1];
  expect(createMutation?.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(createMutation?.body).toMatchObject({
    entity: "obligation",
    action: "create",
    record: {
      agreementId: 90_101,
      title: "Deliver quarterly usage report",
      source: "Order Form § 4.3 reporting",
      dueDate: "2026-10-15",
      ownerUserId: userId,
      recurrence: { unit: "month", interval: 3, timezone: "America/Detroit", endDate: "2027-10-15", reminderLeadDays: [30, 7, 0] },
      confirmed: true,
    },
  });

  const row = page.locator(".obligation-row").filter({ hasText: "Deliver quarterly usage report" });
  await expect(row).toContainText("Quarterly");
  await expect(row).toContainText("Occurrence #1");
  await row.getByRole("button", { name: "Manage schedule" }).click();
  let manageDialog = page.getByRole("dialog", { name: "Manage Deliver quarterly usage report" });
  await manageDialog.getByLabel("New eligible owner *").selectOption(newOwnerUserId);
  await manageDialog.getByRole("textbox", { name: "Schedule-change reason *" }).fill("Morgan owns the reporting relationship for the next operating period.");
  await manageDialog.getByRole("checkbox", { name: /I reviewed the schedule version/ }).check();
  await manageDialog.getByRole("button", { name: /Reassign schedule/ }).click();
  await expect(manageDialog).toHaveCount(0);
  expect(mutations.find((mutation) => mutation.body.action === "reassign")?.body).toEqual({
    entity: "obligation",
    action: "reassign",
    record: { scheduleId, version: 1, newOwnerUserId, reason: "Morgan owns the reporting relationship for the next operating period.", includeOpenOccurrences: true, confirmed: true },
  });
  await expect(row).toContainText("Morgan Legal");

  await row.getByRole("button", { name: "Manage schedule" }).click();
  manageDialog = page.getByRole("dialog", { name: "Manage Deliver quarterly usage report" });
  await manageDialog.getByRole("button", { name: "Pause future work", exact: true }).first().click();
  await expect(manageDialog).toContainText("Existing open occurrences are unaffected");
  await manageDialog.getByRole("textbox", { name: "Schedule-change reason *" }).fill("Reporting is paused during the approved service suspension.");
  await manageDialog.getByRole("checkbox", { name: /I reviewed the schedule version/ }).check();
  await manageDialog.locator(".wizard-actions").getByRole("button", { name: /Pause future work/ }).click();
  await expect(manageDialog).toHaveCount(0);
  expect(mutations.find((mutation) => mutation.body.action === "schedule_status")?.body).toEqual({
    entity: "obligation",
    action: "schedule_status",
    record: { scheduleId, version: 2, status: "paused", reason: "Reporting is paused during the approved service suspension.", confirmed: true },
  });
  await expect(row).toContainText("paused");

  await row.getByRole("button", { name: "Override & complete" }).click();
  const completeDialog = page.getByRole("dialog", { name: "Review before completing Deliver quarterly usage report" });
  const completeButton = completeDialog.getByRole("button", { name: "Mark complete with evidence" });
  await completeDialog.getByLabel("Completion evidence *").fill("Usage report delivered through customer portal; ticket OPS-417 confirms receipt.");
  await completeDialog.getByLabel("Override reason *").fill("Avery verified delivery while the assigned owner was unavailable.");
  await expect(completeButton).toBeDisabled();
  await completeDialog.getByRole("checkbox", { name: /I reviewed this exact dated occurrence/ }).check();
  await completeButton.click();
  expect(mutations.find((mutation) => mutation.body.action === "complete")?.body).toEqual({
    entity: "obligation",
    action: "complete",
    record: { id: obligationId, version: 2, evidence: "Usage report delivered through customer portal; ticket OPS-417 confirms receipt.", overrideReason: "Avery verified delivery while the assigned owner was unavailable.", confirmed: true },
  });
  const evidenceDialog = page.getByRole("dialog", { name: "Recorded completion evidence" });
  await expect(evidenceDialog).toContainText("OPS-417 confirms receipt");
  await expect(evidenceDialog).toContainText("a".repeat(64));
  await evidenceDialog.getByRole("button", { name: "Close evidence" }).click();

  await page.setViewportSize({ width: 320, height: 812 });
  await expectNoViewportOverflow(page);
});

test("the evaluation routes have no serious or critical axe violations", async ({ page }) => {
  test.setTimeout(120_000);
  const materialViolations = [] as Array<{
    path: string;
    id: string;
    impact: string | null | undefined;
    targets: Array<string | string[]>;
  }>;
  const paths = [
    "/",
    "/?view=portfolio",
    "/?view=agreements",
    "/?view=intake",
    "/?view=approvals",
    "/?view=signatures",
    "/?view=obligations",
    "/?view=repository",
    "/?view=templates",
    "/?view=library",
    "/?view=integrations",
    "/?view=admin",
    "/?view=admin&section=groups",
    "/?view=admin&section=templates",
    "/?view=admin&section=playbooks",
    "/?view=workspace&agreement=1&tab=details",
  ];

  for (const path of paths) {
    await openEvaluationWorkspace(page, path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    materialViolations.push(...results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        path,
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.flatMap((node) => node.target),
      })));
    if (path === "/?view=agreements") {
      const helioRow = page.getByRole("row").filter({ hasText: "Helio Systems" });
      const selection = helioRow.getByRole("checkbox", { name: "Select Helio Systems" });
      await selection.check();
      await expect(selection).toBeChecked();
      await selection.uncheck();
      await helioRow.getByRole("button", { name: "Open Helio Systems" }).click();
      await expect(page.getByRole("heading", { name: "Helio Systems" })).toBeVisible();
    }
  }
  expect(materialViolations).toEqual([]);
});
