const decoder = new TextDecoder();
const herdr = process.env.HERDR_BIN_PATH || "herdr";

type PluginList = {
  result?: {
    plugins?: Array<{
      enabled?: boolean;
      source?: {
        kind?: string;
        requested_ref?: string;
        resolved_commit?: string;
      };
      warnings?: string[];
    }>;
  };
};

type ActionInvocation = {
  result?: { log?: { log_id?: string } };
};

type PluginLog = {
  log_id?: string;
  status?: string;
  stderr?: string;
};

type PluginLogs = {
  result?: { logs?: PluginLog[] };
};

function run(args: string[], allowFailure = false): string {
  const child = Bun.spawnSync([herdr, ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = decoder.decode(child.stdout).trim();
  const stderr = decoder.decode(child.stderr).trim();
  if (child.exitCode !== 0) {
    if (allowFailure) return "";
    throw new Error(stderr || stdout || `${herdr} ${args.join(" ")} failed`);
  }
  return stdout;
}

function parse<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid Herdr JSON: ${raw}`);
  }
}

async function install(): Promise<void> {
  const source = process.env.HERDR_PLUGIN_SOURCE;
  const ref = process.env.HERDR_PLUGIN_REF;
  if (!source || !ref) throw new Error("Missing managed plugin source or ref");
  run(["plugin", "install", source, "--ref", ref, "--yes"]);
  const listed = parse<PluginList>(
    run(["plugin", "list", "--plugin", "dev.petdex.bridge", "--json"]),
  );
  const plugin = listed.result?.plugins?.[0];
  if (!plugin?.enabled) throw new Error("Managed Petdex plugin is not enabled");
  if (plugin.source?.kind !== "github")
    throw new Error("Petdex plugin is not GitHub-managed");
  if (plugin.source?.requested_ref !== ref)
    throw new Error("Managed Petdex plugin requested the wrong ref");
  if (plugin.source?.resolved_commit !== ref)
    throw new Error("Managed Petdex plugin resolved the wrong commit");
  if (plugin.warnings?.length)
    throw new Error(
      `Managed Petdex plugin warnings: ${plugin.warnings.join(", ")}`,
    );
}

async function waitForServer(): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverRunning()) return true;
    await Bun.sleep(100);
  }
  return false;
}

function serverRunning(): boolean {
  return /^status:\s+running$/m.test(run(["status", "server"], true));
}

async function action(): Promise<void> {
  let server: ReturnType<typeof Bun.spawn> | undefined;
  if (!serverRunning()) {
    server = Bun.spawn([herdr, "server"], {
      stderr: "pipe",
      stdout: "pipe",
    });
    if (!(await waitForServer())) throw new Error("Herdr server did not start");
  }
  try {
    const invoked = parse<ActionInvocation>(
      run([
        "plugin",
        "action",
        "invoke",
        "test",
        "--plugin",
        "dev.petdex.bridge",
      ]),
    );
    const logId = invoked.result?.log?.log_id;
    if (!logId) throw new Error("Herdr action returned no log id");
    let finished: PluginLog | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const logs = parse<PluginLogs>(
        run([
          "plugin",
          "log",
          "list",
          "--plugin",
          "dev.petdex.bridge",
          "--limit",
          "20",
        ]),
      );
      finished = logs.result?.logs?.find((entry) => entry.log_id === logId);
      if (finished?.status !== "running") break;
      await Bun.sleep(100);
    }
    if (finished?.status !== "succeeded")
      throw new Error(
        finished?.stderr || `Herdr action did not succeed: ${finished?.status}`,
      );
    const response = await fetch("http://127.0.0.1:7777/state");
    if (!response.ok) throw new Error("Petdex state endpoint is unavailable");
    const state = (await response.json()) as { state?: string };
    if (state.state !== "jumping")
      throw new Error(`Petdex did not receive Herdr action: ${state.state}`);
  } finally {
    if (server) {
      run(["server", "stop"], true);
      await server.exited;
    }
  }
}

const mode = process.argv[2];
if (mode === "install") await install();
else if (mode === "action") await action();
else throw new Error("Expected install or action");
