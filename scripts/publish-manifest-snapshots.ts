import { createHash } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";

import { buildCollectionPreviewSnapshot } from "@/lib/public-collection-previews";
import {
  buildCompactManifest,
  buildLegacyManifest,
} from "@/lib/public-manifest";
import { R2_BUCKET, R2_PUBLIC_BASE, r2 } from "@/lib/r2";

type Mode = "check" | "apply";

type Snapshot = {
  label: string;
  key: string;
  body: string;
  count: number;
};

const mode = parseMode(process.argv[2]);
const legacyKey =
  process.env.PETDEX_MANIFEST_V1_SNAPSHOT_KEY ?? "manifests/petdex-v1.json";
const compactKey =
  process.env.PETDEX_MANIFEST_V2_SNAPSHOT_KEY ?? "manifests/petdex-v2.json";
const collectionPreviewsKey =
  process.env.PETDEX_COLLECTION_PREVIEWS_SNAPSHOT_KEY ??
  "manifests/collection-previews-v1.json";

const [legacyManifest, compactManifest, collectionPreviews] = await Promise.all(
  [
    buildLegacyManifest(),
    buildCompactManifest(),
    buildCollectionPreviewSnapshot(),
  ],
);

const snapshots: Snapshot[] = [
  {
    label: "manifest v1 snapshot",
    key: legacyKey,
    body: `${JSON.stringify(legacyManifest)}\n`,
    count: legacyManifest.total,
  },
  {
    label: "manifest v2 snapshot",
    key: compactKey,
    body: `${JSON.stringify(compactManifest)}\n`,
    count: compactManifest.total,
  },
  {
    label: "collection previews v1 snapshot",
    key: collectionPreviewsKey,
    body: `${JSON.stringify(collectionPreviews)}\n`,
    count: collectionPreviews.total,
  },
];

for (const snapshot of snapshots) {
  const bytes = Buffer.byteLength(snapshot.body);
  const sha256 = createHash("sha256").update(snapshot.body).digest("hex");
  const url = `${R2_PUBLIC_BASE}/${snapshot.key}`;

  console.log(`${snapshot.label} ${mode}`);
  console.log(`url ${url}`);
  console.log(`items ${snapshot.count}`);
  console.log(`bytes ${bytes}`);
  console.log(`sha256 ${sha256}`);

  if (mode === "apply") {
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: snapshot.key,
        Body: snapshot.body,
        ContentType: "application/json; charset=utf-8",
        CacheControl:
          "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
        Metadata: {
          "petdex-sha256": sha256,
        },
      }),
    );
    console.log("uploaded");
  }
}

function parseMode(raw: string | undefined): Mode {
  if (raw === "check" || raw === "apply") return raw;
  console.error(
    "usage: bun scripts/publish-manifest-snapshots.ts <check|apply>",
  );
  process.exit(2);
}
