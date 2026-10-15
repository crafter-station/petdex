import type { Metadata } from "next";

import "./globals.css";

const SITE_URL = "https://petdex.dev";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "Petdex",
  authors: [{ name: "Crafter Station", url: "https://crafter.run" }],
  creator: "Crafter Station",
  publisher: "Crafter Station",
  // No `alternates.canonical` here. A root-level canonical is inherited by
  // every page that does not set its own — including the noindex ones
  // (/my-pets, /my-feedback, the 404 page), where "noindex" plus a canonical
  // pointing at the homepage is exactly the contradictory pair Google warns
  // about. Indexable pages all set their own locale-prefixed canonical via
  // buildLocaleAlternates, so nothing loses a canonical by its removal.
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/apple-icon.png",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The locale layout owns html/body so Next 16 can set lang from [locale];
  // providers and widgets live there to stay inside the document and receive locale context.
  return children;
}
