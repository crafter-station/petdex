import type { Metadata } from "next";

import "./globals.css";

const SITE_URL = "https://petdex.dev";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "Petdex",
  authors: [{ name: "Crafter Station", url: "https://crafter.run" }],
  creator: "Crafter Station",
  publisher: "Crafter Station",
  alternates: {
    canonical: "/",
  },
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
