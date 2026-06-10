export type RouteCostBucketInput = {
  bucketStart: string;
  estimatedRequests: number;
  method: string;
  route: string;
  routeKind: string;
  samples: number;
};

export type RouteCostSourceBucketInput = RouteCostBucketInput & {
  referrerSource: string;
  trafficSource: string;
};

export type RouteCostAttributionRow = Omit<
  RouteCostSourceBucketInput,
  "bucketStart"
>;

export function combineRouteCostAttributionRows(
  legacyRows: RouteCostBucketInput[],
  sourceRows: RouteCostSourceBucketInput[],
  limit = 20,
): RouteCostAttributionRow[] {
  const sourceTotals = new Map<
    string,
    { estimatedRequests: number; samples: number }
  >();
  const out = new Map<string, RouteCostAttributionRow>();

  for (const row of sourceRows) {
    addToTotal(sourceTotals, legacyKey(row), row);
    addToOutput(out, outputKey(row), row);
  }

  for (const row of legacyRows) {
    const sourceTotal = sourceTotals.get(legacyKey(row));
    const residualEstimated =
      row.estimatedRequests - (sourceTotal?.estimatedRequests ?? 0);
    if (residualEstimated <= 0) continue;
    const residualSamples = Math.max(
      0,
      row.samples - (sourceTotal?.samples ?? 0),
    );
    addToOutput(out, outputKey(row, "unknown", "unknown"), {
      ...row,
      estimatedRequests: residualEstimated,
      referrerSource: "unknown",
      samples: residualSamples,
      trafficSource: "unknown",
    });
  }

  return [...out.values()]
    .filter((row) => row.estimatedRequests > 0)
    .sort((a, b) => {
      if (b.estimatedRequests !== a.estimatedRequests) {
        return b.estimatedRequests - a.estimatedRequests;
      }
      return (
        [
          a.route.localeCompare(b.route),
          a.method.localeCompare(b.method),
          a.trafficSource.localeCompare(b.trafficSource),
          a.referrerSource.localeCompare(b.referrerSource),
        ].find((n) => n !== 0) ?? 0
      );
    })
    .slice(0, limit);
}

function addToTotal(
  map: Map<string, { estimatedRequests: number; samples: number }>,
  key: string,
  row: Pick<RouteCostBucketInput, "estimatedRequests" | "samples">,
) {
  const current = map.get(key);
  map.set(key, {
    estimatedRequests:
      (current?.estimatedRequests ?? 0) + row.estimatedRequests,
    samples: (current?.samples ?? 0) + row.samples,
  });
}

function addToOutput(
  map: Map<string, RouteCostAttributionRow>,
  key: string,
  row: RouteCostSourceBucketInput,
) {
  const current = map.get(key);
  map.set(key, {
    estimatedRequests:
      (current?.estimatedRequests ?? 0) + row.estimatedRequests,
    method: row.method,
    referrerSource: row.referrerSource,
    route: row.route,
    routeKind: row.routeKind,
    samples: (current?.samples ?? 0) + row.samples,
    trafficSource: row.trafficSource,
  });
}

function legacyKey(row: RouteCostBucketInput): string {
  return [row.bucketStart, row.method, row.routeKind, row.route].join("\x1f");
}

function outputKey(
  row: RouteCostBucketInput,
  trafficSource?: string,
  referrerSource?: string,
): string {
  return [
    row.method,
    row.routeKind,
    row.route,
    trafficSource ?? (row as RouteCostSourceBucketInput).trafficSource,
    referrerSource ?? (row as RouteCostSourceBucketInput).referrerSource,
  ].join("\x1f");
}
