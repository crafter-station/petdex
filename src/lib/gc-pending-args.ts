export type PendingGcOptions = {
  apply: boolean;
  ageHours: number;
};

function parseAge(raw: string): number {
  if (!raw || raw.startsWith("--")) {
    throw new Error("--age-hours requires a positive number");
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--age-hours must be a positive number");
  }
  return value;
}

export function parsePendingGcArgs(args: readonly string[]): PendingGcOptions {
  let apply = false;
  let ageHours = 24;
  let ageSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }

    let rawAge: string | undefined;
    if (arg === "--age-hours") {
      rawAge = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--age-hours=")) {
      rawAge = arg.slice("--age-hours=".length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }

    if (ageSeen) throw new Error("--age-hours may only be provided once");
    ageSeen = true;
    ageHours = parseAge(rawAge ?? "");
  }

  return { apply, ageHours };
}
