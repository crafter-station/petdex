import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { UTApi, UTFile } from "uploadthing/server";

import { verifyCliToken } from "@/lib/cli-auth";
import { registerSubmittedPet, stableCliOwnerId } from "@/lib/submissions";
import { getWebpDimensions } from "@/lib/webp";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request) {
  const requestToken = getRequestToken(req);
  const cliAuth = authenticateCliToken(requestToken);
  if (!cliAuth.ok) {
    return NextResponse.json(cliAuth.body, { status: cliAuth.status });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }

  const zipFile = getFile(formData, "zip");
  const spritesheetFile = getFile(formData, "spritesheet");
  const petJsonFile = getFile(formData, "petJson");
  if (!zipFile || !spritesheetFile || !petJsonFile) {
    return NextResponse.json(
      {
        error: "missing_files",
        message: "Expected zip, spritesheet, and petJson files.",
      },
      { status: 400 },
    );
  }

  for (const file of [zipFile, spritesheetFile, petJsonFile]) {
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        {
          error: "file_too_large",
          file: file.name,
          message: "Each CLI upload file must be 8MB or smaller.",
        },
        { status: 413 },
      );
    }
  }

  const displayName = getString(formData, "displayName");
  const description = getString(formData, "description");
  const petId = getString(formData, "petId");
  if (!displayName || !description || !petId) {
    return NextResponse.json(
      {
        error: "missing_metadata",
        message: "Expected displayName, description, and petId.",
      },
      { status: 400 },
    );
  }

  const [zipBytes, spritesheetBytes, petJsonBytes] = await Promise.all([
    zipFile.arrayBuffer(),
    spritesheetFile.arrayBuffer(),
    petJsonFile.arrayBuffer(),
  ]);
  const dimensions = getWebpDimensions(new Uint8Array(spritesheetBytes));
  if (!dimensions) {
    return NextResponse.json(
      {
        error: "invalid_spritesheet",
        message: "spritesheet.webp is not a readable WebP image.",
      },
      { status: 400 },
    );
  }

  const utapi = new UTApi();
  const uploaded = await utapi.uploadFiles([
    new UTFile([zipBytes], sanitizeFileName(zipFile.name, "pet.zip"), {
      type: "application/zip",
    }),
    new UTFile(
      [spritesheetBytes],
      sanitizeFileName(spritesheetFile.name, "spritesheet.webp"),
      { type: "image/webp" },
    ),
    new UTFile([petJsonBytes], sanitizeFileName(petJsonFile.name, "pet.json"), {
      type: "application/json",
    }),
  ]);

  const uploadError = uploaded.find((item) => item.error);
  if (uploadError?.error) {
    return NextResponse.json(
      {
        error: "upload_failed",
        message: uploadError.error.message,
      },
      { status: 502 },
    );
  }

  const zipUrl = getUploadedUrl(uploaded[0]);
  const spritesheetUrl = getUploadedUrl(uploaded[1]);
  const petJsonUrl = getUploadedUrl(uploaded[2]);
  if (!zipUrl || !spritesheetUrl || !petJsonUrl) {
    return NextResponse.json(
      {
        error: "upload_incomplete",
        message: "UploadThing did not return all expected file URLs.",
      },
      { status: 502 },
    );
  }

  const result = await registerSubmittedPet({
    zipUrl,
    spritesheetUrl,
    petJsonUrl,
    displayName,
    description,
    petId,
    spritesheetWidth: dimensions.width,
    spritesheetHeight: dimensions.height,
    ownerId: cliAuth.ownerId,
    ownerEmail: getString(formData, "ownerEmail") ?? cliAuth.ownerEmail,
    kind: "character",
  });

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body, { status: 201 });
}

function getRequestToken(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return req.headers.get("x-petdex-token")?.trim() ?? null;
}

function authenticateCliToken(token: string | null):
  | { ok: true; ownerEmail: string | null; ownerId: string }
  | {
      ok: false;
      status: 401 | 503;
      body: { error: string; message?: string };
    } {
  if (!token) {
    return {
      ok: false,
      status: 401,
      body: {
        error: "unauthorized",
        message: "Run `petdex login` before uploading.",
      },
    };
  }

  const verified = verifyCliToken(token);
  if (verified.ok) {
    return {
      ok: true,
      ownerId: verified.token.ownerId,
      ownerEmail: verified.token.ownerEmail,
    };
  }

  if (token.startsWith("pdx_")) {
    return {
      ok: false,
      status: verified.error === "secret_missing" ? 503 : 401,
      body: {
        error:
          verified.error === "expired" ? "token_expired" : "invalid_cli_token",
        message:
          verified.error === "expired"
            ? "Run `petdex login` again; this CLI login expired."
            : "Run `petdex login` again; this CLI login is not valid.",
      },
    };
  }

  const configuredToken = process.env.PETDEX_CLI_TOKEN;
  if (configuredToken && secureEquals(token, configuredToken)) {
    return {
      ok: true,
      ownerId: process.env.PETDEX_CLI_OWNER_ID ?? stableCliOwnerId(token),
      ownerEmail: process.env.PETDEX_CLI_OWNER_EMAIL ?? null,
    };
  }

  if (!configuredToken && verified.error === "secret_missing") {
    return {
      ok: false,
      status: 503,
      body: {
        error: "cli_upload_disabled",
        message:
          "Set PETDEX_CLI_TOKEN_SECRET or CLERK_SECRET_KEY to enable CLI uploads.",
      },
    };
  }

  return {
    ok: false,
    status: 401,
    body: {
      error: "unauthorized",
      message: "Run `petdex login` before uploading.",
    },
  };
}

function secureEquals(left: string, right: string) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function getFile(formData: FormData, key: string) {
  const value = formData.get(key);
  return value instanceof File ? value : null;
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sanitizeFileName(name: string, fallback: string) {
  const safe = name
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return safe || fallback;
}

type UploadedItem = Awaited<ReturnType<UTApi["uploadFiles"]>>[number];

function getUploadedUrl(item: UploadedItem | undefined) {
  return item?.data?.ufsUrl ?? item?.data?.url ?? null;
}
