import { describe, expect, mock, test } from "bun:test";

import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";

import en from "@/i18n/messages/en.json";
import { MobileNav } from "./mobile-nav";

// The menu is a native <details>; its links navigate with next/link, which
// re-renders the page in place and leaves the <details> open over the new
// page. The close handler is client-only (capture-phase click), so this
// pins the structure the handler relies on: the details wrapper, an anchor
// per nav item, and the data attributes the handler's closest() lookup
// walks.
//
// The mobile header is the small screen's only navigation, so a menu that
// stays open after navigation hides every page until dismissed — that is
// the regression this guards.
mock.module("server-only", () => ({}));

describe("MobileNav", () => {
  test("renders a details menu whose links are anchors inside it", () => {
    // MobileHeaderSettings inside the menu calls useTranslations; the
    // provider wires that the same way the locale layout does.
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        <MobileNav
          items={[
            { href: "/pets", label: "Pets" },
            { href: "/docs", label: "Docs" },
          ]}
          githubItem={{
            href: "https://github.com/crafter-station/petdex",
            label: "GitHub",
          }}
          submitHref="/submit"
          submitLabel="Submit"
          openMenuLabel="Open menu"
          hideSubmitCta={false}
        />
      </NextIntlClientProvider>,
    );

    expect(html).toContain("<details");
    // Every nav item must be an <a> inside the details — the close-on-
    // navigate handler closes only when the click lands inside one.
    const end = html.indexOf("</details>");
    const menu = html.slice(
      html.indexOf("<details"),
      end === -1 ? undefined : end + 10,
    );
    expect(menu).toContain('href="/pets"');
    expect(menu).toContain('href="/docs"');
    expect(menu).toContain('href="/submit"');
  });
});
