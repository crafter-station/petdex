import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { desc, eq } from "drizzle-orm";

import { canEditWeChatQr } from "@/lib/admin";
import { db, schema } from "@/lib/db/client";

import { WechatQrPanel } from "./wechat-qr-panel";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "WeChat QR Panel",
  robots: { index: false, follow: false },
};

export default async function WechatQrPage() {
  const { userId } = await auth();
  if (!userId || !canEditWeChatQr(userId)) notFound();

  const [current] = await db
    .select()
    .from(schema.wechatQrUploads)
    .where(eq(schema.wechatQrUploads.status, "active"))
    .orderBy(desc(schema.wechatQrUploads.uploadedAt))
    .limit(1);

  const history = await db
    .select()
    .from(schema.wechatQrUploads)
    .orderBy(desc(schema.wechatQrUploads.uploadedAt))
    .limit(10);

  return (
    <section className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 pb-12 md:px-8 md:pb-16">
      <WechatQrPanel current={current ?? null} history={history} />
    </section>
  );
}
