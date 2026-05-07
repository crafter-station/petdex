"use client";

import { useEffect, useRef, useState } from "react";

import { useUser } from "@clerk/nextjs";
import { track } from "@vercel/analytics";
import JSZip from "jszip";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileArchive,
  Loader2,
  Send,
  Upload,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { petStates } from "@/lib/pet-states";

type ParsedPet = {
  petId: string;
  displayName: string;
  description: string;
  zipBlob: Blob;
  zipFileName: string;
  spritesheetBlob: Blob;
  spritesheetExt: "webp" | "png";
  petJsonString: string;
  spritesheetUrl: string;
  spritesheetWidth: number;
  spritesheetHeight: number;
  issues: string[];
  source: "folder" | "zip";
};

type SubmissionReviewOutcome = {
  decision: "approved" | "rejected" | "hold";
  applied: boolean;
  reasonCode: string | null;
  summary: string | null;
};

type SubmissionResult =
  | { kind: "idle" }
  | { kind: "uploading"; step: "validating" | "uploading" | "registering" }
  | { kind: "error"; message: string }
  | {
      kind: "success";
      slug: string;
      displayName: string;
      status: "pending" | "approved" | "rejected";
      review: SubmissionReviewOutcome;
    };

type SubmitResponse = {
  slug: string;
  status: "pending" | "approved" | "rejected";
  review: SubmissionReviewOutcome;
};

const REQUIRED = { width: 1536, height: 1872 } as const;
const PETS_DIR = "~/.codex/pets";

export function PetSubmitForm() {
  const t = useTranslations("submit.form");
  const { isSignedIn, isLoaded, user } = useUser();
  const [parsed, setParsed] = useState<ParsedPet | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [submission, setSubmission] = useState<SubmissionResult>({
    kind: "idle",
  });

  const uploadErrorRef = useRef<string | null>(null);
  const [, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (parsed?.spritesheetUrl) URL.revokeObjectURL(parsed.spritesheetUrl);
    };
  }, [parsed?.spritesheetUrl]);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    setIsReading(true);
    setSubmission({ kind: "idle" });
    setParsed(null);

    try {
      const items = [...files];
      // True folder upload has a "/" inside webkitRelativePath
      // (e.g. "boba/pet.json"). A single dropped file via webkitGetAsEntry
      // gets stamped with just its filename, so we treat that as zip mode.
      const fromFolder = items.some((f) => f.webkitRelativePath?.includes("/"));
      const source: "folder" | "zip" = fromFolder ? "folder" : "zip";

      let petJsonString = "";
      let spritesheetBlob: Blob = new Blob();
      let spritesheetExt: "webp" | "png" = "webp";
      let zipBlob: Blob = new Blob();
      let zipFileName = "";
      let petIdFromName = "untitled";
      const issues: string[] = [];

      if (fromFolder) {
        // ── Folder upload path ──────────────────────────────────────────
        const findByBase = (...names: string[]) => {
          for (const name of names) {
            const hit = items.find(
              (f) =>
                f.name === name ||
                f.webkitRelativePath?.endsWith(`/${name}`) ||
                f.webkitRelativePath === name,
            );
            if (hit) return hit;
          }
          return undefined;
        };

        const petFile = findByBase("pet.json");
        const spriteWebp = findByBase("spritesheet.webp");
        const spritePng = findByBase("spritesheet.png");
        const spriteFile = spriteWebp ?? spritePng;
        spritesheetExt = spriteWebp ? "webp" : "png";

        if (!petFile) issues.push(t("issues.folderMissingPetJson"));
        if (!spriteFile) {
          const present = items
            .slice(0, 6)
            .map((f) => f.webkitRelativePath || f.name)
            .join(", ");
          issues.push(t("issues.folderMissingSpritesheet", { present }));
        }

        if (petFile) {
          petJsonString = await petFile.text();
        }
        if (spriteFile) {
          spritesheetBlob = spriteFile;
        }

        // Derive pet id from top-level folder name (boba/pet.json → "boba")
        const firstPath =
          petFile?.webkitRelativePath || spriteFile?.webkitRelativePath || "";
        const folderName = firstPath.split("/")[0] || "untitled";
        petIdFromName = folderName;

        // Build a fresh zip in memory so server flow stays unchanged.
        if (petFile && spriteFile) {
          const zip = new JSZip();
          zip.file("pet.json", petJsonString);
          zip.file(`spritesheet.${spritesheetExt}`, spritesheetBlob);
          zipBlob = await zip.generateAsync({
            type: "blob",
            compression: "DEFLATE",
          });
          zipFileName = `${folderName}.zip`;
        }
      } else {
        // ── ZIP upload path (legacy) ────────────────────────────────────
        const zipFile = items.find((f) => f.name.endsWith(".zip"));
        if (!zipFile) {
          setParsed({
            petId: "missing",
            displayName: t("defaults.missingFiles"),
            description: t("drop.short"),
            zipBlob: new Blob(),
            zipFileName: "",
            spritesheetBlob: new Blob(),
            spritesheetExt: "webp",
            petJsonString: "",
            spritesheetUrl: "",
            spritesheetWidth: 0,
            spritesheetHeight: 0,
            issues: [t("issues.dropPetFolderOrZip")],
            source: "zip",
          });
          return;
        }

        const buf = await zipFile.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        const petJsonEntry = zip.file("pet.json");
        const webpEntry = zip.file("spritesheet.webp");
        const pngEntry = zip.file("spritesheet.png");
        const spriteEntry = webpEntry ?? pngEntry;
        spritesheetExt = webpEntry ? "webp" : "png";

        // Detect "petdex-approved.zip" — the all-pets bundle, not a single pet.
        const allFiles = Object.keys(zip.files);
        const looksLikeBundle =
          !petJsonEntry &&
          allFiles.some((p) => p.includes("/pet.json")) &&
          allFiles.length > 4;

        if (looksLikeBundle) {
          issues.push(t("issues.allPetsBundle"));
        } else {
          if (!petJsonEntry) issues.push(t("issues.zipMissingPetJson"));
          if (!spriteEntry) {
            issues.push(
              t("issues.zipMissingSpritesheet", {
                present: allFiles.slice(0, 5).join(", "),
              }),
            );
          }
        }

        petJsonString = petJsonEntry ? await petJsonEntry.async("string") : "";
        spritesheetBlob = spriteEntry
          ? await spriteEntry.async("blob")
          : new Blob();
        zipBlob = new Blob([buf], { type: "application/zip" });
        zipFileName = zipFile.name;
        petIdFromName = zipFile.name.replace(/\.zip$/i, "");
      }

      // ── Common: parse pet.json, validate sprite dims ──────────────────
      let petJson: Record<string, unknown> = {};
      if (petJsonString) {
        try {
          petJson = JSON.parse(petJsonString);
        } catch {
          issues.push(t("issues.invalidJson"));
        }
      }

      const spritesheetUrl = spritesheetBlob.size
        ? URL.createObjectURL(spritesheetBlob)
        : "";

      let width = 0;
      let height = 0;
      if (spritesheetUrl) {
        ({ width, height } = await measureImage(spritesheetUrl));
        if (width === 0 || height === 0) {
          issues.push(t("issues.unreadableSpritesheet"));
        } else if (width < 256 || height < 256) {
          issues.push(
            t("issues.tooSmall", {
              width,
              height,
              recommendedWidth: REQUIRED.width,
              recommendedHeight: REQUIRED.height,
            }),
          );
        }
      }

      const displayName =
        typeof petJson.displayName === "string" && petJson.displayName.trim()
          ? petJson.displayName.trim()
          : t("defaults.untitledPet");
      const description =
        typeof petJson.description === "string" && petJson.description.trim()
          ? petJson.description.trim()
          : t("defaults.description");
      const petId =
        typeof petJson.id === "string" && petJson.id.trim()
          ? petJson.id.trim()
          : petIdFromName;

      setParsed({
        petId,
        displayName,
        description,
        zipBlob,
        zipFileName,
        spritesheetBlob,
        spritesheetExt,
        petJsonString,
        spritesheetUrl,
        spritesheetWidth: width,
        spritesheetHeight: height,
        issues,
        source,
      });

      if (issues.length === 0) {
        track("pet_pack_validated", {
          pet_id: petId,
          size_kb: Math.round(zipBlob.size / 1024),
          width,
          height,
          source,
        });
      } else {
        track("pet_pack_validation_failed", {
          pet_id: petId,
          issue_count: issues.length,
          first_issue: (issues[0] ?? "unknown").slice(0, 80),
          source,
          width,
          height,
          file_count: items.length,
        });
      }
    } finally {
      setIsReading(false);
    }
  }

  async function handleSubmit() {
    if (!parsed || parsed.issues.length > 0) return;
    if (!isSignedIn) return;

    const startedAt = performance.now();
    let uploadStartedAt = startedAt;
    let uploadFinishedAt = startedAt;
    track("pet_submission_started", { pet_id: parsed.petId });
    setSubmission({ kind: "uploading", step: "validating" });

    const zipFile = new File([parsed.zipBlob], parsed.zipFileName, {
      type: "application/zip",
    });
    const spriteMime =
      parsed.spritesheetExt === "png" ? "image/png" : "image/webp";
    const spriteFile = new File(
      [parsed.spritesheetBlob],
      `${slugify(parsed.petId)}-spritesheet.${parsed.spritesheetExt}`,
      { type: spriteMime },
    );
    const petJsonFile = new File(
      [parsed.petJsonString],
      `${slugify(parsed.petId)}-pet.json`,
      { type: "application/json" },
    );

    setSubmission({ kind: "uploading", step: "uploading" });
    setUploadError(null);
    uploadErrorRef.current = null;

    // ── R2 presigned PUT flow (replaces UploadThing) ──────────────────────
    let zipUrl: string;
    let spritesheetUrl: string;
    let petJsonUrl: string;

    try {
      uploadStartedAt = performance.now();
      const presignRes = await fetch("/api/r2/presign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slugHint: slugify(parsed.petId),
          files: [
            {
              role: "zip",
              contentType: "application/zip",
              size: zipFile.size,
            },
            {
              role: "sprite",
              contentType: spriteMime,
              size: spriteFile.size,
            },
            {
              role: "petjson",
              contentType: "application/json",
              size: petJsonFile.size,
            },
          ],
        }),
      });

      if (!presignRes.ok) {
        const data = (await presignRes.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(
          data.message ?? data.error ?? `presign ${presignRes.status}`,
        );
      }

      const presignData = (await presignRes.json()) as {
        files: Array<{
          role: "zip" | "sprite" | "petjson";
          uploadUrl: string;
          publicUrl: string;
        }>;
      };

      const byRole = new Map(presignData.files.map((f) => [f.role, f]));
      const zipSlot = byRole.get("zip");
      const spriteSlot = byRole.get("sprite");
      const petJsonSlot = byRole.get("petjson");
      if (!zipSlot || !spriteSlot || !petJsonSlot) {
        throw new Error("presign response missing slots");
      }

      // Serialize the three R2 PUTs instead of Promise.all-ing them.
      // Three concurrent uploads of 2-3MB sprites saturate flaky / mobile
      // links and one of them aborts mid-flight. The reports in
      // crafter-station/petdex#22-#51 all hit "Failed to fetch" on the
      // parallel upload path. Sequential is slower but completes.
      const slots: Array<{
        role: "petjson" | "sprite" | "zip";
        slot: { uploadUrl: string; publicUrl: string };
        body: Blob;
        ct: string;
      }> = [
        // petjson first — smallest, validates auth/CORS/presign quickly.
        {
          role: "petjson",
          slot: petJsonSlot,
          body: petJsonFile,
          ct: "application/json",
        },
        { role: "sprite", slot: spriteSlot, body: spriteFile, ct: spriteMime },
        { role: "zip", slot: zipSlot, body: zipFile, ct: "application/zip" },
      ];

      for (const { role, slot, body, ct } of slots) {
        const res = await putToR2(slot.uploadUrl, body, ct);
        if (!res.ok) {
          throw new Error(
            `R2 PUT ${role} ${res.status} ${res.statusText} (${body.size} bytes)`,
          );
        }
      }

      zipUrl = zipSlot.publicUrl;
      spritesheetUrl = spriteSlot.publicUrl;
      petJsonUrl = petJsonSlot.publicUrl;
      uploadFinishedAt = performance.now();
    } catch (err) {
      const reason = (err as Error).message ?? "unknown";
      track("pet_submission_failed", {
        pet_id: parsed.petId,
        stage: "upload",
        reason: reason.slice(0, 120),
        duration_ms: elapsedMs(startedAt),
        duration_bucket: durationBucket(elapsedMs(startedAt)),
        upload_duration_ms: elapsedMs(uploadStartedAt),
      });
      setSubmission({
        kind: "error",
        message: t("errors.uploadFailed", { reason }),
      });
      return;
    }

    setSubmission({ kind: "uploading", step: "registering" });
    const registerStartedAt = performance.now();

    const res = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        zipUrl,
        spritesheetUrl,
        petJsonUrl,
        displayName: parsed.displayName,
        description: parsed.description,
        petId: parsed.petId,
        spritesheetWidth: parsed.spritesheetWidth,
        spritesheetHeight: parsed.spritesheetHeight,
      }),
    });

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      const errorCode = data.error ?? "unknown";
      track("pet_submission_failed", {
        pet_id: parsed.petId,
        stage: "register",
        error_code: errorCode,
        status: res.status,
        duration_ms: elapsedMs(startedAt),
        duration_bucket: durationBucket(elapsedMs(startedAt)),
        upload_duration_ms: Math.round(uploadFinishedAt - uploadStartedAt),
        register_duration_ms: elapsedMs(registerStartedAt),
        register_duration_bucket: durationBucket(elapsedMs(registerStartedAt)),
      });
      setSubmission({
        kind: "error",
        message: submissionErrorMessage(errorCode, t),
      });
      return;
    }

    const data = (await res.json()) as SubmitResponse;
    track("pet_submission_succeeded", {
      pet_id: parsed.petId,
      slug: data.slug,
      review_decision: data.review.decision,
      review_applied: data.review.applied,
      duration_ms: elapsedMs(startedAt),
      duration_bucket: durationBucket(elapsedMs(startedAt)),
      upload_duration_ms: Math.round(uploadFinishedAt - uploadStartedAt),
      register_duration_ms: elapsedMs(registerStartedAt),
      register_duration_bucket: durationBucket(elapsedMs(registerStartedAt)),
    });
    setSubmission({
      kind: "success",
      slug: data.slug,
      displayName: parsed.displayName,
      status: data.status,
      review: data.review,
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <fieldset
        className={`glass-panel flex min-h-80 flex-col items-center justify-center rounded-3xl p-8 text-center transition ${
          isDragging ? "bg-white/95 ring-2 ring-black/40 ring-offset-2" : ""
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (!isDragging) setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null))
            return;
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          void readDataTransfer(event.dataTransfer).then((files) => {
            if (files.length > 0) void handleFiles(files);
          });
        }}
      >
        <legend className="sr-only">{t("drop.ariaLabel")}</legend>
        <span className="grid size-16 place-items-center rounded-2xl bg-inverse text-on-inverse">
          <Upload className="size-7" />
        </span>
        <span className="mt-6 text-2xl font-medium text-foreground">
          {t("drop.title")}
        </span>
        <span className="mt-3 max-w-md text-sm leading-6 text-muted-2">
          {t.rich("drop.instructions", {
            petJson: (chunks) => (
              <code className="rounded bg-surface-muted px-1 py-0.5">
                {chunks}
              </code>
            ),
            spritesheet: (chunks) => (
              <code className="rounded bg-surface-muted px-1 py-0.5">
                {chunks}
              </code>
            ),
            width: REQUIRED.width,
            height: REQUIRED.height,
          })}
        </span>

        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover">
            <Upload className="size-3.5" />
            {t("drop.pickFolder")}
            <input
              type="file"
              {...({ webkitdirectory: "" } as Record<string, string>)}
              {...({ directory: "" } as Record<string, string>)}
              multiple
              className="sr-only"
              onChange={(event) =>
                void handleFiles(event.target.files).then(() => {
                  // Allow re-picking the same folder
                  event.target.value = "";
                })
              }
            />
          </label>
          <label className="inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-4 text-xs font-medium text-foreground transition hover:bg-surface">
            <FileArchive className="size-3.5" />
            {t("drop.pickZip")}
            <input
              type="file"
              accept=".zip"
              className="sr-only"
              onChange={(event) =>
                void handleFiles(event.target.files).then(() => {
                  event.target.value = "";
                })
              }
            />
          </label>
        </div>

        {!isLoaded ? null : !isSignedIn ? (
          <span className="mt-5 inline-flex items-center gap-2 rounded-full bg-chip-warning-bg px-3 py-1 font-mono text-[10px] tracking-[0.18em] text-chip-warning-fg uppercase">
            {t("auth.signIn")}
          </span>
        ) : null}
      </fieldset>

      <aside className="rounded-3xl border border-border-base bg-surface/80 p-5 shadow-sm shadow-blue-950/5 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <FileArchive className="size-4" />
          {t("check.title")}
        </div>

        {isReading ? (
          <p className="mt-6 inline-flex items-center gap-2 text-sm text-muted-2">
            <Loader2 className="size-3.5 animate-spin" />
            {t("check.reading")}
          </p>
        ) : parsed ? (
          <div className="mt-6 space-y-5">
            {parsed.spritesheetUrl ? (
              <SpritePreview src={parsed.spritesheetUrl} />
            ) : null}
            <div>
              <h2 className="text-xl font-medium">{parsed.displayName}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-2">
                {parsed.description}
              </p>
              {parsed.spritesheetWidth ? (
                <p className="mt-2 font-mono text-[10px] tracking-[0.18em] text-muted-4 uppercase">
                  {parsed.spritesheetWidth}×{parsed.spritesheetHeight}
                </p>
              ) : null}
            </div>
            {parsed.issues.length > 0 ? (
              <div className="flex items-start gap-2 rounded-2xl bg-chip-warning-bg p-4 text-sm leading-6 text-chip-warning-fg">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <ul className="space-y-1">
                  {parsed.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-2xl bg-chip-success-bg p-4 text-sm text-chip-success-fg">
                <CheckCircle2 className="size-4" />
                {t("check.ready")}
              </div>
            )}

            <SubmitButton
              disabled={
                parsed.issues.length > 0 ||
                !isSignedIn ||
                submission.kind === "uploading" ||
                submission.kind === "success"
              }
              submission={submission}
              onSubmit={() => void handleSubmit()}
            />

            {submission.kind === "error" ? (
              <div className="space-y-2 rounded-2xl bg-chip-danger-bg p-3 text-sm text-chip-danger-fg">
                <p>{submission.message}</p>
                <p className="text-xs leading-5 text-rose-800/80">
                  {t("fallback.beforeLink")}{" "}
                  <a
                    href={buildIssueUrl(
                      parsed,
                      submission.message,
                      user?.id ?? null,
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-4 hover:text-rose-950"
                  >
                    {t("fallback.link")}
                  </a>{" "}
                  {t("fallback.afterLink")}
                </p>
              </div>
            ) : null}

            {submission.kind === "success" ? (
              <SubmissionSuccessMessage submission={submission} />
            ) : null}
          </div>
        ) : (
          <p className="mt-6 text-sm leading-6 text-muted-2">
            {t("check.empty")}
          </p>
        )}
      </aside>

      <p className="col-span-full inline-flex flex-wrap items-center gap-2 text-xs text-muted-2">
        {t("path.prefix")}
        <code className="rounded bg-surface/70 px-1.5 py-0.5 font-mono">
          {PETS_DIR}
        </code>
        <CopyPathButton path={PETS_DIR} />
        <span className="text-[#9a9aa1]">{t("path.platforms")}</span>
      </p>
    </div>
  );
}

function SubmissionSuccessMessage({
  submission,
}: {
  submission: Extract<SubmissionResult, { kind: "success" }>;
}) {
  const t = useTranslations("submit.form.success");
  const explanation = reviewExplanation(submission.review, t);
  const tone =
    submission.review.decision === "approved"
      ? "bg-chip-success-bg text-chip-success-fg"
      : submission.review.decision === "rejected"
        ? "bg-chip-danger-bg text-chip-danger-fg"
        : "bg-chip-warning-bg text-chip-warning-fg";

  return (
    <div className={`rounded-2xl p-3 text-sm ${tone}`}>
      <p>{t(submission.review.decision, { name: submission.displayName })}</p>
      {explanation ? (
        <p className="mt-2 text-xs leading-5">{explanation}</p>
      ) : null}
      {submission.review.decision === "approved" ? (
        <a
          href={`/pets/${submission.slug}`}
          className="mt-2 inline-flex font-medium underline underline-offset-4"
        >
          {t("viewPet")}
        </a>
      ) : null}
    </div>
  );
}

function reviewExplanation(
  review: SubmissionReviewOutcome,
  t: ReturnType<typeof useTranslations>,
): string | null {
  const reasonCode = review.reasonCode ?? "";
  if (reasonCode.startsWith("duplicate_")) {
    return t("details.duplicate", {
      summary: review.summary ?? t("details.duplicateFallback"),
    });
  }
  if (reasonCode.startsWith("policy_")) return t("details.policy");
  if (reasonCode.startsWith("asset_")) return t("details.assets");
  if (reasonCode === "review_timeout") return t("details.timeout");
  if (reasonCode === "review_error" || reasonCode === "review_failed") {
    return t("details.reviewFailed");
  }
  if (review.decision === "rejected") return t("details.rejectedGeneric");
  if (review.decision === "hold") return t("details.holdGeneric");
  return null;
}

function submissionErrorMessage(
  code: string,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (code) {
    case "rate_limited":
      return t("errors.rateLimited");
    case "missing_field":
      return t("errors.missingField");
    case "invalid_spritesheet":
      return t("errors.invalidSpritesheet");
    case "invalid_asset_url":
      return t("errors.invalidAssetUrl");
    case "invalid_slug":
      return t("errors.invalidSlug");
    case "unauthorized":
      return t("errors.unauthorized");
    case "invalid_json":
      return t("errors.invalidJson");
    case "unknown":
      return t("errors.submissionFailed");
    default:
      return t("errors.submissionFailedWithCode", { code });
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function durationBucket(ms: number): string {
  if (ms < 5000) return "under_5s";
  if (ms < 15_000) return "5_15s";
  if (ms < 30_000) return "15_30s";
  return "over_30s";
}

function CopyPathButton({ path }: { path: string }) {
  const t = useTranslations("submit.form.copy");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  async function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(path);
      } else {
        // Fallback for non-secure contexts / older Safari
        const textarea = document.createElement("textarea");
        textarea.value = path;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
    } catch {
      /* swallow */
    }
  }

  return (
    <button
      type="button"
      aria-label={copied ? t("ariaCopied") : t("ariaCopy")}
      onClick={(e) => void handleClick(e)}
      className="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface/70 px-2 py-0.5 text-[11px] font-medium text-[#3a3a44] transition hover:bg-white dark:hover:bg-stone-800"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? t("copied") : t("copy")}
    </button>
  );
}

function SubmitButton({
  disabled,
  submission,
  onSubmit,
}: {
  disabled: boolean;
  submission: SubmissionResult;
  onSubmit: () => void;
}) {
  const t = useTranslations("submit.form.submitButton");
  const label =
    submission.kind === "uploading"
      ? submission.step === "validating"
        ? t("validating")
        : submission.step === "uploading"
          ? t("uploading")
          : t("finalizing")
      : submission.kind === "success"
        ? t("submitted")
        : t("idle");

  return (
    <button
      type="button"
      onClick={onSubmit}
      disabled={disabled}
      className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover disabled:cursor-not-allowed disabled:opacity-60"
    >
      {submission.kind === "uploading" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : submission.kind === "success" ? (
        <CheckCircle2 className="size-4" />
      ) : (
        <Send className="size-4" />
      )}
      {label}
    </button>
  );
}

function SpritePreview({ src }: { src: string }) {
  const t = useTranslations("submit.form.preview");
  const [index, setIndex] = useState(0);
  const animation = petStates[index];

  useEffect(() => {
    const interval = window.setInterval(() => {
      setIndex((current) => (current + 1) % petStates.length);
    }, 1500);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <div className="w-fit rounded-2xl border border-border-base bg-background p-3">
      <div
        className="pet-sprite-frame"
        role="img"
        aria-label={t("ariaLabel")}
        style={{ "--pet-scale": 0.5 } as React.CSSProperties}
      >
        <div
          className="pet-sprite"
          style={
            {
              "--sprite-url": `url(${src})`,
              "--sprite-row": animation.row,
              "--sprite-frames": animation.frames,
              "--sprite-duration": `${animation.durationMs}ms`,
            } as React.CSSProperties
          }
        />
      </div>
    </div>
  );
}

function measureImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

async function putToR2(
  url: string,
  body: Blob,
  contentType: string,
): Promise<Response> {
  // Three retries with exponential backoff. fetch() throws a generic
  // "Failed to fetch" with no diagnostic on network drop, so we wrap it
  // in XMLHttpRequest which gives us status / abort detection.
  const delays = [0, 800, 2000];
  let lastErr: Error | null = null;
  for (const delay of delays) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      return await xhrPut(url, body, contentType);
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw new Error(
    `R2 PUT network error: ${lastErr?.message ?? "unknown"} (size=${body.size}, type=${contentType})`,
  );
}

function xhrPut(
  url: string,
  body: Blob,
  contentType: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.timeout = 60_000; // 60s for a 3MB sprite is generous.
    xhr.onload = () => {
      // Construct a Response-like object the caller already expects.
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status,
          statusText: xhr.statusText,
        }),
      );
    };
    xhr.onerror = () => reject(new Error("xhr network error"));
    xhr.ontimeout = () => reject(new Error("xhr timeout"));
    xhr.onabort = () => reject(new Error("xhr aborted"));
    xhr.send(body);
  });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function buildIssueUrl(
  parsed: ParsedPet | null,
  message: string | undefined,
  userId: string | null,
): string {
  const title = parsed?.displayName
    ? `[Submit fail] ${parsed.displayName}`
    : "[Submit fail] Petdex upload";
  const description = parsed?.description?.trim();
  const sizeText = parsed?.spritesheetWidth
    ? `${parsed.spritesheetWidth}×${parsed.spritesheetHeight}`
    : "n/a";
  const body = [
    "## ⚠️ BEFORE YOU SUBMIT THIS ISSUE",
    "",
    "Without your pet files I cannot recover the upload. Please:",
    "",
    "- [ ] **Attach your zipped pet folder below** (drag-and-drop the .zip into the comment box). It must contain `pet.json` + `spritesheet.webp` (or `.png`).",
    "- [ ] If the pet has a backstory or tags I should add, paste them in a comment.",
    "",
    "Issues without a zip get closed after 48h because there is nothing for me to import.",
    "",
    "---",
    "",
    "## What the form captured",
    "",
    `- **Pet name:** ${parsed?.displayName ?? "n/a"}`,
    `- **Pet id:** ${parsed?.petId ?? "n/a"}`,
    `- **Sprite size:** ${sizeText}`,
    `- **Source:** ${parsed?.source ?? "n/a"}`,
    `- **Error:** ${message ?? "Unknown"}`,
    userId ? `- **User id:** \`${userId}\`` : "- **User id:** (not signed in)",
    description
      ? `- **Description:**\n  > ${description.replace(/\n/g, "\n  > ")}`
      : "- **Description:** (none captured)",
    "",
    "<!-- ⬇️ Drag-and-drop your pet folder zipped here ⬇️ -->",
  ].join("\n");

  const params = new URLSearchParams({
    title,
    body,
    labels: "submit-fallback",
  });
  return `https://github.com/crafter-station/petdex/issues/new?${params.toString()}`;
}

// Resolve a DataTransfer to a flat FileList-like array. If the user dropped a
// folder, recursively walks it via webkitGetAsEntry and stamps each File with
// `webkitRelativePath` so handleFiles() can detect folder mode and find files
// by their basename.
async function readDataTransfer(dt: DataTransfer): Promise<FileList> {
  const items = Array.from(dt.items);
  const hasEntry = items.some((it) => "webkitGetAsEntry" in it);

  if (!hasEntry) {
    return dt.files;
  }

  const collected: File[] = [];
  await Promise.all(
    items.map(async (item) => {
      const entry = (
        item as DataTransferItem & {
          webkitGetAsEntry?: () => FileSystemEntry | null;
        }
      ).webkitGetAsEntry?.();
      if (!entry) {
        const f = item.getAsFile?.();
        if (f) collected.push(f);
        return;
      }
      await walkEntry(entry, "", collected);
    }),
  );

  // Build a synthetic FileList from the collected array
  const dt2 = new DataTransfer();
  for (const f of collected) dt2.items.add(f);
  return dt2.files;
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: File[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) =>
      fileEntry.file(resolve, reject),
    );
    // Patch webkitRelativePath so the handler treats this as folder-mode
    const path = `${prefix}${entry.name}`;
    Object.defineProperty(file, "webkitRelativePath", {
      value: path,
      writable: false,
      configurable: true,
    });
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    await Promise.all(
      entries.map((child) => walkEntry(child, `${prefix}${entry.name}/`, out)),
    );
  }
}
