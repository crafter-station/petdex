import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Charge = {
  ServiceName?: string;
  ServiceCategory?: string;
  BilledCost?: number | string;
  ConsumedQuantity?: number | string;
  ConsumedUnit?: string;
  ChargePeriodStart?: string;
  Tags?: Record<string, string>;
};

type Bucket = {
  name: string;
  billed: number;
  consumed: number;
  unit: string;
  lines: number;
};

type DailyBucket = {
  day: string;
  service: string;
  billed: number;
  consumed: number;
};

const args = parseArgs(process.argv.slice(2));
const project = args.project ?? "petdex";
const days = numberArg(args.days ?? "1");
const to = args.to ?? new Date().toISOString();
const from =
  args.from ??
  new Date(new Date(to).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const outDir = args["out-dir"] ?? ".scratch/cost-reports";
const fromFile = args["from-file"];
const linkedProject = await readJsonIfExists<{ orgId?: string }>(
  ".vercel/project.json",
);
const teamId =
  args["team-id"] ?? process.env.VERCEL_TEAM_ID ?? linkedProject?.orgId;

const charges = fromFile
  ? await readChargesFile(fromFile)
  : await fetchCharges({
      teamId: requireTeamId(teamId),
      token: await readVercelToken(),
      from,
      to,
    });
const summary = summarize({ charges, project, from, to });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetDir = join(outDir, stamp);

await mkdir(targetDir, { recursive: true });
await writeFile(
  join(targetDir, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(join(targetDir, "summary.md"), renderMarkdown(summary));

console.log(`Wrote ${targetDir}/summary.json`);
console.log(`Wrote ${targetDir}/summary.md`);
console.log(
  `${project}: $${summary.project.billed.toFixed(3)} over ${summary.window.days.toFixed(
    2,
  )} days, projected $${summary.project.monthlyRunRate.toFixed(2)}/month`,
);

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    const value = argv[i + 1];
    parsed[key.slice(2)] = value?.startsWith("--") ? "true" : value;
    if (value && !value.startsWith("--")) i += 1;
  }
  return parsed;
}

function numberArg(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`Invalid number: ${value}`);
  return n;
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function requireTeamId(value: string | undefined): string {
  if (value) return value;
  throw new Error(
    "Missing --team-id, VERCEL_TEAM_ID, or .vercel/project.json orgId",
  );
}

async function readVercelToken(): Promise<string> {
  if (process.env.VERCEL_BILLING_TOKEN) return process.env.VERCEL_BILLING_TOKEN;
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const authPath =
    process.env.VERCEL_AUTH_JSON ??
    `${process.env.HOME}/Library/Application Support/com.vercel.cli/auth.json`;
  const auth = await readJsonIfExists<{ token?: string }>(authPath);
  if (!auth?.token)
    throw new Error(
      "Missing VERCEL_BILLING_TOKEN, VERCEL_TOKEN, or Vercel CLI auth token",
    );
  return auth.token;
}

async function readChargesFile(path: string): Promise<Charge[]> {
  return parseChargeLines(await readFile(path, "utf8"));
}

async function fetchCharges(input: {
  teamId: string;
  token: string;
  from: string;
  to: string;
}): Promise<Charge[]> {
  const url = new URL("https://api.vercel.com/v1/billing/charges");
  url.searchParams.set("teamId", input.teamId);
  url.searchParams.set("from", input.from);
  url.searchParams.set("to", input.to);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Accept-Encoding": "gzip",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `${response.status} Billing API rejected the token. Set VERCEL_BILLING_TOKEN or VERCEL_TOKEN with access to the team's billing charges. Response: ${body}`,
      );
    }
    throw new Error(`${response.status} ${body}`);
  }

  return parseChargeLines(await response.text());
}

function parseChargeLines(text: string): Charge[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Charge);
}

function summarize(input: {
  charges: Charge[];
  project: string;
  from: string;
  to: string;
}) {
  const projectTotals = new Map<string, Bucket>();
  const serviceTotals = new Map<string, Bucket>();
  const projectServiceTotals = new Map<string, Bucket>();
  const dailyServiceTotals = new Map<string, DailyBucket>();
  const tagKeys = new Set<string>();
  const windowDays =
    (new Date(input.to).getTime() - new Date(input.from).getTime()) /
    (24 * 60 * 60 * 1000);
  const monthlyFactor = 30 / windowDays;

  for (const charge of input.charges) {
    const billed = numeric(charge.BilledCost);
    const consumed = numeric(charge.ConsumedQuantity);
    const projectName = charge.Tags?.ProjectName ?? "(none)";
    const service = charge.ServiceName ?? charge.ServiceCategory ?? "(none)";
    const unit = charge.ConsumedUnit ?? "";

    for (const key of Object.keys(charge.Tags ?? {})) tagKeys.add(key);
    addBucket(projectTotals, projectName, billed, consumed, unit);
    addBucket(serviceTotals, service, billed, consumed, unit);

    if (projectName === input.project) {
      addBucket(projectServiceTotals, service, billed, consumed, unit);
      const day =
        String(charge.ChargePeriodStart ?? "").slice(0, 10) || "unknown";
      const key = `${day}|${service}`;
      const current = dailyServiceTotals.get(key) ?? {
        day,
        service,
        billed: 0,
        consumed: 0,
      };
      current.billed += billed;
      current.consumed += consumed;
      dailyServiceTotals.set(key, current);
    }
  }

  const projectBilled = projectTotals.get(input.project)?.billed ?? 0;
  const totalBilled = sum(
    [...projectTotals.values()].map((item) => item.billed),
  );

  return {
    generatedAt: new Date().toISOString(),
    window: {
      from: input.from,
      to: input.to,
      days: round(windowDays),
      rows: input.charges.length,
    },
    tagKeys: [...tagKeys].sort(),
    total: {
      billed: round(totalBilled),
    },
    project: {
      name: input.project,
      billed: round(projectBilled),
      share: totalBilled === 0 ? 0 : round(projectBilled / totalBilled),
      monthlyRunRate: round(projectBilled * monthlyFactor),
    },
    topProjects: sortedBuckets(projectTotals).slice(0, 10),
    topServices: sortedBuckets(projectServiceTotals).slice(0, 15),
    allServices: sortedBuckets(serviceTotals).slice(0, 15),
    dailyServiceHotspots: [...dailyServiceTotals.values()]
      .map(roundDaily)
      .sort((a, b) => b.billed - a.billed)
      .slice(0, 20),
  };
}

function numeric(value: number | string | undefined): number {
  return Number(value ?? 0);
}

function addBucket(
  map: Map<string, Bucket>,
  name: string,
  billed: number,
  consumed: number,
  unit: string,
) {
  const current = map.get(name) ?? {
    name,
    billed: 0,
    consumed: 0,
    unit,
    lines: 0,
  };
  current.billed += billed;
  current.consumed += consumed;
  current.lines += 1;
  if (!current.unit) current.unit = unit;
  map.set(name, current);
}

function sortedBuckets(map: Map<string, Bucket>): Bucket[] {
  return [...map.values()]
    .map((item) => ({
      ...item,
      billed: round(item.billed),
      consumed: round(item.consumed),
    }))
    .sort((a, b) => b.billed - a.billed);
}

function roundDaily(item: DailyBucket): DailyBucket {
  return {
    ...item,
    billed: round(item.billed),
    consumed: round(item.consumed),
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function renderMarkdown(summary: ReturnType<typeof summarize>): string {
  const lines = [
    "# Petdex Vercel Cost Report",
    "",
    `Generated: ${summary.generatedAt}`,
    `Window: ${summary.window.from} to ${summary.window.to}`,
    `Rows: ${summary.window.rows}`,
    "",
    "## Summary",
    "",
    `- Team billed: $${summary.total.billed.toFixed(3)}`,
    `- ${summary.project.name} billed: $${summary.project.billed.toFixed(3)}`,
    `- ${summary.project.name} share: ${(summary.project.share * 100).toFixed(1)}%`,
    `- ${summary.project.name} monthly run-rate: $${summary.project.monthlyRunRate.toFixed(2)}`,
    "",
    "## Top Project Services",
    "",
    "| Service | Billed | Consumed | Unit | Lines |",
    "| --- | ---: | ---: | --- | ---: |",
    ...summary.topServices.map(
      (item) =>
        `| ${item.name} | $${item.billed.toFixed(3)} | ${formatNumber(
          item.consumed,
        )} | ${item.unit} | ${item.lines} |`,
    ),
    "",
    "## Daily Service Hotspots",
    "",
    "| Day | Service | Billed | Consumed |",
    "| --- | --- | ---: | ---: |",
    ...summary.dailyServiceHotspots.map(
      (item) =>
        `| ${item.day} | ${item.service} | $${item.billed.toFixed(
          3,
        )} | ${formatNumber(item.consumed)} |`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(
    value,
  );
}
