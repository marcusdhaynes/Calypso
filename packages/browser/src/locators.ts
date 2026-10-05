import type { Locator, Page } from "playwright";
import type { DomLocator } from "@calypso/shared";

/** Resolve a contract DomLocator to a Playwright Locator. Prefer role/name over css. */
export function resolveLocator(page: Page, locator: DomLocator): Locator {
  switch (locator.kind) {
    case "role":
      return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], {
        name: locator.name,
      });
    case "label":
      return page.getByLabel(locator.label);
    case "text":
      return page.getByText(locator.text);
    case "testId":
      return page.getByTestId(locator.testId);
    case "css":
      return page.locator(locator.selector);
    case "xpath":
      return page.locator(`xpath=${locator.xpath}`);
    default: {
      const _exhaustive: never = locator;
      throw new Error(`Unknown DomLocator: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
