import { notFound } from "next/navigation";
import { Suspense } from "react";

import { auth } from "@clerk/nextjs/server";

import { isAdmin } from "@/lib/admin";

import { AdminTabs } from "@/components/admin-tabs";
import { SiteHeader } from "@/components/site-header";

export const metadata = {
  robots: { index: false, follow: false },
};

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={null}>
      <AdminGate>{children}</AdminGate>
    </Suspense>
  );
}

async function AdminGate({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
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
