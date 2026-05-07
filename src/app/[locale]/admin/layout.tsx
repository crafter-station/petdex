import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "@/lib/admin";

import { AdminTabs } from "@/components/admin-tabs";
import { SiteHeader } from "@/components/site-header";

export const metadata = {
  robots: { index: false, follow: false },
};

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  // Single gate at the layout level — every nested page (/admin,
  // /admin/requests, /admin/feedback) inherits this protection so
  // no individual page has to re-check.
  if (!isAdmin(userId)) notFound();

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-5 md:px-8 md:py-6">
        <SiteHeader />
        <AdminTabs />
      </section>
      {children}
    </main>
  );
}
