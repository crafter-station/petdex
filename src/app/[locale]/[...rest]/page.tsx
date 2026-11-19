import { notFound } from "next/navigation";

// A URL that matches no route never reaches a page, so Next answers with its
// own 404 — the bare "This page could not be found." in English, on every
// locale. `[locale]/not-found.tsx` only renders when something *calls*
// `notFound()`, which is why `/es/pets/nope` was localized and `/es/nope` was
// not. A root `not-found.tsx` cannot fix this either: `app/layout.tsx` returns
// its children without `<html>`/`<body>` (the locale layout owns those), so a
// root not-found would render outside a document.
//
// This catch-all is the documented way to route unmatched paths back into the
// locale segment, where the existing branded `not-found.tsx` takes over. It is
// reached last — every real route is more specific — and its only job is to
// hand off, so it renders nothing itself.
export default function CatchAllNotFound() {
  notFound();
}
