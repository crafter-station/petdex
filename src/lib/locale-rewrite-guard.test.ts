import { describe, expect, it } from "bun:test";

import {
  isResolvedLocaleRewrite,
  LOCALE_REWRITE_MARKER,
  markLocaleRewrite,
} from "./locale-rewrite-guard";

/** Mirrors what Next hands the proxy: response headers, of which the marker is one. */
function markedResponse(overrides: string | null) {
  const response = { headers: new Headers() };
  if (overrides !== null) {
    response.headers.set("x-middleware-override-headers", overrides);
  }
  return markLocaleRewrite(response);
}

/** Reads the marker the way the proxy does on the re-run: off the request. */
function markerOf(response: { headers: Headers }): string | null {
  const name = `x-middleware-request-${LOCALE_REWRITE_MARKER}`;
  return response.headers.get(name);
}

describe("markLocaleRewrite", () => {
  it("extends the override list instead of replacing it", () => {
    const response = markedResponse("x-next-intl-locale,cookie");

    expect(response.headers.get("x-middleware-override-headers")).toBe(
      `x-next-intl-locale,cookie,${LOCALE_REWRITE_MARKER}`,
    );
  });

  it("leaves a response without request overrides untouched", () => {
    const response = markedResponse(null);

    expect(response.headers.get("x-middleware-override-headers")).toBeNull();
    expect(markerOf(response)).toBeNull();
  });

  it("puts a marker on the rewrite that the guard then accepts", () => {
    const response = markedResponse("x-next-intl-locale");

    expect(
      isResolvedLocaleRewrite({
        marker: markerOf(response),
        pathname: "/en/download",
      }),
    ).toBe(true);
  });
});

describe("isResolvedLocaleRewrite", () => {
  // `markLocaleRewrite` is the only producer of the marker, so the guard is
  // exercised end to end through it rather than against a literal value.
  const realMarker = markerOf(markedResponse("x-next-intl-locale"));

  it("accepts the rewrite target next-intl produced", () => {
    for (const pathname of ["/en", "/en/download", "/es/about", "/zh/pets"]) {
      expect(
        isResolvedLocaleRewrite({ marker: realMarker, pathname }),
        pathname,
      ).toBe(true);
    }
  });

  it("rejects a caller that sends the marker header itself", () => {
    // The value is generated per process and never leaves it, so a caller
    // cannot produce this; `en` is what a forger would try.
    for (const marker of ["", "en", "true", "1"]) {
      expect(
        isResolvedLocaleRewrite({ marker, pathname: "/en/download" }),
      ).toBe(false);
    }
  });

  it("rejects an unprefixed path even when the marker is genuine", () => {
    // Standing down here would hand a locale-less path to a page that needs
    // one, so the marker alone is never enough.
    for (const pathname of ["/", "/download", "/about"]) {
      expect(
        isResolvedLocaleRewrite({ marker: realMarker, pathname }),
        pathname,
      ).toBe(false);
    }
  });

  it("rejects a path that merely starts with the same letters", () => {
    // `/english` is not the `en` prefix; next-intl matches on segment
    // boundaries, and a substring test here would stand down on a real page.
    for (const pathname of ["/english", "/enough", "/endpoint", "/esc"]) {
      expect(
        isResolvedLocaleRewrite({ marker: realMarker, pathname }),
        pathname,
      ).toBe(false);
    }
  });

  it("rejects an uppercased prefix", () => {
    // next-intl matches a prefix case-insensitively but records the pathname
    // match as inexact and redirects it, so `/EN/download` is a path it would
    // still have routed — standing down would skip that redirect.
    for (const pathname of ["/EN/download", "/Es/about"]) {
      expect(
        isResolvedLocaleRewrite({ marker: realMarker, pathname }),
        pathname,
      ).toBe(false);
    }
  });

  it("rejects an unknown locale prefix", () => {
    for (const pathname of ["/fr/about", "/jp"]) {
      expect(
        isResolvedLocaleRewrite({ marker: realMarker, pathname }),
        pathname,
      ).toBe(false);
    }
  });

  it("rejects a missing marker", () => {
    expect(
      isResolvedLocaleRewrite({ marker: null, pathname: "/en/download" }),
    ).toBe(false);
  });
});
