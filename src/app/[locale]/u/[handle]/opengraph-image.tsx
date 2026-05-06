// Per-profile OG image. Mirrors the per-pet/per-collection OGs:
// petdex-cloud gradient + brand purple, mono caption. Renders the
// creator's avatar (when allowlisted), display name, pet count, and
// a sprite collage of up to 4 pinned pets so the unfurl reads as
// "this person made these pets" instead of a generic profile card.
//
// Driven by the user's pinned set (featuredPetSlugs). When the user
// has no pinned pets we fall back to the most recent approved pets.

import { ImageResponse } from "next/og";

import { clerkClient } from "@clerk/nextjs/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import sharp from "sharp";

import { db, schema } from "@/lib/db/client";
import { userIdForHandle } from "@/lib/handles";
import { isAllowedAssetUrl, isAllowedAvatarUrl } from "@/lib/url-allowlist";

export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Petdex profile preview";
// 24h ISR — same reasoning as the per-pet OG. Profile bios change
// rarely and the unfurl bots that hit this path are noisy. Cached
// PNG saves Fluid CPU + Origin Transfer on every Discord/X share.

const FRAME_W = 192;
const FRAME_H = 208;
const SPRITE_DISPLAY = 192; // square plate per sprite

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; handle: string }>;
}) {
  const { handle } = await params;
  const ownerId = await userIdForHandle(handle);
  if (!ownerId) return petdexFallback();

  // Profile + Clerk identity. We fetch in parallel; the Clerk call can
  // throw on transient API errors but we swallow it and fall back to
  // the handle since the OG should never error a share.
  const [profile, clerkUser] = await Promise.all([
    db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, ownerId),
    }),
    (async () => {
      try {
        const c = await clerkClient();
        return await c.users.getUser(ownerId);
      } catch {
        return null;
      }
    })(),
  ]);

  const fullName = clerkUser
    ? [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ").trim()
    : "";
  const displayName = profile?.displayName ?? fullName ?? `@${handle}`;
  const safeDisplayName = displayName || `@${handle}`;
  const publicHandle = profile?.handle ?? handle.toLowerCase();
  const bio = profile?.bio?.trim() ?? null;
  const featuredSlugs =
    (profile?.featuredPetSlugs as string[] | undefined) ?? [];

  // Fetch sprite URLs. Pinned pets first; fall back to the 4 most
  // recently approved pets if the user has no pinned set yet.
  const approvedFilter = and(
    eq(schema.submittedPets.ownerId, ownerId),
    eq(schema.submittedPets.status, "approved"),
  );
  const collageRows =
    featuredSlugs.length > 0
      ? await db
          .select({
            slug: schema.submittedPets.slug,
            spritesheetUrl: schema.submittedPets.spritesheetUrl,
          })
          .from(schema.submittedPets)
          .where(
            and(
              approvedFilter,
              inArray(schema.submittedPets.slug, featuredSlugs.slice(0, 4)),
            ),
          )
      : await db
          .select({
            slug: schema.submittedPets.slug,
            spritesheetUrl: schema.submittedPets.spritesheetUrl,
          })
          .from(schema.submittedPets)
          .where(approvedFilter)
          .orderBy(desc(schema.submittedPets.approvedAt))
          .limit(4);

  // Total pet count for the stat line. One round-trip with raw count.
  const countRows = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(approvedFilter);
  const petCount = countRows.length;

  // Decode sprites in parallel. Failures fall through to no-sprite
  // (the slot just renders empty).
  const spriteUrls = await Promise.all(
    collageRows
      .slice(0, 4)
      .map((r) => loadFirstFrameAsDataUrl(r.spritesheetUrl)),
  );

  const avatarDataUrl = clerkUser?.imageUrl
    ? await loadAvatarAsDataUrl(clerkUser.imageUrl)
    : null;

  const fallbackInitial = (
    safeDisplayName[0] ??
    handle[0] ??
    "?"
  ).toUpperCase();

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background:
          "linear-gradient(120deg, #d8e9ff 0%, #f7f8ff 47%, #c9c6ff 100%)",
        position: "relative",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 50% 30%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.45) 28%, transparent 60%)",
          display: "flex",
        }}
      />

      {/* Top brand row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "44px 56px 0 56px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            color: "#0a0a0a",
            fontSize: 28,
            fontWeight: 600,
          }}
        >
          <PetdexMark size={44} />
          <span>Petdex</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            color: "#5266ea",
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontWeight: 600,
          }}
        >
          Petdex creator
        </div>
      </div>

      {/* Main row */}
      <div
        style={{
          display: "flex",
          flex: 1,
          padding: "32px 64px 24px 64px",
          alignItems: "center",
          gap: 44,
        }}
      >
        {/* Avatar plate */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 220,
            height: 220,
            borderRadius: 40,
            backgroundColor: "rgba(255,255,255,0.92)",
            border: "1px solid rgba(82,102,234,0.18)",
            flexShrink: 0,
            overflow: "hidden",
          }}
        >
          {avatarDataUrl ? (
            // biome-ignore lint/performance/noImgElement: og runtime needs <img>
            <img
              src={avatarDataUrl}
              width={220}
              height={220}
              alt=""
              style={{ objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                height: "100%",
                color: "#5b6076",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 96,
                fontWeight: 600,
              }}
            >
              {fallbackInitial}
            </div>
          )}
        </div>

        {/* Identity column */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            color: "#0a0a0a",
            minWidth: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 22,
              color: "#5266ea",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              letterSpacing: 4,
              textTransform: "uppercase",
              marginBottom: 12,
            }}
          >
            @{publicHandle}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 80,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: -2,
              color: "#0a0a0a",
              marginBottom: 18,
              maxWidth: 720,
            }}
          >
            {clip(safeDisplayName, 24)}
          </div>
          {bio ? (
            <div
              style={{
                display: "flex",
                fontSize: 26,
                lineHeight: 1.35,
                color: "#202127",
                maxWidth: 620,
                marginBottom: 18,
              }}
            >
              {clip(bio, 110)}
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              fontSize: 22,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "#5b6076",
              letterSpacing: 2,
              textTransform: "uppercase",
            }}
          >
            {petCount} {petCount === 1 ? "pet" : "pets"} · petdex.crafter.run
          </div>
        </div>
      </div>

      {/* Sprite collage strip */}
      {spriteUrls.some(Boolean) ? (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "flex-end",
            gap: 16,
            padding: "0 64px 36px 64px",
          }}
        >
          {spriteUrls.map((dataUrl, i) =>
            dataUrl ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: collage is positional
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: SPRITE_DISPLAY,
                  height: SPRITE_DISPLAY,
                  borderRadius: 28,
                  backgroundColor: "rgba(255,255,255,0.82)",
                  border: "1px solid rgba(82,102,234,0.18)",
                }}
              >
                {/* biome-ignore lint/performance/noImgElement: og runtime */}
                <img
                  src={dataUrl}
                  width={SPRITE_DISPLAY - 24}
                  height={SPRITE_DISPLAY - 24}
                  alt=""
                />
              </div>
            ) : null,
          )}
        </div>
      ) : (
        <div style={{ height: 56, display: "flex" }} />
      )}
    </div>,
    { ...size },
  );
}

async function loadFirstFrameAsDataUrl(url: string): Promise<string | null> {
  if (!isAllowedAssetUrl(url)) return null;
  try {
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf)
      .extract({ left: 0, top: 0, width: FRAME_W, height: FRAME_H })
      .resize(SPRITE_DISPLAY - 24, SPRITE_DISPLAY - 24, { kernel: "nearest" })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

async function loadAvatarAsDataUrl(url: string): Promise<string | null> {
  if (!isAllowedAvatarUrl(url)) return null;
  try {
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf)
      .resize(220, 220, { fit: "cover" })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

function PetdexMark({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "flex" }}
    >
      <defs>
        <linearGradient
          id="og-petdex-profile-body"
          x1="8"
          y1="8"
          x2="56"
          y2="56"
        >
          <stop stopColor="#3847f5" />
          <stop offset="1" stopColor="#1a1d2e" />
        </linearGradient>
      </defs>
      <rect
        x="6"
        y="6"
        width="52"
        height="52"
        rx="14"
        fill="url(#og-petdex-profile-body)"
      />
      <circle cx="24" cy="28" r="4" fill="#fff" />
      <circle cx="40" cy="28" r="4" fill="#fff" />
      <rect x="22" y="40" width="20" height="4" rx="2" fill="#fff" />
    </svg>
  );
}

function petdexFallback() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background:
          "linear-gradient(120deg, #d8e9ff 0%, #f7f8ff 47%, #c9c6ff 100%)",
        alignItems: "center",
        justifyContent: "center",
        color: "#0a0a0a",
        fontSize: 80,
        fontWeight: 700,
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      Petdex
    </div>,
    { ...size },
  );
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}
