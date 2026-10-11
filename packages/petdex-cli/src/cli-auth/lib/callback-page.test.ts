import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CallbackFailureReason,
  callbackStringsByLocale,
  clampDetail,
  defaultAppUrl,
  escapeHtml,
  LOCALES_FOR_TEST,
  renderCallbackPage,
  safeJson,
} from "./callback-page";

const REASONS: CallbackFailureReason[] = [
  "authorization_denied",
  "state_mismatch",
  "missing_code",
  "token_exchange_failed",
  "userinfo_failed",
  "storage_failed",
  "timeout",
  "closed",
];

const APP_URL = "https://petdex.dev";

function successPage(): string {
  return renderCallbackPage({ kind: "success" }, APP_URL);
}

function errorPage(reason: CallbackFailureReason): string {
  return renderCallbackPage({ kind: "error", reason }, APP_URL);
}

describe("callback page strings", () => {
  test("every locale carries the same keys", () => {
    const strings = callbackStringsByLocale();
    const reference = Object.keys(strings.en).sort();
    for (const locale of LOCALES_FOR_TEST) {
      expect(Object.keys(strings[locale]).sort()).toEqual(reference);
      expect(Object.keys(strings[locale].reason).sort()).toEqual(
        [...REASONS].sort(),
      );
    }
  });

  test("no translation is left empty", () => {
    const strings = callbackStringsByLocale();
    for (const locale of LOCALES_FOR_TEST) {
      const entry = strings[locale];
      expect(entry.eyebrow.length).toBeGreaterThan(0);
      expect(entry.successTitle.length).toBeGreaterThan(0);
      for (const reason of REASONS) {
        expect(entry.reason[reason].length).toBeGreaterThan(0);
      }
    }
  });

  test("each failure reason reads differently", () => {
    const { reason } = callbackStringsByLocale().en;
    const seen = new Set<string>();
    for (const key of REASONS) seen.add(reason[key]);
    expect(seen.size).toBe(REASONS.length);
  });
});

describe("callback page document", () => {
  test("declares a viewport so the card is readable on a phone", () => {
    const html = successPage();
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  test("carries a lang attribute for the script to correct", () => {
    expect(successPage()).toContain('<html lang="en">');
  });

  test("inlines the brand mark", () => {
    const html = successPage();
    expect(html).toContain("<svg");
    expect(html).toContain('id="petdex-body"');
  });

  test("never assigns innerHTML", () => {
    expect(successPage()).not.toContain("innerHTML");
    expect(errorPage("timeout")).not.toContain("innerHTML");
  });

  test("requests nothing from the network", () => {
    const html = successPage();
    // The listening socket is closed the moment the page is written, so any
    // subresource would fail. The SVG namespace is a URI we never fetch, so
    // the check targets the things a browser actually resolves.
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("favicon");
    expect(html).not.toContain("@import");
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([`${APP_URL}/my-pets`]);
  });

  test("escapes the string table so it cannot break out of the JSON block", () => {
    const html = successPage();
    const match = html.match(
      /<script type="application\/json" id="i18n">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    const payload = (match as RegExpMatchArray)[1];
    expect(payload).not.toContain("<");
    const parsed = JSON.parse(payload) as {
      strings: Record<string, { title: string }>;
    };
    expect(parsed.strings.en.title).toBe(
      callbackStringsByLocale().en.successTitle,
    );
    expect(parsed.strings.zh.title).toBe(
      callbackStringsByLocale().zh.successTitle,
    );
  });
});

describe("callback page success state", () => {
  test("points the button at the profile route on the app origin", () => {
    const html = successPage();
    expect(html).toContain(`href="${APP_URL}/my-pets"`);
  });

  test("keeps the button instead of a relative link", () => {
    // A relative href would resolve against the loopback origin.
    expect(successPage()).not.toContain('href="/my-pets"');
  });

  test("trails a slash in the configured app URL without doubling it", () => {
    const html = renderCallbackPage(
      { kind: "success" },
      "https://staging.test/",
    );
    expect(html).toContain('href="https://staging.test/my-pets"');
  });

  test("refuses an app URL whose scheme is not http or https", () => {
    // The value lands in an href. `javascript:` and `data:` are valid URLs, so
    // they survive escaping and stay clickable; only the scheme tells them
    // apart from a real origin.
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      const html = renderCallbackPage({ kind: "success" }, hostile);
      expect(html).not.toContain(hostile);
      expect(html).toContain(`href="${APP_URL}/my-pets"`);
    }
  });

  test("refuses an app URL that is not a URL at all", () => {
    const html = renderCallbackPage({ kind: "success" }, "not a url");
    expect(html).toContain(`href="${APP_URL}/my-pets"`);
  });

  test("tries to close the tab after five seconds", () => {
    const html = successPage();
    expect(html).toContain("setTimeout(function () { window.close(); }, 5000)");
  });

  test("cancels that close once the reader touches anything", () => {
    const html = successPage();
    expect(html).toContain("clearTimeout(timer)");
    expect(html).toContain('"mousemove"');
    expect(html).toContain('"keydown"');
  });
});

describe("callback page error state", () => {
  test("never auto-closes, so the reason can be read", () => {
    for (const reason of REASONS) {
      expect(errorPage(reason)).not.toContain("window.close()");
    }
  });

  test("omits the profile button", () => {
    expect(errorPage("state_mismatch")).not.toContain('class="cta"');
  });

  test("gives every reason its own page", () => {
    const pages = new Set(REASONS.map((reason) => errorPage(reason)));
    expect(pages.size).toBe(REASONS.length);
  });
});

describe("callback page detail line", () => {
  test("escapes provider text", () => {
    const html = renderCallbackPage(
      { kind: "error", reason: "token_exchange_failed" },
      APP_URL,
      '<img src=x onerror="alert(1)">',
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  test("clamps a long detail", () => {
    expect(clampDetail("x".repeat(400))).toHaveLength(301);
  });

  test("leaves the line out when there is nothing to say", () => {
    expect(errorPage("timeout")).not.toContain('class="detail"');
  });
});

/**
 * Run the page's own i18n script against a minimal document.
 *
 * The string assertions elsewhere in this file only look at the markup, which
 * is how a role the script writes over — the detail line — went unnoticed:
 * the text was in the HTML and gone by the time a reader saw it. Anything
 * asserting what a reader ends up seeing has to run the script.
 */
function runPageScript(html: string, language = "en") {
  const payload =
    /<script type="application\/json" id="i18n">(.*?)<\/script>/s.exec(
      html,
    )?.[1];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  const i18nScript = scripts.find((s) => s.includes("i18n")) as string;

  const nodes: { role: string; textContent: string }[] = [];
  for (const m of html.matchAll(
    /<([a-z]+)[^>]*data-copy="([a-z]+)"[^>]*>([^<]*)/g,
  )) {
    nodes.push({ role: m[2], textContent: m[3] });
  }

  const doc = {
    documentElement: { lang: "en" },
    getElementById: (id: string) =>
      id === "i18n" ? { textContent: payload } : null,
    querySelectorAll: (sel: string) => {
      const role = /"([a-z]+)"/.exec(sel)?.[1];
      return nodes.filter((n) => n.role === role);
    },
  };
  new Function("document", "navigator", "window", i18nScript)(
    doc,
    { language },
    {},
  );
  const text = (role: string) =>
    nodes.find((n) => n.role === role)?.textContent ?? null;
  return { text, nodes };
}

describe("callback page JSON embedding", () => {
  test("escapes an angle bracket so a string cannot close the script block", () => {
    // The real tables contain no `<`, so asserting on a rendered page proves
    // nothing about the escape — delete it and the page still has no `<`.
    // This drives a hostile value through the function that guards it.
    const hostile = "</script><script>alert(1)</script>";
    const payload = safeJson({ strings: { en: { title: hostile } } });

    // No raw `<` survives, so the element cannot be closed early.
    expect(payload).not.toContain("<");
    expect(payload).toContain("\\u003c");
    // The escape is valid JSON and parses back to the original character.
    expect(JSON.parse(payload)).toEqual({
      strings: { en: { title: hostile } },
    });
  });
});

describe("callback page after its script runs", () => {
  test("keeps the detail line the server rendered", () => {
    // The script used to write an always-empty `resource` string over this
    // paragraph, so every error page showed an empty bordered rule where the
    // reason should have been.
    const html = renderCallbackPage(
      { kind: "error", reason: "timeout" },
      APP_URL,
      "OAuth callback timed out after 1200ms.",
    );
    const { nodes } = runPageScript(html);
    const detail = /<p class="detail"[^>]*>([^<]*)<\/p>/.exec(html)?.[1];

    expect(detail).toBe("OAuth callback timed out after 1200ms.");
    // Nothing the script writes may touch it: it carries no role at all.
    expect(nodes.some((n) => n.role === "resource")).toBe(false);
  });

  test("fills the success copy from the locale table", () => {
    const { text } = runPageScript(successPage());
    expect(text("title")).toBe("You're signed in");
    expect(text("cta")).toBe("Open my profile");
  });

  test("picks the locale from the browser language", () => {
    const { text } = runPageScript(successPage(), "zh-CN");
    expect(text("title")).toBe("登录成功");
  });

  test("leaves the failure page without a call to action", () => {
    // `errorCta` was written for all three locales but never rendered, so the
    // copy was dead and the link it described did not exist.
    const html = errorPage("timeout");
    expect(html).not.toContain("<a ");
    const strings = callbackStringsByLocale();
    for (const locale of LOCALES_FOR_TEST) {
      expect(strings[locale]).not.toHaveProperty("errorCta");
    }
  });
});

describe("callback page fonts", () => {
  test("inlines both faces as decodable woff2 data URIs", () => {
    // The listener is closed by the time the page renders, so the page can
    // never fetch a font file — the faces have to be inside the document. The
    // data URI is also the one thing an import assertion would silently
    // empty: `import ... with { type: "base64" }` bundles to `""` under
    // `bun build` with no warning, and the page then renders in the system
    // face with nothing failing. Decoding the payload is what catches that.
    const html = renderCallbackPage({ kind: "success" }, "https://petdex.dev");
    const uris = html.match(/data:font\/woff2;base64,[^)]+/g) ?? [];

    expect(uris).toHaveLength(2);
    for (const uri of uris) {
      const bytes = Buffer.from(uri.split(",")[1], "base64");
      // `wOF2` is the woff2 magic. A truncated or emptied payload would not
      // carry it, and a 72-byte one is what a broken wrap produces.
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(bytes.byteLength).toBeGreaterThan(4_000);
    }
  });

  test("names the site's faces before the system fallbacks", () => {
    // The stack order is what makes the CJK copy work: Geist carries no CJK
    // glyphs, so those characters have to fall through to the system face.
    const html = renderCallbackPage({ kind: "success" }, "https://petdex.dev");
    expect(html).toContain('font-family: "Geist", ui-sans-serif');
    expect(html).toContain('font-family: "Geist Mono", ui-monospace');
  });

  test("declares the colour scheme before the stylesheet", () => {
    // So the first frame is painted with the right background rather than
    // flashing the light one while the style block is parsed.
    const html = renderCallbackPage({ kind: "success" }, "https://petdex.dev");
    const meta = html.indexOf('name="color-scheme"');
    const style = html.indexOf("<style>");
    expect(meta).toBeGreaterThan(-1);
    expect(meta).toBeLessThan(style);
  });
});

describe("callback page helpers", () => {
  test("escapes the five markup-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    );
  });

  test("defaults the app URL the same way bin/petdex.ts does", () => {
    // The CLI resolves PETDEX_URL in its entrypoint; this module carries its
    // own copy because the package ships standalone. A silent divergence would
    // send staging logins to production. Resolved from this file rather than
    // the working directory, because the root suite runs from the repo root.
    const entrypoint = readFileSync(
      join(import.meta.dir, "..", "..", "..", "bin", "petdex.ts"),
      "utf8",
    );
    expect(entrypoint).toContain('"https://petdex.dev"');
    expect(defaultAppUrl({} as NodeJS.ProcessEnv)).toBe("https://petdex.dev");
    expect(
      defaultAppUrl({
        PETDEX_URL: "https://staging.test",
      } as NodeJS.ProcessEnv),
    ).toBe("https://staging.test");
  });
});
