import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "pdx_";
const TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;

type CliTokenPayload = {
  v: typeof TOKEN_VERSION;
  sub: string;
  email: string | null;
  iat: number;
  exp: number;
};

export type VerifiedCliToken = {
  ownerId: string;
  ownerEmail: string | null;
  expiresAt: string;
};

export function issueCliToken({
  ownerEmail,
  ownerId,
}: {
  ownerEmail: string | null;
  ownerId: string;
}) {
  const secret = getCliTokenSecret();
  if (!secret) return null;

  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const payload: CliTokenPayload = {
    v: TOKEN_VERSION,
    sub: ownerId,
    email: ownerEmail,
    iat: issuedAt,
    exp: expiresAt,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return {
    token: `${TOKEN_PREFIX}${body}.${sign(body, secret)}`,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}

export function verifyCliToken(
  token: string,
):
  | { ok: true; token: VerifiedCliToken }
  | { ok: false; error: "expired" | "invalid" | "secret_missing" } {
  const secret = getCliTokenSecret();
  if (!secret) return { ok: false, error: "secret_missing" };
  if (!token.startsWith(TOKEN_PREFIX)) return { ok: false, error: "invalid" };

  const [body, signature] = token.slice(TOKEN_PREFIX.length).split(".");
  if (!body || !signature || !safeEqual(signature, sign(body, secret))) {
    return { ok: false, error: "invalid" };
  }

  let payload: Partial<CliTokenPayload>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "invalid" };
  }

  if (
    payload.v !== TOKEN_VERSION ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.exp !== "number"
  ) {
    return { ok: false, error: "invalid" };
  }

  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "expired" };
  }

  return {
    ok: true,
    token: {
      ownerId: payload.sub,
      ownerEmail: typeof payload.email === "string" ? payload.email : null,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    },
  };
}

export function hasCliTokenSecret() {
  return Boolean(getCliTokenSecret());
}

function getCliTokenSecret() {
  return process.env.PETDEX_CLI_TOKEN_SECRET ?? process.env.CLERK_SECRET_KEY;
}

function sign(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
