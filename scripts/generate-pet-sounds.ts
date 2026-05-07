import {
  listApprovedPetsMissingSound,
  type PetSoundCandidate,
  processPetSound,
} from "../src/lib/pet-sound";

type ScriptError = {
  slug: string;
  reason: string;
};

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const LIMIT = readNumberFlag("--limit");
const CONCURRENCY = Math.min(
  Math.max(readNumberFlag("--concurrency") ?? 2, 1),
  3,
);

const errors: ScriptError[] = [];

async function main() {
  const pets = await listApprovedPetsMissingSound(LIMIT);

  console.log(
    `${DRY ? "[DRY] " : ""}processing ${pets.length} approved pets missing sound_url with concurrency=${CONCURRENCY}`,
  );

  let nextIndex = 0;
  let processed = 0;

  async function worker(workerId: number) {
    while (true) {
      const index = nextIndex++;
      if (index >= pets.length) return;

      const pet = pets[index];
      try {
        await processOnePet(pet, index, pets.length, workerId);
        processed += 1;
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : String(error ?? "unknown");
        errors.push({ slug: pet.slug, reason });
        console.log(
          `[${index + 1}/${pets.length}] ${pet.slug} -> ERROR ${reason}`,
        );
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(CONCURRENCY, pets.length || 1) },
      (_, index) => worker(index + 1),
    ),
  );

  console.log(
    `done processed=${processed} errors=${errors.length} total=${pets.length}`,
  );

  if (errors.length > 0) {
    console.log("errors:");
    for (const error of errors) {
      console.log(`- ${error.slug}: ${error.reason}`);
    }
  }
}

async function processOnePet(
  pet: PetSoundCandidate,
  index: number,
  total: number,
  workerId: number,
) {
  const result = await processPetSound(pet, {
    dry: DRY,
    workerKey: `worker-${workerId}`,
  });

  if (DRY) {
    console.log(
      `[${index + 1}/${total}] ${pet.slug} -> ${result.brief.rationale} -> ${result.brief.duration.toFixed(1)}s`,
    );
    console.log(result.brief.promptForElevenLabs);
    return;
  }

  console.log(
    `[${index + 1}/${total}] ${pet.slug} -> ${result.brief.rationale} -> final.mp3 (${formatBytes(result.sizeBytes)}, ${result.lufs.toFixed(1)} LUFS)`,
  );
}

function readNumberFlag(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const raw = process.argv[index + 1];
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

await main();
