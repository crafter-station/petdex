// DEAD CODE (verified 2026-10): nothing imports this module. /api/wechat-qr reads through its own inline OSS client, and `uploadWeChatQr` was never wired up — note that it also assumed a public bucket while the route's bucket is private, so do NOT wire it in without fixing that. Delete or wire in an upstream decision.

import OSS from "ali-oss";

let cachedClient: OSS | null = null;

function getOssClient(): OSS {
  if (cachedClient) return cachedClient;
  const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.ALIYUN_OSS_BUCKET;
  const region = process.env.ALIYUN_OSS_REGION;
  if (!accessKeyId || !accessKeySecret || !bucket || !region) {
    throw new Error("aliyun_oss_not_configured");
  }
  cachedClient = new OSS({ accessKeyId, accessKeySecret, bucket, region });
  return cachedClient;
}

export type QrUploadResult = {
  url: string;
  historyKey: string;
  size: number;
  etag: string;
};

export async function uploadWeChatQr(buffer: Buffer): Promise<QrUploadResult> {
  const client = getOssClient();
  const liveKey = "petdex-qr-code.jpg";
  const now = new Date();
  const year = now.getFullYear();
  const week = getISOWeek(now);
  const historyKey = `history/${year}-W${String(week).padStart(2, "0")}.jpg`;

  const live = await client.put(liveKey, buffer);
  const archive = await client.put(historyKey, buffer);
  return {
    url: live.url,
    historyKey,
    size: buffer.length,
    etag:
      ((archive.res.headers as Record<string, string>).etag as
        | string
        | undefined) ?? "",
  };
}

function getISOWeek(d: Date): number {
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 86400000));
}
