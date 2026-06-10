// Public proxy for the WeChat group QR.
//
// Why a proxy instead of <img src="https://...aliyuncs.com/...jpg"> direct:
//   1. The Aliyun OSS bucket Henry set up is private (bucket ACL blocks
//      anonymous reads with 'AccessDenied'). Browsers therefore 403'd.
//   2. Even if it were public, sending the browser to an external host
//      requires whitelisting it in CSP img-src, leaks visit data to
//      Tencent / Aliyun, and depends on Henry never flipping the ACL.
//   3. With a proxy the browser only ever talks to petdex.dev,
//      and we serve the bytes signed via the RAM user that already has
//      oss:GetObject scope.
//
// We sign a short-lived URL via ali-oss and stream the response. Cached
// at the edge for 5 minutes so a hot homepage doesn't translate into
// thousands of upstream OSS reads while still allowing quick QR rotation.

import { NextResponse } from "next/server";

import OSS from "ali-oss";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QR_OBJECT_KEY = "petdex-qr-code.jpg";
const SIGNED_URL_TTL_SECONDS = 60;
const CACHE_HEADER = "public, max-age=300, s-maxage=300";

let cachedClient: OSS | null = null;

function getOssClient(): OSS | null {
  if (cachedClient) return cachedClient;
  const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.ALIYUN_OSS_BUCKET;
  const region = process.env.ALIYUN_OSS_REGION;
  if (!accessKeyId || !accessKeySecret || !bucket || !region) return null;
  cachedClient = new OSS({ accessKeyId, accessKeySecret, bucket, region });
  return cachedClient;
}

export async function GET(): Promise<Response> {
  const client = getOssClient();
  if (!client) {
    return new NextResponse("not_configured", { status: 503 });
  }

  // Sign a 60-second URL for the live QR object — cheaper than streaming
  // the bytes through Vercel's bandwidth. Aliyun supports signed reads
  // even when the object/bucket ACL is private.
  let signedUrl: string;
  try {
    signedUrl = client.signatureUrl(QR_OBJECT_KEY, {
      expires: SIGNED_URL_TTL_SECONDS,
    });
  } catch {
    return new NextResponse("sign_failed", { status: 500 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(signedUrl, { redirect: "error" });
  } catch {
    return new NextResponse("upstream_unreachable", { status: 502 });
  }

  if (!upstream.ok) {
    return new NextResponse("upstream_error", { status: upstream.status });
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const contentType = upstream.headers.get("content-type") ?? "image/jpeg";

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": CACHE_HEADER,
      "x-petdex-qr-source": "aliyun-signed",
    },
  });
}
