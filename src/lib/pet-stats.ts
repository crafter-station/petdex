import type { Metrics } from "@/lib/db/metrics";
import { petStates } from "@/lib/pet-states";

type PetStatsSource = {
  importedAt: string;
  metrics?: Pick<Metrics, "installCount" | "likeCount">;
  frames?: number | null;
  stateCount?: number | null;
};

export type PetStats = {
  vibrance: number;
  popularity: number;
  loved: number;
  freshness: number;
};

const DEFAULT_FRAME_TOTAL = petStates.reduce(
  (sum, state) => sum + state.frames,
  0,
);

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function toPercent(value: number, max: number) {
  if (max <= 0) return 0;
  return Math.round(clamp((value / max) * 100, 0, 100));
}

function getVibranceValue(pet: PetStatsSource) {
  if (typeof pet.frames === "number" && Number.isFinite(pet.frames)) {
    return Math.max(0, pet.frames);
  }
  if (typeof pet.stateCount === "number" && Number.isFinite(pet.stateCount)) {
    return Math.max(0, pet.stateCount);
  }
  return DEFAULT_FRAME_TOTAL;
}

function getNormalizedLogScore(value: number, max: number) {
  const safeValue = Math.max(0, value);
  const safeMax = Math.max(0, max);
  return toPercent(Math.log10(safeValue + 1), Math.log10(safeMax + 1));
}

export function computeStats(
  pet: PetStatsSource,
  allPets: PetStatsSource[],
): PetStats {
  const maxVibrance = allPets.reduce(
    (max, candidate) => Math.max(max, getVibranceValue(candidate)),
    0,
  );
  const maxInstalls = allPets.reduce(
    (max, candidate) => Math.max(max, candidate.metrics?.installCount ?? 0),
    0,
  );
  const maxLikes = allPets.reduce(
    (max, candidate) => Math.max(max, candidate.metrics?.likeCount ?? 0),
    0,
  );
  const approvedAt = new Date(pet.importedAt);
  const daysSinceApproved = Number.isNaN(approvedAt.getTime())
    ? 90
    : (Date.now() - approvedAt.getTime()) / (1000 * 60 * 60 * 24);

  return {
    vibrance: toPercent(getVibranceValue(pet), maxVibrance),
    popularity: getNormalizedLogScore(
      pet.metrics?.installCount ?? 0,
      maxInstalls,
    ),
    loved: getNormalizedLogScore(pet.metrics?.likeCount ?? 0, maxLikes),
    freshness: Math.round(100 - clamp((daysSinceApproved / 90) * 100, 0, 100)),
  };
}
