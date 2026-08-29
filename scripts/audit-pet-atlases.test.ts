import { describe, expect, it } from "bun:test";

import {
  buildPublicAuditReviewReport,
  classifyAuditEntry,
  createAuditEntry,
  MANUAL_REVIEW_CHECKS,
  parseCompactManifest,
  parseLegacyManifest,
  readResponseBodyBounded,
  resolveManifestAsset,
  summarizeAtlasPixels,
  toPublicAuditReviewEntry,
} from "./audit-pet-atlases";

it("keeps the trusted public asset URL in each report entry", () => {
  const entry = createAuditEntry(
    {
      slug: "demo",
      approvedAt: null,
      spritesheetUrl: "https://assets.petdex.dev/pets/demo/spritesheet.webp",
    },
    {
      declaredVersion: 1,
      detectedVersion: 1,
      width: 1536,
      height: 1872,
      bytes: 42,
      summary: null,
      error: null,
      errorKind: null,
    },
  );

  expect(entry.spritesheetUrl).toBe(
    "https://assets.petdex.dev/pets/demo/spritesheet.webp",
  );
});

it("keeps every required visual review category explicit", () => {
  expect(MANUAL_REVIEW_CHECKS).toEqual([
    "idle eye-open default state",
    "action continuity and direction consistency",
    "transparent edge bounds and left/right clipping",
    "sprite scale consistency and flattened proportions",
    "state-row proportion and frame-to-frame continuity",
    "compression artifacts and visual integrity",
  ]);
});

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe("bounded asset reads", () => {
  it("reads chunked bodies up to the configured limit", async () => {
    const body = await readResponseBodyBounded(
      responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      4,
    );
    expect(body).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects a chunked body as soon as it exceeds the limit", async () => {
    await expect(
      readResponseBodyBounded(
        responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3])]),
        2,
      ),
    ).rejects.toThrow("asset exceeds audit limit");
  });

  it("cancels a body that stops producing chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    await expect(
      readResponseBodyBounded(new Response(body), 4, 20),
    ).rejects.toThrow("asset read timed out");
  });
});

describe("atlas audit geometry", () => {
  it("counts expected classic cells without treating unused columns as errors", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    const offset = (3 * 208 * width + 10 * width + 2 * 192 + 10) * 4;
    data[offset + 3] = 255;
    const result = summarizeAtlasPixels(data, width, 1);
    expect(result.expectedFrames).toBe(57);
    expect(result.emptyFrames).toBe(56);
    expect(result.touchingFrames).toBe(0);
  });

  it("includes both additional v2 direction rows", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 2288 * 4);
    const offset = (10 * 208 * width + 7 * 192 + 10) * 4;
    data[offset + 3] = 255;
    const result = summarizeAtlasPixels(data, width, 2);
    expect(result.expectedFrames).toBe(73);
    expect(result.emptyFrames).toBe(72);
  });

  function drawOpaqueRect(
    data: Buffer,
    width: number,
    row: number,
    column: number,
    x: number,
    y: number,
    rectWidth: number,
    rectHeight: number,
  ) {
    for (let dy = 0; dy < rectHeight; dy++) {
      for (let dx = 0; dx < rectWidth; dx++) {
        const offset =
          ((row * 208 + y + dy) * width + column * 192 + x + dx) * 4;
        data[offset + 3] = 255;
      }
    }
  }

  it("reports aspect-ratio outliers instead of hiding flattened frames in geometry", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    for (let column = 0; column < 6; column++) {
      drawOpaqueRect(data, width, 0, column, 60, 60, 40, 40);
    }
    drawOpaqueRect(data, width, 0, 5, 60, 60, 12, 100);

    const result = summarizeAtlasPixels(data, width, 1);

    expect(result.proportionOutliers).toBe(1);
  });

  it("reports abrupt frame-to-frame jumps while tolerating steady motion", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    drawOpaqueRect(data, width, 0, 0, 60, 60, 40, 40);
    drawOpaqueRect(data, width, 0, 1, 62, 60, 40, 40);
    drawOpaqueRect(data, width, 0, 2, 142, 60, 40, 40);
    drawOpaqueRect(data, width, 0, 3, 144, 60, 40, 40);

    const result = summarizeAtlasPixels(data, width, 1);

    expect(result.continuityOutliers).toBeGreaterThan(0);
  });

  it("reports row-level proportion drift and directional edge contacts", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    for (let row = 0; row < 9; row++) {
      drawOpaqueRect(data, width, row, 0, 40, 60, 40, 40);
    }
    drawOpaqueRect(data, width, 8, 1, 0, 60, 100, 40);

    const result = summarizeAtlasPixels(data, width, 1);

    expect(result.rowProportionOutliers).toBeGreaterThan(0);
    expect(result.edgeTouches.left).toBe(1);
  });
});

it("classifies machine findings without treating manual review as approval", () => {
  const flags = classifyAuditEntry({
    error: "atlas dimensions disagree with declared sprite version",
    errorKind: "asset",
    summary: {
      expectedFrames: 57,
      emptyFrames: 1,
      touchingFrames: 2,
      geometryOutliers: 3,
      proportionOutliers: 4,
      continuityOutliers: 5,
      rowProportionOutliers: 1,
      edgeTouches: { left: 1, right: 0, top: 0, bottom: 1 },
      rowMedians: [],
    },
  });

  expect(flags).toEqual([
    "asset-error",
    "version-mismatch",
    "empty-frame",
    "edge-touch",
    "left-edge-touch",
    "bottom-edge-touch",
    "geometry-outlier",
    "flattened-proportion",
    "frame-continuity",
    "row-proportion",
  ]);
});

it("returns no machine flags for a clean asset while manual review stays separate", () => {
  expect(
    classifyAuditEntry({
      error: null,
      errorKind: null,
      summary: {
        expectedFrames: 57,
        emptyFrames: 0,
        touchingFrames: 0,
        geometryOutliers: 0,
        proportionOutliers: 0,
        continuityOutliers: 0,
        rowProportionOutliers: 0,
        edgeTouches: { left: 0, right: 0, top: 0, bottom: 0 },
        rowMedians: [],
      },
    }),
  ).toEqual([]);
});

it("projects only the stable public fields and redacts raw audit errors", () => {
  const publicEntry = toPublicAuditReviewEntry({
    slug: "demo",
    approvedAt: null,
    spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
    declaredVersion: 1,
    detectedVersion: null,
    width: null,
    height: null,
    bytes: null,
    summary: null,
    error: "asset request failed (403) internal-detail-marker",
    errorKind: "asset",
  });

  expect(publicEntry).toEqual({
    slug: "demo",
    spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
    declaredVersion: 1,
    detectedVersion: null,
    width: null,
    height: null,
    bytes: null,
    summary: null,
    machineFlags: ["asset-error"],
    errorCode: "asset-error",
    manualReview: {
      status: "pending",
      checks: MANUAL_REVIEW_CHECKS,
    },
  });
  expect(JSON.stringify(publicEntry)).not.toContain("internal-detail-marker");
  expect(JSON.stringify(publicEntry)).not.toContain("403");
});

it("keeps known audit failures on stable error codes", () => {
  const entry = {
    slug: "demo",
    approvedAt: null,
    spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
    declaredVersion: 2 as const,
    detectedVersion: null,
    width: null,
    height: null,
    bytes: null,
    summary: null,
    error: "asset read timed out",
    errorKind: "asset" as const,
  };

  expect(toPublicAuditReviewEntry(entry).errorCode).toBe("asset-read-timeout");
});

it("builds a public review report without internal error text", () => {
  const report = buildPublicAuditReviewReport(
    [
      {
        slug: "demo",
        approvedAt: null,
        spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        declaredVersion: 1,
        detectedVersion: null,
        width: null,
        height: null,
        bytes: null,
        summary: null,
        error: "asset request failed (500) internal-detail-marker",
        errorKind: "asset",
      },
    ],
    "manifest",
    "2026-08-26T00:00:00.000Z",
    "https://petdex.dev/api/manifest/v2",
  );

  expect(report.requested).toBe(1);
  expect(report.source).toBe("https://petdex.dev/api/manifest/v2");
  expect(report.assetHost).toBe("assets.petdex.dev");
  expect(report.entries).toHaveLength(1);
  expect(report.entries[0]?.errorCode).toBe("asset-error");
  expect(report.entries[0]?.summary).toBeNull();
  expect(JSON.stringify(report)).not.toContain("internal-detail-marker");
});

it("rejects an untrusted asset URL at the public projection boundary", () => {
  expect(() =>
    toPublicAuditReviewEntry({
      slug: "demo",
      approvedAt: null,
      spritesheetUrl: "https://example.test/demo.webp",
      declaredVersion: 1,
      detectedVersion: null,
      width: null,
      height: null,
      bytes: null,
      summary: null,
      error: null,
      errorKind: null,
    }),
  ).toThrow("untrusted spritesheet host");
});

it("omits unstable row median details from the public entry summary", () => {
  const entry = toPublicAuditReviewEntry({
    slug: "demo",
    approvedAt: null,
    spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
    declaredVersion: 1,
    detectedVersion: 1,
    width: 1536,
    height: 1872,
    bytes: 42,
    summary: {
      expectedFrames: 57,
      emptyFrames: 0,
      touchingFrames: 0,
      geometryOutliers: 1,
      proportionOutliers: 2,
      continuityOutliers: 3,
      rowProportionOutliers: 4,
      edgeTouches: { left: 0, right: 0, top: 0, bottom: 0 },
      rowMedians: [{ row: 0, width: 1, height: 2, aspectRatio: 0.5 }],
    },
    error: null,
    errorKind: null,
  });

  expect(entry.summary).toEqual({
    expectedFrames: 57,
    emptyFrames: 0,
    touchingFrames: 0,
    geometryOutliers: 1,
    proportionOutliers: 2,
    continuityOutliers: 3,
    rowProportionOutliers: 4,
    edgeTouches: { left: 0, right: 0, top: 0, bottom: 0 },
  });
  expect(JSON.stringify(entry)).not.toContain("rowMedians");
});

describe("manifest parsing", () => {
  it("parses the compact v2 manifest and resolves relative assets", () => {
    const pets = parseCompactManifest({
      v: 2,
      total: 1,
      fields: [
        "slug",
        "displayName",
        "kind",
        "submittedBy",
        "spritesheet",
        "petJson",
        "zip",
        "spriteVersionNumber",
      ],
      assetBase: "https://assets.petdex.dev",
      pets: [
        [
          "demo",
          "Demo",
          "character",
          null,
          "pets/demo/sprite.webp",
          "pets/demo/pet.json",
          null,
          2,
        ],
      ],
    });
    expect(pets).toEqual([
      {
        slug: "demo",
        approvedAt: null,
        spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        spriteVersionNumber: 2,
      },
    ]);
  });

  it("keeps the legacy manifest fallback strict and host-bound", () => {
    const pets = parseLegacyManifest({
      pets: [
        {
          slug: "demo",
          spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        },
      ],
    });
    expect(pets[0]?.spriteVersionNumber).toBe(1);
    expect(() =>
      resolveManifestAsset(undefined, "https://example.test/sprite.webp"),
    ).toThrow("untrusted spritesheet host");
  });

  it("rejects malformed compact entries instead of defaulting their version", () => {
    expect(() =>
      parseCompactManifest({
        v: 2,
        total: 1,
        fields: [
          "slug",
          "displayName",
          "kind",
          "submittedBy",
          "spritesheet",
          "petJson",
          "zip",
          "spriteVersionNumber",
        ],
        assetBase: "https://assets.petdex.dev",
        pets: [["demo", "Demo", "character", null, "pets/demo/sprite.webp"]],
      }),
    ).toThrow("invalid compact manifest pet");
  });

  it("rejects compact schema drift before reading fixed tuple positions", () => {
    const base = {
      v: 2,
      total: 1,
      fields: [
        "slug",
        "displayName",
        "kind",
        "submittedBy",
        "spritesheet",
        "petJson",
        "zip",
        "spriteVersionNumber",
      ],
      assetBase: "https://assets.petdex.dev",
      pets: [
        [
          "demo",
          "Demo",
          "character",
          null,
          "pets/demo/sprite.webp",
          "pets/demo/pet.json",
          null,
          2,
        ],
      ],
    };

    expect(() => parseCompactManifest({ ...base, v: 3 })).toThrow(
      "invalid compact manifest",
    );
    expect(() =>
      parseCompactManifest({
        ...base,
        fields: [...base.fields.slice(0, -1), "version"],
      }),
    ).toThrow("invalid compact manifest fields");
    expect(() => parseCompactManifest({ ...base, total: 2 })).toThrow(
      "compact manifest total",
    );
    expect(() =>
      parseCompactManifest({ ...base, assetBase: "https://example.test" }),
    ).toThrow("invalid compact manifest assetBase");
  });
});
