type R2ObjectBody = {
  body: ReadableStream;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
};

type R2BucketBinding = {
  get(key: string): Promise<R2ObjectBody | null>;
};

type Env = {
  PETDEX_PETS: R2BucketBinding;
};

// Hotlink gate, not access control: a `Referer` header is client-set, so
// curl `-H 'Referer: https://petdex.dev/'` walks straight through. What this
// buys is only that a third-party page cannot inline these assets.
//
// Parsed as URLs and matched on host, not with `startsWith`: the previous
// prefix form carried `"http://localhost"`, which `http://localhost.evil.com/`
// also prefixes. `hostname` (not `host`) keeps any port on localhost allowed —
// the old prefix's intent, and what a dev server on :3000/:3100 sends — while
// `localhost.evil.com` is now a different host and fails. URL parsing also
// normalizes scheme/host case and rejects `https://petdex.dev@evil.com/`
// (its hostname is evil.com).
const ALLOWED_REFERER_HOSTS = new Set(["localhost", "petdex.dev"]);

// CORS is a separate question from the Referer gate: the browser attaches
// Origin on cross-site fetches, so an allowlisted origin gets a credentialed
// read of anything the Referer gate lets through.
const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "https://petdex.dev",
]);

function isAllowedReferer(request: Request): boolean {
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return ALLOWED_REFERER_HOSTS.has(new URL(referer).hostname);
  } catch {
    return false;
  }
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    // No Allow-Headers for Range: get() reads the whole object, so a Range
    // request gets 200 with the full body, not 206. Advertising the header
    // invited clients into resumable downloads this endpoint does not
    // implement — re-advertise it if range support lands.
    headers.set("Vary", "Origin, Referer");
  } else {
    headers.set("Vary", "Referer");
  }
  return headers;
}

// Error responses must never be cached at the edge. The origin objects are
// backfilled asynchronously (thumbnails, previews, stickers), so a request
// that arrives a moment before the object lands would otherwise poison the
// cache with a 404 that outlives the missing object. no-store keeps every
// retry hitting the origin until the artifact actually exists.
function errorResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      // Errors never render (no sniffing to HTML from an image type), so
      // they carry nosniff alone; the 200 path adds the sandbox CSP.
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Applied to every 200 too (see the fetch handler): responses carry whatever
// Content-Type the upload wrote, and this bucket serves user uploads, so the
// worker itself pins the two headers that stop a mislabeled body from
// becoming an executable document on this origin.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

function objectKey(request: Request): string | null {
  const url = new URL(request.url);
  const raw = url.pathname.replace(/^\/+/, "");
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse("method not allowed", 405);
    }

    if (!isAllowedReferer(request)) {
      return errorResponse("forbidden", 403);
    }

    const key = objectKey(request);
    if (!key) {
      return errorResponse("not found", 404);
    }

    const object = await env.PETDEX_PETS.get(key);
    if (!object) {
      return errorResponse("not found", 404);
    }

    const headers = corsHeaders(request);
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set(
      "Cache-Control",
      headers.get("Cache-Control") ?? "public, max-age=31536000, immutable",
    );
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      headers.set(name, value);
    }

    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }

    return new Response(object.body, { headers });
  },
};
