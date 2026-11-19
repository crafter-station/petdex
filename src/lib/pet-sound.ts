import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { generateText } from "ai";
import { and, eq, isNull, ne } from "drizzle-orm";

import { invalidatePetCaches } from "@/lib/db/cached-aggregates";
import { runtimeDb as db, schema } from "@/lib/db/runtime";
import { R2_BUCKET, R2_PUBLIC_BASE, r2 } from "@/lib/r2";
import { readResponseBodyBounded } from "@/lib/response-body";

const execFileAsync = promisify(execFile);

const SOUND_BRIEF_MODEL = "openai/gpt-5-mini";
const SOUND_BRIEF_DELAY_MS = 200;
const ELEVENLABS_DELAY_MS = 1200;
const ELEVENLABS_MAX_IN_FLIGHT = 2;
const MIN_FILE_BYTES = 5 * 1024;
const ELEVENLABS_MAX_PROMPT_CHARS = 450;
const MIN_ACCEPTABLE_LUFS = -17;
const MAX_ACCEPTABLE_LUFS = -15;
const MAX_RENDER_ATTEMPTS = 3;
// A generated clip is a few hundred KB. Cap the response and give the call a
// deadline: the request had neither, so a stalled or oversized upstream could
// hang the run or buffer without bound. The brief call carries a deadline for
// the same reason the other AI calls in this tree do.
const ELEVENLABS_MAX_BYTES = 8 * 1024 * 1024;
const ELEVENLABS_TIMEOUT_MS = 120_000;
const SOUND_BRIEF_TIMEOUT_MS = 15_000;
const RETRY_BACKOFF_MS = [4000, 10000, 30000] as const;

const SOUND_BRIEF_SYSTEM_PROMPT =
  "You design 2-3 second AUDIO PORTRAITS for animated pixel pets in a Pokedex-style catalog. The sound is NOT a musical jingle — it's a tiny SOUND STORY that captures what this specific pet IS DOING or what they EVOKE in pop culture.\n\nThink like a sound designer for Cuphead, Animal Crossing, or Pixar shorts: the audio CHARACTERIZES the pet through specific real-world or pop-culture sounds that match their description.\n\nGOOD examples:\n- An otter sipping bubble tea → STRAW SLURP + tapioca pearl pop + content sigh + tail-splash. NOT marimba.\n- A spider detective → vintage typewriter clack-clack-clack + carriage return bell + paper slide.\n- A fintech koala → cheerful CASH REGISTER ka-ching + coin tumble + happy bank-app notification chirp.\n- A Rick Rubin-style producer → SUDDEN bass drop + finger snap + record scratch tail.\n- A Microsoft Clippy paperclip → tiny WIN95 startup chord + paper rustling + spring-bounce.\n\nBAD examples (lazy/generic):\n- 'marimba 3-note ascending'\n- 'kalimba with bell ding'\n- 'soft piano descending'\n- ANYTHING that sounds like a UI notification jingle\n\nRULES:\n1. NO HUMAN VOICES OR HUMMING. No vocal exclamations, no 'mmm', no breathing, no whispers. Foley vocals like a slurp or sneeze are OK if they fit the pet's action.\n2. The sound NARRATES what the pet does or references what it evokes. Honor pop culture references in descriptions (Spider-Man Noir, Rick Rubin, Microsoft Clippy, etc.).\n3. 2-3 sound elements layered or sequenced in time. Each element specific (named action or instrument), not generic.\n4. Phone-speaker audible. Punchy lead in the first 300ms.\n5. Cute, charming, family-friendly. Not scary, not muddy, not ambient.\n6. AVOID ambient textures: tape hiss, vinyl crackle alone, room tone, studio breath, generic ambience. They produce muddy mixes.\n\nReturn JSON: { promptForElevenLabs: '<2-3 sentence prompt naming SPECIFIC actions or pop-culture references the description evokes, sequence the sounds in time, end with no human voice, no humming, no music bed>', duration: <number 1.8-2.8>, rationale: '<one sentence>' }";

export type PetSoundCandidate = {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  kind: "creature" | "object" | "character";
  vibes: string[];
  source: "submit" | "discover" | "claimed";
  soundUrl: string | null;
};

export type SoundBrief = {
  promptForElevenLabs: string;
  duration: number;
  rationale: string;
};

export type SoundError = {
  slug: string;
  reason: string;
};

export type SoundGenerationResult = {
  slug: string;
  brief: SoundBrief;
  soundUrl: string;
  sizeBytes: number;
  lufs: number;
};

type ProcessOptions = {
  dry?: boolean;
  workerKey?: string;
  soundBriefLimiter?: TimeGate;
  elevenLabsLimiter?: Semaphore;
};

type ElevenLabsResponse =
  | {
      ok: true;
      bytes: Buffer;
    }
  | {
      ok: false;
      status: number;
      body: string;
      retryable: boolean;
    };

export async function listApprovedPetsMissingSound(limit?: number) {
  const query = db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      displayName: schema.submittedPets.displayName,
      description: schema.submittedPets.description,
      kind: schema.submittedPets.kind,
      vibes: schema.submittedPets.vibes,
      source: schema.submittedPets.source,
      soundUrl: schema.submittedPets.soundUrl,
    })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.status, "approved"),
        ne(schema.submittedPets.source, "discover"),
        isNull(schema.submittedPets.soundUrl),
      ),
    );

  const rows =
    typeof limit === "number" ? await query.limit(limit) : await query;
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    kind: row.kind,
    vibes: (row.vibes as string[]) ?? [],
    source: row.source,
    soundUrl: row.soundUrl,
  })) satisfies PetSoundCandidate[];
}

export async function getApprovedPetMissingSoundBySlug(slug: string) {
  const row = await db.query.submittedPets.findFirst({
    where: and(
      eq(schema.submittedPets.slug, slug),
      eq(schema.submittedPets.status, "approved"),
      ne(schema.submittedPets.source, "discover"),
      isNull(schema.submittedPets.soundUrl),
    ),
  });

  if (!row) return null;

  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    kind: row.kind,
    vibes: (row.vibes as string[]) ?? [],
    source: row.source,
    soundUrl: row.soundUrl,
  } satisfies PetSoundCandidate;
}

export async function buildSoundBrief(
  pet: Pick<
    PetSoundCandidate,
    "slug" | "displayName" | "description" | "kind" | "vibes"
  >,
  limiter = defaultSoundBriefLimiter,
): Promise<SoundBrief> {
  await limiter.wait();

  const result = await generateText({
    model: SOUND_BRIEF_MODEL,
    system: SOUND_BRIEF_SYSTEM_PROMPT,
    abortSignal: AbortSignal.timeout(SOUND_BRIEF_TIMEOUT_MS),
    messages: [
      {
        role: "user",
        content: `Pet: ${JSON.stringify({
          slug: pet.slug,
          displayName: pet.displayName,
          description: pet.description,
          kind: pet.kind,
          vibes: pet.vibes,
        })}`,
      },
    ],
  });

  const raw = result.text;
  // The model is asked for a bare object and answers with a code fence or a
  // sentence of prose around it often enough that the strict parse below threw
  // a SyntaxError on replies that were perfectly good — and the throw landed
  // ahead of the shape check, so the intended `invalid_brief_shape` error was
  // unreachable for malformed JSON. Slicing to the outer braces first, the
  // same extraction `parsePolicyJson` and `textPolicyModerationPasses` do for
  // their model replies.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("invalid_brief_shape");
  }
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<SoundBrief>;

  if (
    typeof parsed.promptForElevenLabs !== "string" ||
    typeof parsed.rationale !== "string" ||
    typeof parsed.duration !== "number"
  ) {
    throw new Error("invalid_brief_shape");
  }

  return {
    promptForElevenLabs: fitElevenLabsPrompt(parsed.promptForElevenLabs),
    rationale: parsed.rationale.trim(),
    duration: clamp(parsed.duration, 1.8, 2.8),
  };
}

export async function processPetSound(
  pet: PetSoundCandidate,
  options: ProcessOptions = {},
): Promise<SoundGenerationResult> {
  const brief = await buildSoundBrief(pet, options.soundBriefLimiter);

  if (options.dry) {
    return {
      slug: pet.slug,
      brief,
      soundUrl: `${R2_PUBLIC_BASE}/pets/${pet.slug}/sound.mp3`,
      sizeBytes: 0,
      lufs: 0,
    };
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), "petdex-sound-"));

  try {
    let bestCandidate:
      | { normalizedPath: string; sizeBytes: number; lufs: number }
      | undefined;

    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt += 1) {
      const rawPath = path.join(tmpRoot, `${pet.slug}.${attempt}.raw.mp3`);
      const normalizedPath = path.join(
        tmpRoot,
        `${pet.slug}.${attempt}.sound.mp3`,
      );
      const rawBytes = await generateElevenLabsAudio(
        brief,
        options.workerKey ?? pet.slug,
        options.elevenLabsLimiter ?? defaultElevenLabsLimiter,
      );
      await writeFile(rawPath, rawBytes);

      await normalizeAudio(rawPath, normalizedPath);
      await rm(rawPath, { force: true });

      const normalizedStats = await stat(normalizedPath);
      if (normalizedStats.size <= MIN_FILE_BYTES) {
        await rm(normalizedPath, { force: true });
        throw new Error(
          `normalized_file_too_small:${normalizedStats.size.toString()}`,
        );
      }

      const lufs = await measureIntegratedLufs(normalizedPath);
      const candidate = {
        normalizedPath,
        sizeBytes: normalizedStats.size,
        lufs,
      };

      if (
        !bestCandidate ||
        Math.abs(candidate.lufs + 16) < Math.abs(bestCandidate.lufs + 16)
      ) {
        if (bestCandidate) {
          await rm(bestCandidate.normalizedPath, { force: true });
        }
        bestCandidate = candidate;
      } else {
        await rm(normalizedPath, { force: true });
      }

      if (lufs >= MIN_ACCEPTABLE_LUFS && lufs <= MAX_ACCEPTABLE_LUFS) {
        break;
      }
    }

    if (!bestCandidate) {
      throw new Error("sound_generation_failed_without_output");
    }

    if (
      bestCandidate.lufs < MIN_ACCEPTABLE_LUFS ||
      bestCandidate.lufs > MAX_ACCEPTABLE_LUFS
    ) {
      await rm(bestCandidate.normalizedPath, { force: true });
      throw new Error(`lufs_out_of_range:${bestCandidate.lufs.toFixed(1)}`);
    }

    const key = `pets/${pet.slug}/sound.mp3`;
    const body = await readFile(bestCandidate.normalizedPath);

    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: "audio/mpeg",
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );

    const soundUrl = `${R2_PUBLIC_BASE}/${key}`;
    await db
      .update(schema.submittedPets)
      .set({ soundUrl })
      .where(eq(schema.submittedPets.slug, pet.slug));
    await invalidatePetCaches(pet.slug);

    return {
      slug: pet.slug,
      brief,
      soundUrl,
      sizeBytes: bestCandidate.sizeBytes,
      lufs: bestCandidate.lufs,
    };
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function generateElevenLabsAudio(
  brief: SoundBrief,
  workerKey: string,
  semaphore: Semaphore,
): Promise<Buffer> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    const workerGate = getWorkerGate(workerKey);
    await semaphore.acquire();

    let response: ElevenLabsResponse;
    try {
      await workerGate.wait();
      response = await callElevenLabs(brief);
      await sleep(ELEVENLABS_DELAY_MS);
    } finally {
      semaphore.release();
    }

    if (response.ok) {
      return response.bytes;
    }

    if (!response.retryable) {
      throw new Error(`elevenlabs_${response.status}:${response.body}`);
    }

    if (attempt >= RETRY_BACKOFF_MS.length + 1) {
      throw new Error(`elevenlabs_retry_exhausted:${response.status}`);
    }

    await sleep(RETRY_BACKOFF_MS[attempt - 1]);
  }
}

async function callElevenLabs(brief: SoundBrief): Promise<ElevenLabsResponse> {
  const res = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
    method: "POST",
    headers: {
      "xi-api-key": requireEnv("ELEVENLABS_API_KEY"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: brief.promptForElevenLabs,
      duration_seconds: brief.duration,
      prompt_influence: 0.65,
      loop: false,
    }),
    signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
  });

  if (res.ok) {
    return {
      ok: true,
      bytes: await readResponseBodyBounded(res, ELEVENLABS_MAX_BYTES),
    };
  }

  // A bodyless error response is normal; readResponseBodyBounded throws on
  // one where res.text() returned "". Keep the empty-string behaviour so the
  // detail code falls back instead of the call failing.
  const body = await readResponseBodyBounded(res, ELEVENLABS_MAX_BYTES)
    .then((buf) => buf.toString("utf8"))
    .catch(() => "");
  const detailCode = getDetailCode(body);
  const retryable =
    res.status === 429 ||
    (res.status >= 500 && res.status <= 599) ||
    detailCode === "system_busy" ||
    detailCode === "rate_limited";

  return {
    ok: false,
    status: res.status,
    body: body.slice(0, 500),
    retryable,
  };
}

async function normalizeAudio(rawPath: string, normalizedPath: string) {
  await execFileAsync(ffmpegPath(), [
    "-y",
    "-i",
    rawPath,
    "-af",
    "dynaudnorm=p=0.71:m=8:s=8,loudnorm=I=-16:TP=-1.5:LRA=7",
    "-codec:a",
    "libmp3lame",
    "-qscale:a",
    "4",
    normalizedPath,
  ]);
}

async function measureIntegratedLufs(audioPath: string): Promise<number> {
  let stderr = "";

  try {
    const output = await execFileAsync(ffmpegPath(), [
      "-i",
      audioPath,
      "-af",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ]);
    stderr = output.stderr;
  } catch (error) {
    stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : stderr;
  }

  const matches = [...stderr.matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  const value = matches.at(-1)?.[1];
  if (!value) {
    throw new Error("unable_to_parse_lufs");
  }
  return Number.parseFloat(value);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}

function ffmpegPath() {
  return process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDetailCode(body: string) {
  try {
    const parsed = JSON.parse(body) as {
      detail?: { code?: string } | string;
    };
    if (parsed.detail && typeof parsed.detail === "object") {
      return parsed.detail.code;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function fitElevenLabsPrompt(prompt: string) {
  const suffix = "No human voice, no humming, no music bed.";
  const compact = prompt.replace(/\s+/g, " ").trim();
  const withoutSuffix = compact
    .replace(/no human voice, no humming, no music bed\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:\s]+$/g, "");

  const composed = `${withoutSuffix}. ${suffix}`.trim();
  if (composed.length <= ELEVENLABS_MAX_PROMPT_CHARS) {
    return composed;
  }

  const reserve = suffix.length + 2;
  const clipped = withoutSuffix
    .slice(0, Math.max(0, ELEVENLABS_MAX_PROMPT_CHARS - reserve))
    .trim()
    .replace(/[.,;:\s]+$/g, "");

  return `${clipped}. ${suffix}`.slice(0, ELEVENLABS_MAX_PROMPT_CHARS);
}

export class TimeGate {
  private nextAt = 0;
  private pending = Promise.resolve();

  constructor(private readonly spacingMs: number) {}

  wait() {
    const run = async () => {
      const now = Date.now();
      const waitMs = Math.max(0, this.nextAt - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      this.nextAt = Date.now() + this.spacingMs;
    };

    const promise = this.pending.then(run, run);
    this.pending = promise.catch(() => {});
    return promise;
  }
}

export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire() {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

const workerGates = new Map<string, TimeGate>();

function getWorkerGate(workerKey: string) {
  const existing = workerGates.get(workerKey);
  if (existing) return existing;
  const created = new TimeGate(ELEVENLABS_DELAY_MS);
  workerGates.set(workerKey, created);
  return created;
}

export const defaultSoundBriefLimiter = new TimeGate(SOUND_BRIEF_DELAY_MS);
export const defaultElevenLabsLimiter = new Semaphore(ELEVENLABS_MAX_IN_FLIGHT);
