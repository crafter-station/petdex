// Drives the opencode plugin through both plugin APIs with a fake context
// and a stubbed fetch, so no hook server or opencode install is needed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "petdex-opencode-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, ".petdex", "runtime"), { recursive: true });
writeFileSync(join(home, ".petdex", "runtime", "update-token"), "tok\n");

const posts = [];
globalThis.fetch = async (url, init) => {
  posts.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
  return new Response("{}");
};

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

try {
  const mod = await import("../src/assets/opencode-plugin.js");
  const plugin = mod.default;
  assert(plugin.id === "petdex", "V2 needs a stable plugin id");
  assert(typeof plugin.setup === "function", "V2 needs setup()");
  assert(plugin.server === mod.PetdexPlugin, "V1 server() must stay the hooks function");

  // V2
  const hooks = {};
  let release;
  const drained = new Promise((resolve) => { release = resolve; });
  const dir = "/work/project";
  const ctx = {
    location: { directory: dir },
    session: { get: async ({ sessionID }) => ({ id: sessionID, title: "Fix the build" }) },
    tool: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} }; } },
    event: {
      async *subscribe() {
        yield { type: "session.renamed", location: { directory: "/elsewhere" }, data: { sessionID: "other", title: "Not ours" } };
        yield { type: "session.renamed", location: { directory: dir }, data: { sessionID: "s1", title: "Renamed" } };
        yield { type: "session.idle", data: { sessionID: "s1" } };
        yield { type: "session.execution.failed", location: { directory: dir }, data: { sessionID: "s1", error: { type: "x", message: "boom" } } };
        release();
      },
    },
  };
  const cleanup = await plugin.setup(ctx);
  assert(typeof cleanup === "function", "setup must return a cleanup that aborts the stream");
  await hooks["execute.before"]({ tool: "read", sessionID: "s1", input: { filePath: "/work/project/a.ts" } });
  await hooks["execute.after"]({ tool: "bash", sessionID: "s1", input: { command: "bun test" }, status: "completed" });
  await drained;
  await new Promise((resolve) => setTimeout(resolve, 20));
  cleanup();

  const bubbles = posts.filter((p) => p.path === "/bubble").map((p) => p.body);
  const titles = posts.filter((p) => p.path === "/bubble/title").map((p) => p.body);
  const states = posts.filter((p) => p.path === "/state").map((p) => p.body.state);
  const texts = bubbles.map((b) => b.text).sort();
  assert(JSON.stringify(texts) === JSON.stringify(["Done.", "OpenCode hit an error.", "Ran bun", "Reading a.ts"]), `V2 bubbles: ${texts}`);
  assert(bubbles.every((b) => b.session_id === "s1" && b.title), "V2 bubbles carry the session and its title");
  assert(bubbles.every((b) => b.source_cwd === dir && !("source_app" in b)), "V2 reports the plugin location, not the service cwd");
  assert(titles.length === 1 && titles[0].title === "Renamed", "V2 forwards renames from its own location only");
  assert(JSON.stringify(states.sort()) === JSON.stringify(["failed", "idle", "running", "waving"]), `V2 states: ${states}`);

  posts.length = 0;
  const v1 = await plugin.server({ client: { session: { get: async () => ({ data: { title: "V1 title" } }) } } });
  await v1["tool.execute.before"]({ tool: "grep", sessionID: "s2" }, { args: { pattern: "todo" } });
  await v1.event({ event: { type: "session.idle", properties: { sessionID: "s2" } } });
  const v1Bubbles = posts.filter((p) => p.path === "/bubble").map((p) => p.body);
  assert(v1Bubbles[0].text === "Searching “todo”" && v1Bubbles[0].title === "V1 title", "V1 tool hook");
  assert(v1Bubbles[1].text === "Done.", "V1 idle event");

  console.log("opencode plugin test: V1 and V2 entrypoints forward tools, titles, and lifecycle");
} finally {
  rmSync(home, { recursive: true, force: true });
}
