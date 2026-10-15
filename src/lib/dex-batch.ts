// Pure-JS batch key helpers. Importable from client components — no
// DB or Node-only deps. The server-side query that lists available
// batches lives in dex-batch.server.ts so client bundles don't drag
// the Drizzle client.

const MONTH_LABEL = new Map<string, Intl.DateTimeFormat>();

/** A `long`-month formatter for a locale, built once and reused. */
function monthLabel(locale: string): Intl.DateTimeFormat {
  let formatter = MONTH_LABEL.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      month: "long",
      timeZone: "UTC",
    });
    MONTH_LABEL.set(locale, formatter);
  }
  return formatter;
}

export function getBatchKey(approvedAt: Date): string {
  return approvedAt.toISOString().slice(0, 7);
}

/**
 * The month a batch key names, localized.
 *
 * The `Class of …` wrapper is a phrase and lives in the messages
 * (`gallery.batchLabel`); this returns only the month and year, which
 * `Intl` can localize itself. The locale used to be hardcoded `en-US`, so
 * every Era chip and card badge read "Class of October 2025" on /es and /zh.
 */
export function formatBatchLabel(key: string, locale: string): string {
  const [year, month] = key.split("-");
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return `${monthLabel(locale).format(date)} ${year}`;
}
