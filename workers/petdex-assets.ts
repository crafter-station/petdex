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

const ALLOWED_REFERER_PREFIXES = [
  "http://localhost",
  "https://localhost",
  "https://petdex.dev/",
];

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "https://petdex.dev",
]);

function isAllowedReferer(request: Request): boolean {
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  const value = referer.toLowerCase();
  return ALLOWED_REFERER_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Range");
    headers.set("Vary", "Origin, Referer");
  } else {
    headers.set("Vary", "Referer");
  }
  return headers;
}

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
      return new Response("method not allowed", { status: 405 });
    }

    if (!isAllowedReferer(request)) {
      return new Response("forbidden", { status: 403 });
    }

    const key = objectKey(request);
    if (!key) {
      return new Response("not found", { status: 404 });
    }

    const object = await env.PETDEX_PETS.get(key);
    if (!object) {
      return new Response("not found", { status: 404 });
    }

    const headers = corsHeaders(request);
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set(
      "Cache-Control",
      headers.get("Cache-Control") ?? "public, max-age=31536000, immutable",
    );

    if (request.method === "HEAD") {
      return new Response(null, { headers });
    }

    return new Response(object.body, { headers });
  },
};
