import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClerkCliAuth } from "../clerk-cli-auth";
import type { ClerkCliAuthError, CredentialStore } from "../types";
import {
  createCredentialStore,
  KeychainCredentialStore,
} from "./credential-store";
import { withFileMutex } from "./file-mutex";

const native = new Map<string, string>();
let readError: Error | undefined;
let writeError: Error | undefined;
let deleteError: Error | undefined;
mock.module("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(
      _service: string,
      private account: string,
    ) {}
    getPassword() {
      if (readError) throw readError;
      return native.get(this.account) ?? null;
    }
    setPassword(value: string) {
      if (writeError) throw writeError;
      native.set(this.account, value);
    }
    deletePassword() {
      if (deleteError) throw deleteError;
      return native.delete(this.account);
    }
  },
}));

let directory: string;
let filePath: string;
let store: CredentialStore;
let fallback: CredentialStore;
let warning: ReturnType<typeof spyOn>;
beforeEach(async () => {
  native.clear();
  readError = writeError = deleteError = undefined;
  directory = await mkdtemp(join(tmpdir(), "petdex-keyring-test-"));
  filePath = join(directory, "credentials.json");
  store = createCredentialStore("keychain", {
    filePath,
    keychainService: "petdex-test",
  });
  fallback = createCredentialStore("file", { filePath });
  warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  warning.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

test("native success reads the keychain and removes both copies", async () => {
  await store.set("tokens", "native-token");
  await fallback.set("tokens", "old-file-token");
  expect(await store.get("tokens")).toBe("native-token");
  await store.delete("tokens");
  expect(native.size).toBe(0);
  expect(await fallback.get("tokens")).toBeNull();
});

test("missing native credentials use and clear the file fallback", async () => {
  await fallback.set("tokens", "file-token");
  expect(await store.get("tokens")).toBe("file-token");
  await store.delete("tokens");
  expect(await fallback.get("tokens")).toBeNull();
  expect(warning).not.toHaveBeenCalled();
});

test("provider read and write failures preserve the file fallback", async () => {
  readError = writeError = new Error("keychain locked");
  await store.set("tokens", "file-token");
  expect(await store.get("tokens")).toBe("file-token");
  expect(native.size).toBe(0);
  expect(warning).toHaveBeenCalledTimes(2);
  if (process.platform !== "win32") {
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  }
});

test("failed native deletion rejects after clearing the file copy", async () => {
  await store.set("tokens", "native-token");
  await fallback.set("tokens", "file-token");
  deleteError = new Error("keychain locked");
  await expect(store.delete("tokens")).rejects.toMatchObject({
    code: "storage",
    message: "Failed to delete keychain credential: keychain locked",
  });
  expect(native.get("default:tokens")).toBe("native-token");
  expect(await fallback.get("tokens")).toBeNull();
});

test("logout reports native failure after clearing both file entries", async () => {
  await fallback.set("tokens", "file-token");
  await fallback.set("user", "file-user");
  deleteError = new Error("access denied");
  const auth = new ClerkCliAuth({
    clientId: "test-client",
    issuer: "https://auth.example.test",
    storage: store,
  });
  await expect(auth.logout()).rejects.toMatchObject({ code: "storage" });
  expect(await fallback.get("tokens")).toBeNull();
  expect(await fallback.get("user")).toBeNull();
});

test("logout waits for the second cleanup when the first one fails", async () => {
  let finishCleanup: () => void = () => {};
  const cleanupGate = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  let cleaned = false;
  const auth = new ClerkCliAuth({
    clientId: "test-client",
    issuer: "https://auth.example.test",
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async (key) => {
        if (key === "tokens") throw new Error("access denied");
        await cleanupGate;
        cleaned = true;
      },
      replaceIfUnchanged: async () => false,
    },
  });
  let settled = false;
  const pending = auth.logout();
  void pending.catch(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  finishCleanup();
  await expect(pending).rejects.toMatchObject({ code: "storage" });
  expect(cleaned).toBe(true);
});

test("a keychain delete that cannot clear the fallback reports failure", async () => {
  // `get` falls through to the fallback when the keychain holds nothing, so
  // a delete that leaves a readable fallback copy behind is not a logout —
  // it is a "Signed out" that still runs the next command as the old
  // account. The failure is reported instead of warned away.
  //
  // Fallback-first also means the keychain is never reached when the fallback
  // delete fails: the abort leaves the keychain copy whole rather than
  // half-clearing both stores.
  const blocked = join(directory, "blocked");
  await writeFile(blocked, "not a directory");
  const storeWithBrokenFallback = createCredentialStore("keychain", {
    filePath: join(blocked, "credentials.json"),
    keychainService: "petdex-test",
  });

  await storeWithBrokenFallback.set("tokens", "native-token");
  await expect(storeWithBrokenFallback.delete("tokens")).rejects.toMatchObject({
    code: "storage",
  });
  expect(native.get("default:tokens")).toBe("native-token");
});

test("delete clears both copies and leaves nothing to read back", async () => {
  // The revival probe's core question: after a successful delete, no path
  // through `get` may still return the old credential — including when the
  // keychain never held the entry and the fallback was the only copy.
  await store.set("tokens", "native-token");
  await fallback.set("stale", "old-file-tokens");
  await store.delete("tokens");
  expect(native.get("default:tokens")).toBeUndefined();
  expect(await store.get("tokens")).toBeNull();

  // And when only the fallback holds the record: the keychain delete finds
  // nothing (`deletePassword()` false), the fallback delete removes the
  // only copy, and the read is empty.
  await fallback.set("tokens", "old-file-tokens");
  await store.delete("tokens");
  expect(await store.get("tokens")).toBeNull();
});

test("deleting a missing key does not create the credential file", async () => {
  await fallback.delete("tokens");
  expect(await stat(filePath).catch(() => null)).toBeNull();
});

test("a torn credential file is quarantined and replaced by a valid one", async () => {
  await writeFile(filePath, '{ "tokens": { "tokens": { "accessTok');

  expect(await fallback.get("tokens")).toBeNull();
  const quarantined = (await readdir(directory)).filter((name) =>
    name.startsWith("credentials.json.corrupt-"),
  );
  expect(quarantined).toHaveLength(1);
  expect(await readFile(join(directory, quarantined[0]), "utf8")).toBe(
    '{ "tokens": { "tokens": { "accessTok',
  );

  await fallback.set("tokens", "fresh");
  expect(await fallback.get("tokens")).toBe("fresh");
  expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
    tokens: "fresh",
  });
});

test("writes go through a temporary file and leave no debris", async () => {
  await fallback.set("tokens", "value");
  const names = await readdir(directory);
  expect(names).toEqual(["credentials.json"]);
  expect((await stat(filePath)).mode & 0o777).toBe(0o600);
});

describe("file store cross-process lock", () => {
  const lockPath = () => `${filePath}.lock`;

  test("a write waits while another holder has the lock, then proceeds", async () => {
    // The lock is held by a live, fresh holder: the write must queue behind
    // it rather than landing mid-section. Removing the lock releases it.
    const b = createCredentialStore("file", { filePath, lockTimeoutMs: 2_000 });
    await writeFile(lockPath(), `${process.pid}:holder\n`);

    let bDone = false;
    const bWrite = b.set("tokens", "b-new").then(() => {
      bDone = true;
    });
    await Bun.sleep(100);
    expect(bDone).toBe(false);
    expect(await stat(lockPath()).catch(() => null)).not.toBeNull();

    await rm(lockPath(), { force: true });
    await bWrite;
    expect(bDone).toBe(true);
    expect(await fallback.get("tokens")).toBe("b-new");
  });

  test("a stale lock left by a dead process is taken over", async () => {
    // A killed CLI leaves its lock behind; the pid in it names no process.
    // A pid that cannot exist (above the platform max) stands in for the
    // dead holder. Completing well inside the lock timeout is the proof the
    // takeover happened instead of the waiter timing out as busy.
    await writeFile(lockPath(), `999999999:dead-holder\n`);
    const start = Date.now();
    const store2 = createCredentialStore("file", {
      filePath,
      lockTimeoutMs: 10_000,
    });
    await store2.set("tokens", "after-steal");
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(await fallback.get("tokens")).toBe("after-steal");
    expect(await stat(lockPath()).catch(() => null)).toBeNull();
  });

  test("an old lock is taken over even when its pid names a live process", async () => {
    // A live holder renews its lock's mtime, so an old mtime means the
    // holder stopped renewing (wedged, or its pid was reused). The pid here
    // is this test's own, so only the age justifies the steal.
    await writeFile(lockPath(), `${process.pid}:stuck-holder\n`);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath(), old, old);
    const store2 = createCredentialStore("file", {
      filePath,
      lockTimeoutMs: 2_000,
    });
    await store2.set("tokens", "after-age-steal");
    expect(await fallback.get("tokens")).toBe("after-age-steal");
  });

  test("a live holder that keeps renewing its lock is never taken over", async () => {
    // The takeover rule must not fire on a holder that is merely slow: the
    // holder refreshes the mtime on a heartbeat well inside the stale
    // threshold. Simulated here by renewing the lock while a competitor
    // waits; it must time out as busy, not commit, and only the stop of the
    // heartbeat lets it through.
    const staleMs = 600;
    const competitor = createCredentialStore("file", {
      filePath,
      lockTimeoutMs: 1_500,
      lockStaleMs: staleMs,
    });
    const token = `${process.pid}:renewing-holder`;
    await writeFile(lockPath(), `${token}\n`);
    const renew = setInterval(() => {
      const now = new Date();
      void utimes(lockPath(), now, now).catch(() => {});
    }, 50);
    try {
      const blocked = await competitor.set("tokens", "would-be-intruder").then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(blocked).not.toBeNull();
      expect((blocked as Error).message).toContain("busy");
      expect(await fallback.get("tokens")).toBeNull();
    } finally {
      clearInterval(renew);
    }

    // Once the renewal stops, the same store takes the lock over after the
    // stale threshold instead of waiting out the whole timeout.
    await competitor.set("tokens", "after-renewal-stops");
    expect(await fallback.get("tokens")).toBe("after-renewal-stops");
  });

  test("an ownership check before the rename refuses a replaced lock", async () => {
    // The ownership check is the last thing a write does before its rename.
    // Simulate the lost lock deterministically: take the lock over from
    // inside the section, then ask it to commit. The probe in /tmp covers
    // the same failure through a real slow write and a second process; this
    // pins the mechanism.
    const holder = createCredentialStore("file", {
      filePath,
    }) as unknown as {
      withLock<T>(
        operation: (assertOwned: () => Promise<void>) => Promise<T>,
      ): Promise<T>;
    };
    const thiefToken = "999999999:thief";
    await holder.withLock(async (assertOwned) => {
      await writeFile(lockPath(), `${thiefToken}\n`);
      await expect(assertOwned()).rejects.toMatchObject({
        code: "storage",
        message: expect.stringContaining("taken over"),
      });
    });
    // The release after the refusal removed only a lock that still carried
    // this call's token — the thief's lock must survive it.
    expect((await readFile(lockPath(), "utf8")).trim()).toBe(thiefToken);
    await rm(lockPath(), { force: true });
  });

  test("a held lock makes the write fail instead of writing unlocked", async () => {
    // The lock exists and its holder is alive and fresh: waiting past the
    // timeout must report a busy file, not fall through to an unlocked write.
    await fallback.set("tokens", "kept");
    await writeFile(lockPath(), `${process.pid}:live-holder\n`);
    const impatient = createCredentialStore("file", {
      filePath,
      lockTimeoutMs: 60,
    });
    await expect(impatient.set("tokens", "clobbered")).rejects.toMatchObject({
      code: "storage",
      message: expect.stringContaining("busy"),
    });
    expect(await fallback.get("tokens")).toBe("kept");
  });

  test("the lock is released when the operation throws inside it", async () => {
    // A directory where the credential file belongs: the lock creates fine,
    // the read inside the locked section throws. The `finally` release is
    // what keeps a later command from waiting on a holder that already left.
    const taken = join(directory, "credentials.json");
    await mkdir(taken);
    const broken = createCredentialStore("file", {
      filePath: taken,
      lockTimeoutMs: 1_000,
    });
    await expect(broken.set("tokens", "x")).rejects.toMatchObject({
      code: "storage",
    });
    expect(await stat(lockPath()).catch(() => null)).toBeNull();

    // And the next writer is not wedged by it.
    const next = createCredentialStore("file", {
      filePath: taken,
      lockTimeoutMs: 1_000,
    });
    await expect(next.set("tokens", "y")).rejects.toMatchObject({
      code: "storage",
    });
  });

  test("a lock that cannot be created fails the write instead of degrading", async () => {
    // There is no unlocked fallback: an unusable lock means the write is
    // refused and reported, not committed without the lock.
    const blocked = join(directory, "blocked");
    await writeFile(blocked, "not a directory");
    const unatomic = createCredentialStore("file", {
      filePath,
      lockPath: join(blocked, "credentials.json.lock"),
      lockTimeoutMs: 500,
    });
    const failure = await unatomic.set("tokens", "x").then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).not.toBeNull();
    expect((failure as ClerkCliAuthError).code).toBe("storage");
    expect((failure as Error).message).toContain("create lock");
    // Nothing was written: there is no unlocked fallback.
    expect(await fallback.get("tokens")).toBeNull();
  });

  test("deleting under the lock does not leave the key visible", async () => {
    const a = createCredentialStore("file", { filePath });
    await a.set("tokens", "value");
    await a.delete("tokens");
    expect(await a.get("tokens")).toBeNull();
    expect(await stat(lockPath()).catch(() => null)).toBeNull();
  });
});

describe("lock liveness and commit ownership", () => {
  const lockPath = () => `${filePath}.lock`;

  test("a holder's heartbeat keeps its lock fresh past the stale threshold", async () => {
    // A write can take longer than `lockStaleMs` — the heartbeat is what
    // keeps it from looking wedged. The competitor addresses the same lock
    // file through a path with a `.` segment: a real second process has no
    // in-process mutex, and the mutex is keyed by the path string, so this
    // contends on the file lock without waiting in RAM. (`path.join` would
    // normalise the segment away, so the string is built by hand.)
    const staleMs = 200;
    const holder = createCredentialStore("file", {
      filePath,
      lockStaleMs: staleMs,
      lockHeartbeatMs: 60,
    }) as unknown as {
      withLock<T>(operation: () => Promise<T>): Promise<T>;
    };
    const competitor = createCredentialStore("file", {
      filePath,
      lockPath: `${directory}/./credentials.json.lock`,
      lockTimeoutMs: 500,
      lockStaleMs: staleMs,
    });

    let held = false;
    const holding = holder.withLock(async () => {
      held = true;
      await Bun.sleep(staleMs * 3);
    });
    while (!held) await Bun.sleep(5);

    const refused = await competitor.set("tokens", "intruder").then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(refused).not.toBeNull();
    expect((refused as Error).message).toContain("busy");
    await holding;
    // Nothing was written: the lock was never stolen from its live holder.
    expect(await fallback.get("tokens")).toBeNull();
    expect(await stat(lockPath()).catch(() => null)).toBeNull();
  });

  test("a commit whose lock was taken over before the rename writes nothing", async () => {
    // `writeAll` runs its ownership check after the (possibly slow) temp
    // write. The check it is given is the only thing that notices a takeover
    // between taking the lock and renaming. Replace the lock inside the
    // section and ask it to commit: the rename must be refused and the
    // previous contents must survive.
    await fallback.set("tokens", "kept");
    const store = createCredentialStore("file", { filePath }) as unknown as {
      withLock<T>(
        operation: (assertOwned: () => Promise<void>) => Promise<T>,
      ): Promise<T>;
      writeAll(
        values: Record<string, string>,
        assertOwned: () => Promise<void>,
      ): Promise<void>;
    };
    const thiefToken = "999999999:writeAll-thief";

    await store.withLock(async (assertOwned) => {
      await writeFile(lockPath(), `${thiefToken}\n`);
      await expect(
        store.writeAll({ tokens: "must-not-land" }, assertOwned),
      ).rejects.toMatchObject({
        code: "storage",
        message: expect.stringContaining("taken over"),
      });
    });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      tokens: "kept",
    });
    await rm(lockPath(), { force: true });
  });
});

describe("logout after a failed delete", () => {
  test("a failed logout leaves the records whole and says what failed", async () => {
    // Fallback-first ordering: the file copy goes first, so a keychain
    // failure leaves the keychain entry as the only copy — a complete old
    // record, never a half-delete. The invariant is that `get()` and the
    // reported outcome agree: the command is told the logout failed, and
    // the account it still acts as is one intact record, not a mix.
    const tokens = JSON.stringify({ accessToken: "native-token" });
    await store.set("tokens", tokens);
    await fallback.set("tokens", "file-token");
    deleteError = new Error("keychain locked");
    const auth = new ClerkCliAuth({
      clientId: "test-client",
      issuer: "https://auth.example.test",
      storage: store,
    });
    await expect(auth.logout()).rejects.toMatchObject({
      code: "storage",
      message: "Failed to delete keychain credential: keychain locked",
    });
    expect(await fallback.get("tokens")).toBeNull();
    // The surviving copy is the intact keychain record, and the error says
    // so; the fallback cannot come back to life behind a later delete.
    expect(native.get("default:tokens")).toBe(tokens);
    expect(await store.get("tokens")).toBe(tokens);
  });

  test("a failed fallback delete aborts before the keychain is touched", async () => {
    // The other branch: the first step fails, so nothing else is attempted.
    // The pair stays exactly as it was — coherent, and reported as a failure.
    const blocked = join(directory, "blocked-logout");
    await writeFile(blocked, "not a directory");
    const halfBroken = createCredentialStore("keychain", {
      filePath: join(blocked, "credentials.json"),
      keychainService: "petdex-test",
    });
    await halfBroken.set("tokens", "native-token");
    await expect(halfBroken.delete("tokens")).rejects.toMatchObject({
      code: "storage",
    });
    expect(native.get("default:tokens")).toBe("native-token");
    expect(await halfBroken.get("tokens")).toBe("native-token");
  });
});

describe("keychain write leaves no revivable fallback copy", () => {
  test("a later keychain miss does not resurrect an older file token", async () => {
    // A keychain-less run (locked keychain, npx without the native package)
    // stores the token in the file. The keychain works again and a new
    // login writes there. The old file copy is now a previous account's
    // token waiting for the keychain entry to disappear.
    await fallback.set("tokens", "old-file-token");
    await store.set("tokens", "native-token");
    expect(await store.get("tokens")).toBe("native-token");

    // The keychain entry vanishes: OS migration, keychain reset, the item
    // deleted in Keychain Access, a locked login keychain.
    native.delete("default:tokens");
    expect(await store.get("tokens")).toBeNull();
  });
});

describe("guarded write (replaceIfUnchanged)", () => {
  test("memory: the compare is exact", async () => {
    const memory = createCredentialStore("memory");
    expect(await memory.replaceIfUnchanged("tokens", null, "A")).toBe(true);
    expect(await memory.replaceIfUnchanged("tokens", "A", "B")).toBe(true);
    expect(await memory.replaceIfUnchanged("tokens", "A", "C")).toBe(false);
    expect(await memory.get("tokens")).toBe("B");
  });

  test("file: a guarded write lands only while the record is the one that was read", async () => {
    // The refresh scenario in miniature: a reader takes a snapshot of the
    // record, a login replaces it, and the reader's write-back arrives late.
    // The bytes it was computed from are gone, so it must be dropped — with
    // the other key left exactly as the login wrote it.
    const reader = createCredentialStore("file", { filePath });
    const login = createCredentialStore("file", { filePath });
    await reader.set("tokens", JSON.stringify({ accessToken: "A" }));
    const raw = (await reader.get("tokens")) as string;

    await login.set("tokens", JSON.stringify({ accessToken: "B" }));
    await login.set("user", JSON.stringify({ sub: "user_B" }));

    const written = await reader.replaceIfUnchanged(
      "tokens",
      raw,
      JSON.stringify({ accessToken: "A-refreshed" }),
    );
    expect(written).toBe(false);
    expect(JSON.parse((await reader.get("tokens")) as string)).toEqual({
      accessToken: "B",
    });
    // A refusal is not a partial write: the whole file is untouched.
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      tokens: JSON.stringify({ accessToken: "B" }),
      user: JSON.stringify({ sub: "user_B" }),
    });
    expect(await stat(`${filePath}.lock`).catch(() => null)).toBeNull();
  });

  test("file: a matching compare writes and still leaves no lock behind", async () => {
    const store1 = createCredentialStore("file", { filePath });
    await store1.set("tokens", "A");
    const raw = (await store1.get("tokens")) as string;
    expect(await store1.replaceIfUnchanged("tokens", raw, "B")).toBe(true);
    expect(await store1.get("tokens")).toBe("B");
    expect(await stat(`${filePath}.lock`).catch(() => null)).toBeNull();
  });

  test("file: the compare happens after the lock is won, not before", async () => {
    // The ordering is the guarantee: read-compare-write must all be inside
    // one lock section. Here the guarded write starts while the lock is held
    // by a live holder; the "holder" then commits B and releases. An
    // implementation that read A before blocking would now clobber B on the
    // way through. This one reads after winning the lock and refuses.
    const store1 = createCredentialStore("file", {
      filePath,
      lockTimeoutMs: 5_000,
    });
    await store1.set("tokens", "A");
    const lockPath = `${filePath}.lock`;
    await writeFile(lockPath, `${process.pid}:holder\n`);

    const guarded = store1.replaceIfUnchanged("tokens", "A", "refreshed");
    await Bun.sleep(100);
    await writeFile(filePath, JSON.stringify({ tokens: "B" }));
    await rm(lockPath, { force: true });

    expect(await guarded).toBe(false);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      tokens: "B",
    });
  });

  test("file: a refused compare writes nothing at all", async () => {
    // No key to compare against, so nothing is created — a guarded write
    // must not turn into a plain write when its expectation is stale.
    expect(await fallback.replaceIfUnchanged("tokens", "A", "B")).toBe(false);
    expect(await stat(filePath).catch(() => null)).toBeNull();
  });

  test("file: an expected-absent compare writes only while the key is absent", async () => {
    expect(await fallback.replaceIfUnchanged("tokens", null, "fresh")).toBe(
      true,
    );
    expect(await fallback.get("tokens")).toBe("fresh");
    expect(await fallback.replaceIfUnchanged("tokens", null, "again")).toBe(
      false,
    );
    expect(await fallback.get("tokens")).toBe("fresh");
  });

  test("file: a torn record is quarantined and the compare refuses", async () => {
    // A file nobody can parse yields no record to compare against, so the
    // guarded write refuses instead of replacing it with a value computed
    // from bytes that were never readable.
    await writeFile(filePath, '{"tokens": "{\\"accessToken');
    expect(await fallback.replaceIfUnchanged("tokens", "stale", "B")).toBe(
      false,
    );
    const quarantined = (await readdir(directory)).filter((name) =>
      name.startsWith("credentials.json.corrupt-"),
    );
    expect(quarantined).toHaveLength(1);
    expect(await stat(filePath).catch(() => null)).toBeNull();
  });

  test("keychain: the compare is against the native record", async () => {
    await store.set("tokens", "A");
    expect(await store.replaceIfUnchanged("tokens", "A", "B")).toBe(true);
    expect(native.get("default:tokens")).toBe("B");
    // The stale expectation is refused and the newer value survives.
    expect(await store.replaceIfUnchanged("tokens", "A", "C")).toBe(false);
    expect(native.get("default:tokens")).toBe("B");
    expect(await store.get("tokens")).toBe("B");
  });

  test("keychain: a guarded write clears the older file copy like set does", async () => {
    await store.set("tokens", "A");
    await fallback.set("tokens", "old-file-copy");
    expect(await store.replaceIfUnchanged("tokens", "A", "B")).toBe(true);
    expect(native.get("default:tokens")).toBe("B");
    // `get` falls back to the file whenever the keychain holds nothing, so a
    // leftover older copy would otherwise come back after a keychain reset.
    expect(await fallback.get("tokens")).toBeNull();
  });

  test("keychain: the guard is compared against the native record as well", async () => {
    // `whoami` pairs the profile with the token record it was fetched from.
    // On the keychain the guard read must be native too, or a profile write
    // conditioned on a token that changed is allowed through.
    await store.set("tokens", "A");
    await store.set("user", "U");
    expect(
      await store.replaceIfUnchanged("user", "U", "U2", {
        key: "tokens",
        expected: "A",
      }),
    ).toBe(true);
    expect(native.get("default:user")).toBe("U2");

    // The key to write still matches; only the guard is stale. Nothing may
    // be written — a refusal is not a partial write.
    expect(
      await store.replaceIfUnchanged("user", "U2", "U3", {
        key: "tokens",
        expected: "stale",
      }),
    ).toBe(false);
    expect(native.get("default:user")).toBe("U2");
  });

  test("keychain: an unreadable keychain delegates the compare to the file store", async () => {
    // With the keychain unreadable, the file is what every `get` answers
    // from, so it is also what the caller's snapshot came from — and the
    // file store's own (locked) swap is what the write must go through.
    await fallback.set("tokens", "A");
    readError = new Error("keychain locked");
    expect(await store.replaceIfUnchanged("tokens", "A", "B")).toBe(true);
    expect(await fallback.get("tokens")).toBe("B");
    // And a stale expectation is still refused in that mode.
    expect(await store.replaceIfUnchanged("tokens", "A", "C")).toBe(false);
    expect(await fallback.get("tokens")).toBe("B");
  });
});

describe("the write timeout covers the wait, not just the lock file", () => {
  const lockPath = () => `${filePath}.lock`;

  test("a write queued behind another operation still honours its own timeout", async () => {
    // The process-local mutex is entered before the lock-file deadline used
    // to start, so a second store could wait in RAM forever while promising
    // its caller `lockTimeoutMs`. The lock file here is held by a live, fresh
    // holder, so the first store sits in its own (long) wait; the second must
    // still give up on its 60 ms rather than inherit the first one's budget.
    await writeFile(lockPath(), `${process.pid}:external-holder\n`);
    const now = new Date();
    await utimes(lockPath(), now, now);

    const options = {
      filePath,
      lockPath: lockPath(),
      lockStaleMs: 60_000,
      lockHeartbeatMs: 1_000,
    };
    const patient = createCredentialStore("file", {
      ...options,
      lockTimeoutMs: 5_000,
    });
    const impatient = createCredentialStore("file", {
      ...options,
      lockTimeoutMs: 60,
    });

    const patientWrite = patient.set("a", "1").then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    );
    const impatientWrite = impatient.set("b", "2").then(
      () => ({ ok: true as const }),
      (error: Error) => ({ ok: false as const, message: error.message }),
    );

    // Settles on its own: the external lock is never released before this.
    const refused = await impatientWrite;
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("busy");
      expect(refused.message).toContain("60ms");
    }

    await rm(lockPath(), { force: true });
    expect(await patientWrite).toEqual({ ok: true });
    // The impatient write never ran: no second key was written.
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ a: "1" });
  });
});

describe("guarded writes in the production stores", () => {
  const PROFILE = JSON.stringify({ sub: "user_A", email: "a@example.test" });

  test("file: a stale guard refuses the write and leaves the file untouched", async () => {
    // `whoami` conditions the profile write on the token record the profile
    // was fetched with. The tracking tests use their own map-backed store, so
    // only this one executes the file store's guard.
    await writeFile(filePath, JSON.stringify({ tokens: "tok-A" }));
    expect(
      await fallback.replaceIfUnchanged("user", null, PROFILE, {
        key: "tokens",
        expected: "tok-A",
      }),
    ).toBe(true);
    expect(JSON.parse(await readFile(filePath, "utf8")).user).toBe(PROFILE);

    // A login replaced the token record: the profile fetched from the old one
    // must not be paired with it. The write goes through the store so the
    // profile stays where it is — only the guard can refuse what follows.
    await fallback.set("tokens", "tok-B");
    const applied = await fallback.replaceIfUnchanged(
      "user",
      PROFILE,
      JSON.stringify({ sub: "user_B" }),
      { key: "tokens", expected: "tok-A" },
    );
    expect(applied).toBe(false);
    // A refusal writes nothing at all, not even the key it compared.
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      tokens: "tok-B",
      user: PROFILE,
    });
  });

  test("memory: a stale guard refuses the write", async () => {
    const memory = createCredentialStore("memory");
    await memory.set("tokens", "tok-A");
    expect(
      await memory.replaceIfUnchanged("user", null, PROFILE, {
        key: "tokens",
        expected: "tok-A",
      }),
    ).toBe(true);

    await memory.set("tokens", "tok-B");
    // The target key is absent again, so only the guard can refuse this.
    await memory.delete("user");
    expect(
      await memory.replaceIfUnchanged("user", null, PROFILE, {
        key: "tokens",
        expected: "tok-A",
      }),
    ).toBe(false);
    expect(await memory.get("user")).toBeNull();
  });
});

describe("every write takes the process-local mutex", () => {
  test("a write cannot land while a repairing reader holds the mutex", async () => {
    // A reader that moves a torn file aside takes the mutex, re-reads inside
    // it and then renames. If a writer did not queue behind the same mutex,
    // it could commit between that re-read and the rename, and the reader
    // would move the brand-new credential away. Holding the mutex directly is
    // the deterministic version of that interleaving.
    const store = createCredentialStore("file", { filePath });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => {};
    const holdingStarted = new Promise<void>((resolve) => {
      holding = resolve;
    });

    const holder = withFileMutex(`${filePath}.lock`, async () => {
      holding();
      await gate;
    });
    await holdingStarted;

    let written = false;
    const write = store.set("tokens", "fresh").then(() => {
      written = true;
    });
    await Bun.sleep(100);
    expect(written).toBe(false);
    expect(await stat(filePath).catch(() => null)).toBeNull();

    release();
    await holder;
    await write;
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      tokens: "fresh",
    });
  });
});

describe("keychain compare-and-swap honesty", () => {
  test("a login that lands during the fallback read is seen by the compare", async () => {
    // The keychain holds nothing, so the compare has to consult the file
    // fallback — an await. A login that writes the keychain inside that await
    // is the newer session; comparing the value read *before* the await would
    // pass and overwrite it with a result derived from the record it replaced.
    const A = JSON.stringify({ accessToken: "A", expiresAt: 1 });
    const refreshed = JSON.stringify({
      accessToken: "A-refreshed",
      expiresAt: 2,
    });
    const B = JSON.stringify({ accessToken: "B", expiresAt: 3 });

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });

    const slowFallback: CredentialStore = {
      get: async (key) => {
        readStarted();
        await gate;
        return key === "tokens" ? A : null;
      },
      set: async () => {},
      delete: async () => {},
      replaceIfUnchanged: async () => false,
    };
    const quietFallback: CredentialStore = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      replaceIfUnchanged: async () => false,
    };
    const refresher = new KeychainCredentialStore(
      "petdex-test",
      "default",
      slowFallback,
    );
    const login = new KeychainCredentialStore(
      "petdex-test",
      "default",
      quietFallback,
    );

    // A refresh computed from A, consulting the fallback because the keychain
    // entry is empty — and paused inside that read.
    const refresh = refresher.replaceIfUnchanged("tokens", A, refreshed);
    await started;
    // A login for another account completes entirely while that read is held.
    await login.set("tokens", B);
    release();

    expect(await refresh).toBe(false);
    expect(native.get("default:tokens")).toBe(B);
  });
});
