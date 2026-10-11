/**
 * The page the CLI shows in the browser once the OAuth redirect comes back.
 *
 * Everything here is a pure function of the outcome plus the app URL: no
 * network, no filesystem, no module state. That is deliberate — the page is
 * the one part of the login flow a user actually looks at, so it has to be
 * testable without a browser.
 *
 * The page must be entirely self-contained. `auth-server.ts` closes its
 * listening socket as soon as the response is written, so the browser cannot
 * fetch anything afterwards: styles are inline, the mark is inline SVG, and
 * there is no favicon reference to 404 on. For the same reason the three
 * locale variants ship inside the document and a tiny script picks one —
 * the CLI process has no idea what language the browser is set to.
 */

/**
 * Why a login did not finish. The first three are decided while handling the
 * redirect itself; the rest only surface after the authorization code has
 * been exchanged, which is exactly the window the deferred response exists
 * to cover.
 */
import {
  GEIST_MONO_WOFF2_BASE64,
  GEIST_SANS_WOFF2_BASE64,
} from "./callback-fonts.js";

export type CallbackFailureReason =
  | "authorization_denied"
  | "state_mismatch"
  | "missing_code"
  | "token_exchange_failed"
  | "userinfo_failed"
  | "storage_failed"
  | "timeout"
  | "closed";

export type CallbackOutcome =
  | { kind: "success" }
  | { kind: "error"; reason: CallbackFailureReason };

/**
 * Where the success page's button points.
 *
 * `/my-pets` rather than `/u/<handle>` on purpose. The redirect route sends a
 * signed-in browser on to the profile and a signed-out one through sign-in
 * first, so it is correct in both cases; a direct profile link 404s for a
 * brand-new account that has not submitted anything yet. The handle is also
 * not known when the page is first needed, but that is the weaker reason —
 * this stays `/my-pets` even now that the response is deferred.
 */
const PROFILE_PATH = "/my-pets";

/** Matches `PETDEX_URL` in `bin/petdex.ts`, including its env override. */
export function defaultAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.PETDEX_URL ?? "https://petdex.dev";
}

/**
 * The origin the button may point at.
 *
 * The value reaches an `href`, so anything that is not a trustworthy web
 * address is discarded rather than escaped: `javascript:` and `data:` are
 * perfectly valid URLs, and the escape below would leave both intact and
 * clickable. Falling back to the production origin is the safe answer — this
 * only ever comes from `PETDEX_URL`, and a wrong value is a misconfiguration,
 * not something the reader should be handed a script from.
 */
function resolveAppUrl(appUrl: string): string {
  try {
    const url = new URL(appUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return appUrl.replace(/\/+$/, "");
    }
  } catch {
    // Not a URL at all. Same answer as a URL with the wrong scheme.
  }
  return defaultAppUrl({});
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Trim provider-supplied text before it reaches the page. Only used for the
 * detail line, which can carry a reason echoed back from the token endpoint.
 */
export function clampDetail(value: string, max = 300): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

type Strings = {
  eyebrow: string;
  successChip: string;
  successTitle: string;
  successBody: string;
  successCta: string;
  errorChip: string;
  errorTitle: string;
  reason: Record<CallbackFailureReason, string>;
};

const LOCALES = ["en", "es", "zh"] as const;
type Locale = (typeof LOCALES)[number];

const STRINGS: Record<Locale, Strings> = {
  en: {
    eyebrow: "CLI auth",
    successChip: "Signed in",
    successTitle: "You're signed in",
    successBody:
      "This tab closes itself in a few seconds. You can also close it and head back to your terminal.",
    successCta: "Open my profile",
    errorChip: "Sign-in failed",
    errorTitle: "Sign-in didn't finish",
    reason: {
      authorization_denied: "You declined the authorization request.",
      state_mismatch:
        "The response didn't match the request this terminal started. Please sign in again.",
      missing_code: "The provider didn't return an authorization code.",
      token_exchange_failed:
        "The authorization code couldn't be exchanged for a token.",
      userinfo_failed: "Signed in, but your profile couldn't be loaded.",
      storage_failed: "The credentials couldn't be saved on this machine.",
      timeout: "The sign-in attempt timed out before it completed.",
      closed: "The sign-in attempt ended before it completed.",
    },
  },
  es: {
    eyebrow: "Auth de CLI",
    successChip: "Sesión iniciada",
    successTitle: "Sesión iniciada",
    successBody:
      "Esta pestaña se cerrará sola en unos segundos. También puedes cerrarla y volver a tu terminal.",
    successCta: "Abrir mi perfil",
    errorChip: "Falló el inicio de sesión",
    errorTitle: "El inicio de sesión no se completó",
    reason: {
      authorization_denied: "Rechazaste la solicitud de autorización.",
      state_mismatch:
        "La respuesta no coincide con la solicitud que inició esta terminal. Vuelve a iniciar sesión.",
      missing_code: "El proveedor no devolvió un código de autorización.",
      token_exchange_failed:
        "No se pudo canjear el código de autorización por un token.",
      userinfo_failed: "Se inició sesión, pero no se pudo cargar tu perfil.",
      storage_failed: "No se pudieron guardar las credenciales en este equipo.",
      timeout: "El intento de inicio de sesión agotó el tiempo.",
      closed: "El intento de inicio de sesión terminó antes de completarse.",
    },
  },
  zh: {
    eyebrow: "CLI 登录",
    successChip: "已登录",
    successTitle: "登录成功",
    successBody: "这个标签页几秒后会自动关闭。你也可以现在关掉它，回到终端。",
    successCta: "前往我的主页",
    errorChip: "登录失败",
    errorTitle: "登录没有完成",
    reason: {
      authorization_denied: "你在授权页拒绝了这次请求。",
      state_mismatch: "返回的 state 和这个终端发起的请求对不上，请重新登录。",
      missing_code: "授权方没有返回授权码。",
      token_exchange_failed: "授权码没能换成令牌。",
      userinfo_failed: "已经登录，但没能读取你的账号信息。",
      storage_failed: "凭据没能保存到本机。",
      timeout: "登录在完成前超时了。",
      closed: "登录在完成前就结束了。",
    },
  },
};

/** Exposed for the locale-parity test. */
export function callbackStringsByLocale(): Record<Locale, Strings> {
  return STRINGS;
}

export const LOCALES_FOR_TEST = LOCALES;

/**
 * `[...]` in a JSON script block is still parsed as markup: a literal `</`
 * would close the element early and spill the rest into the document. The
 * escape is valid JSON and parses back to the original character.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * Page styles. The values are the `:root` and `.dark` entries from the app's
 * `globals.css`, copied rather than imported: this package ships on its own
 * and has no build step that could inline the app's stylesheet.
 */
/**
 * The same faces the website uses, inlined as data URIs.
 *
 * The listener is already closed by the time the page renders, so a font
 * request would fail; the only way to follow the site's type is to carry it.
 * See `callback-fonts.ts` for the subset and `scripts/build-callback-fonts.ts`
 * for how it is produced.
 *
 * `font-display: swap` rather than `block`: the data is already in the
 * document, so there is no network wait to hide, and `swap` keeps a decode
 * that somehow fails from holding the text invisible.
 *
 * The stack names Geist first and keeps the system faces behind it, which is
 * what makes the CJK copy work — Geist has no CJK glyphs, so those characters
 * fall through to the system face exactly as they do on the website.
 */
const FONT_FACES = `
@font-face {
  font-family: "Geist";
  src: url(data:font/woff2;base64,${GEIST_SANS_WOFF2_BASE64}) format("woff2");
  font-weight: 400 600;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Geist Mono";
  src: url(data:font/woff2;base64,${GEIST_MONO_WOFF2_BASE64}) format("woff2");
  font-weight: 400 600;
  font-style: normal;
  font-display: swap;
}
`;

/**
 * The media query, not the site's `.dark` class.
 *
 * The site toggles that class from `next-themes` state kept in the app's own
 * origin, which this page cannot read: the login flow only ever visits
 * `clerk.petdex.dev` and this loopback port, never a petdex.dev page, so the
 * reader's choice there is invisible here. There is also no way to carry it
 * over — no hosted auth product takes a theme from the authorize URL (Clerk
 * rejects a `redirect_uri` with a query string outright), and `window.opener`
 * is null for a tab opened by a system browser.
 *
 * Following the OS preference is what the products in this position do:
 * GitHub's OAuth consent page ships `data-color-mode="auto"`, and WorkOS
 * AuthKit falls back to `prefers-color-scheme` for exactly the case where the
 * integrating app's stored preference is unreachable.
 */
const STYLES = `
:root {
  color-scheme: light dark;
  --bg-app: oklch(0.984 0.009 271.7);
  --text-default: oklch(0.142 0 0);
  --brand: oklch(0.561 0.207 271.8);
  --brand-deep: oklch(0.521 0.26 269.4);
  --surface: oklch(1 0 0);
  --border-base: oklch(0.142 0 0 / 0.1);
  --text-muted-1: oklch(0.235 0.009 277.1);
  --text-muted-3: oklch(0.475 0.024 273.7);
  --chip-success-bg: oklch(0.946 0.052 156);
  --chip-success-fg: oklch(0.385 0.085 159.5);
  --chip-danger-bg: oklch(0.943 0.038 16.5);
  --chip-danger-fg: oklch(0.396 0.139 25);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg-app: oklch(0.157 0.004 285.7);
    --text-default: oklch(0.949 0.002 286.2);
    --brand: oklch(0.745 0.165 272);
    --brand-deep: oklch(0.795 0.15 270);
    --surface: oklch(0.215 0.005 285.7);
    --border-base: oklch(1 0 0 / 0.1);
    --text-muted-1: oklch(0.88 0.01 277);
    --text-muted-3: oklch(0.64 0.015 274);
    --chip-success-bg: oklch(0.281 0.044 159 / 0.5);
    --chip-success-fg: oklch(0.819 0.13 158);
    --chip-danger-bg: oklch(0.281 0.046 25 / 0.5);
    --chip-danger-fg: oklch(0.812 0.11 18);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-app);
  color: var(--text-default);
  font-family: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI",
    Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
.card {
  width: 100%;
  max-width: 26rem;
  padding: 32px;
  background: var(--surface);
  border: 1px solid var(--border-base);
  border-radius: 16px;
  text-align: center;
}
.mark { display: block; margin: 0 auto 20px; width: 40px; height: 40px; }
.eyebrow {
  margin: 0 0 20px;
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas,
    monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--brand);
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 16px;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
}
.chip-success { background: var(--chip-success-bg); color: var(--chip-success-fg); }
.chip-danger { background: var(--chip-danger-bg); color: var(--chip-danger-fg); }
h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.25; font-weight: 600; }
.body { margin: 0; color: var(--text-muted-1); font-size: 14px; line-height: 1.6; }
.detail {
  margin: 14px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border-base);
  color: var(--text-muted-3);
  font-size: 12px;
  line-height: 1.6;
  text-align: left;
  overflow-wrap: anywhere;
}
.cta {
  display: inline-block;
  margin-top: 24px;
  padding: 10px 22px;
  border-radius: 999px;
  background: var(--brand-deep);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.25),
    inset 0 -1px 0 rgb(20 20 80 / 0.25),
    0 8px 24px -8px rgb(56 71 245 / 0.55);
  transition: filter 0.15s ease;
}
.cta:hover { filter: brightness(1.08); }
@media (prefers-color-scheme: dark) {
  /* globals.css flips the CTA text to a near-black on the lighter dark-mode
     brand fill, so the white here would not hold contrast. */
  .cta { color: #0b0b18; }
}
`;

/**
 * The page's only script. It reads the string table out of the JSON block,
 * picks the browser's language, and writes text with `textContent` — never
 * `innerHTML`, so nothing in the document is ever parsed as markup.
 */
const SCRIPT = `
(function () {
  var el = document.getElementById("i18n");
  if (!el) return;
  var table;
  try { table = JSON.parse(el.textContent); } catch (e) { return; }
  var want = (navigator.language || "en").toLowerCase();
  var locale = want.indexOf("zh") === 0 ? "zh"
    : want.indexOf("es") === 0 ? "es"
    : "en";
  var s = table.strings[locale];
  if (!s) return;
  document.documentElement.lang = locale;
  var set = function (role, value) {
    var nodes = document.querySelectorAll('[data-copy="' + role + '"]');
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = value;
  };
  set("eyebrow", s.eyebrow);
  set("chip", s.chip);
  set("title", s.title);
  set("body", s.body);
  set("cta", s.cta);
  // The detail line is deliberately not in the table: it is the only string
  // that comes from the server, not from the locale, so it is rendered into
  // the markup and must be left alone here. Setting it from the table would
  // overwrite it with nothing.
})();
`;

/**
 * On the success page only: try to close the tab, and give up if the reader
 * touches anything first.
 *
 * The tab was opened by `open` / `start` / `xdg-open`, not by a script, and
 * browsers refuse to close those. There is nothing to fall back to, so a
 * refused close is silent — the page simply stays and every control on it
 * keeps working.
 */
const CLOSE_SCRIPT = `
(function () {
  var timer = setTimeout(function () { window.close(); }, 5000);
  var cancel = function () { clearTimeout(timer); };
  var events = ["mousemove", "mousedown", "keydown", "click", "focus", "touchstart"];
  for (var i = 0; i < events.length; i++) {
    window.addEventListener(events[i], cancel, { once: true, passive: true });
  }
})();
`;

const MARK_SVG = `<svg class="mark" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><defs><linearGradient id="petdex-body" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse"><stop stop-color="#3847f5"/><stop offset="1" stop-color="#1a1d2e"/></linearGradient></defs><rect x="4" y="4" width="56" height="56" rx="16" fill="url(#petdex-body)"/><g fill="#ffffff"><rect x="22" y="20" width="6" height="6"/><rect x="36" y="20" width="6" height="6"/><rect x="16" y="26" width="6" height="18"/><rect x="42" y="26" width="6" height="18"/><rect x="22" y="38" width="20" height="6"/></g></svg>`;

/**
 * Render the callback page.
 *
 * `detail` is optional free text shown under the body copy. It is escaped and
 * clamped, because the value can carry a message that originated in a
 * provider response.
 */
export function renderCallbackPage(
  outcome: CallbackOutcome,
  appUrl: string = defaultAppUrl(),
  detail?: string,
): string {
  const isSuccess = outcome.kind === "success";
  const reason = isSuccess ? null : outcome.reason;

  const strings = {} as Record<Locale, Record<string, string>>;
  for (const locale of LOCALES) {
    const s = STRINGS[locale];
    strings[locale] = {
      eyebrow: s.eyebrow,
      chip: isSuccess ? s.successChip : s.errorChip,
      title: isSuccess ? s.successTitle : s.errorTitle,
      body: isSuccess
        ? s.successBody
        : s.reason[reason as CallbackFailureReason],
      cta: isSuccess ? s.successCta : "",
    };
  }

  const cta = isSuccess
    ? `<a class="cta" data-copy="cta" href="${escapeHtml(resolveAppUrl(appUrl))}${PROFILE_PATH}"></a>`
    : "";

  const detailBlock = detail
    ? `<p class="detail">${escapeHtml(clampDetail(detail))}</p>`
    : "";

  const closeScript = isSuccess ? `<script>${CLOSE_SCRIPT}</script>` : "";

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    // Ahead of the stylesheet so the browser paints the right background on
    // the first frame rather than flashing the light one. The CSS also sets
    // `color-scheme`, but only once the style block has been parsed.
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(STRINGS.en.eyebrow)}</title>`,
    `<style>${FONT_FACES}${STYLES}</style>`,
    "</head>",
    "<body>",
    '<main class="card">',
    MARK_SVG,
    '<p class="eyebrow" data-copy="eyebrow"></p>',
    `<span class="chip ${isSuccess ? "chip-success" : "chip-danger"}">`,
    `<span data-copy="chip"></span>`,
    "</span>",
    '<h1 data-copy="title"></h1>',
    '<p class="body" data-copy="body"></p>',
    detailBlock,
    cta,
    "</main>",
    `<script type="application/json" id="i18n">${safeJson({ strings })}</script>`,
    `<script>${SCRIPT}</script>`,
    closeScript,
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}
