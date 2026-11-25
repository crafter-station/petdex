import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CredentialStore, StorageKind } from "../types.js";
import { ClerkCliAuthError } from "../types.js";
import { FileMutexTimeoutError, withFileMutex } from "./file-mutex.js";

export interface CreateStoreOptions {
  keychainService?: string;
  environment?: string;
  filePath?: string;
  /**
   * Where the cross-process lock lives. Defaults to the credential file plus
   * `.lock`; overriding it is for layouts where that sibling cannot be
   * created, and for tests that need the uncreatable-lock path.
   */
  lockPath?: string;
  /**
   * How long a file-store write waits for the cross-process lock before it
   * gives up, reported as a storage error. A lock that cannot be created at
   * all is refused the same way — the store never writes without it, because
   * an unlocked read-modify-write can drop a concurrent writer's key. Tests
   * and very slow filesystems can lower the timeout; the default bounds one
   * CLI command's stall at a few seconds.
   */
  lockTimeoutMs?: number;
  /**
   * A lock whose mtime is older than this may belong to a holder that
   * stopped renewing it. Live holders refresh the mtime every
   * `lockHeartbeatMs`, so only a wedged holder or a reused pid trips this.
   */
  lockStaleMs?: number;
  /** How often a live holder refreshes the lock's mtime. */
  lockHeartbeatMs?: number;
}

type KeyringModule = typeof import("@napi-rs/keyring");

function storageError(message: string, error: unknown): ClerkCliAuthError {
  if (error instanceof ClerkCliAuthError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ClerkCliAuthError("storage", `${message}: ${detail}`);
}

function environmentName(options?: CreateStoreOptions): string {
  return options?.environment ?? "default";
}

function defaultFilePath(environment: string): string {
  return join(homedir(), ".config", "clerk-cli-auth", `${environment}.json`);
}

// ─── cross-process file lock ──────────────────────────────────────────────

/** Sibling of the credential file, named so a listing shows what holds it. */
const LOCK_SUFFIX = ".lock";
/** A contended lock is held for one short read+write+rename, so seconds suffice. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
/** A lock whose mtime is older than this may be a holder that stopped renewing it. */
const DEFAULT_LOCK_STALE_MS = 10_000;
/**
 * How often the holder refreshes the lock's mtime. Kept at or below a third
 * of the stale threshold, so a holder that is alive but slow keeps its lock
 * fresh through a write of any length.
 */
const DEFAULT_LOCK_HEARTBEAT_MS = 3_000;
const MIN_LOCK_HEARTBEAT_MS = 50;
const LOCK_RETRY_BASE_MS = 5;
const LOCK_RETRY_MAX_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a process id currently exists.
 *
 * `kill(pid, 0)` probes without signalling: ESRCH means dead, EPERM means
 * alive but owned by someone else. On Windows Node maps the same
 * liveness question onto the process table, so the check is portable.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Quarantine notices already printed by this process, keyed by destination
 * path. A CLI command can read the store several times; the user needs to
 * learn about a torn file once, not once per lookup.
 */
const quarantinedWarnings = new Set<string>();

class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  /**
   * Exact compare-and-swap: one process's map, one synchronous step, so no
   * other write can land between the compare and the set.
   */
  async replaceIfUnchanged(
    key: string,
    expected: string | null,
    value: string,
    guard?: { key: string; expected: string | null },
  ): Promise<boolean> {
    if ((this.values.get(key) ?? null) !== expected) return false;
    if (guard && (this.values.get(guard.key) ?? null) !== guard.expected)
      return false;
    this.values.set(key, value);
    return true;
  }
}

interface FileLockOptions {
  lockPath?: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  lockHeartbeatMs?: number;
}

class FileCredentialStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly lockHeartbeatMs: number;
  private readonly explicitLockPath: string | undefined;

  constructor(
    private readonly filePath: string,
    options: FileLockOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockHeartbeatMs =
      options.lockHeartbeatMs ??
      Math.min(
        DEFAULT_LOCK_HEARTBEAT_MS,
        Math.max(MIN_LOCK_HEARTBEAT_MS, Math.floor(this.lockStaleMs / 3)),
      );
    this.explicitLockPath = options.lockPath;
  }

  private get lockPath(): string {
    return this.explicitLockPath ?? `${this.filePath}${LOCK_SUFFIX}`;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Hold a cross-process lock for the duration of one read-modify-write.
   *
   * The lock is a sibling file created with `flag: "wx"` — exclusive
   * create, so the first writer wins and every contender gets EEXIST. It
   * carries the holder's pid and an unguessable token: the pid identifies a
   * holder that died, and the token makes the release remove only what this
   * call created. Contenders back off 5 ms → 50 ms and give up after
   * `lockTimeoutMs`; a timeout is reported rather than ignored. That budget
   * is for the whole wait — see `withLock`, which also bounds the
   * process-local queue with it.
   *
   * A lock that cannot be created at all (read-only home, an unusable lock
   * path) is a reported storage error, not a fallback to an unlocked write.
   * Each operation rewrites the *whole* file — the credential lives in two
   * records, `tokens` and `user` — so an unlocked read-modify-write built
   * from a stale snapshot would drop a key a concurrent writer had just
   * stored, which is exactly the interleaving the lock exists to prevent.
   *
   * The holder renews the lock's mtime every `lockHeartbeatMs` and checks
   * just before the rename that it still owns it, so a slow write keeps its
   * lock, and a takeover that happened at any point before that check turns
   * this call's rename into a refused write instead of an overwrite.
   *
   * Honest limit: the check and the rename are two syscalls. A third party
   * that replaces the lock file *between* the ownership read and the rename
   * is not seen, and this call's rename still lands — the lock protocol
   * narrows the window to that gap rather than eliminating it. Closing it
   * would need a compare-and-swap the filesystem does not offer (renameat2
   * with RENAME_EXCHANGE plus a post-check, or an flock-style lock whose
   * release the kernel enforces). Until then the guarantee is "no takeover
   * before the check commits", not "no takeover ever commits".
   *
   * This closes the window the rename probe found: read, temp write and
   * rename all happen while the lock is held, so a second *writer* — another
   * process, or another instance in this one — queues behind this section
   * instead of landing inside it. Reads do not take the lock file; the one
   * read that changes the directory (moving a torn file aside) is instead
   * coordinated through the process-local mutex in `withFileMutex`, which
   * this section holds for its whole duration. So within one process no
   * operation of any kind lands inside this section, and across processes
   * the only uncovered read-side move is a quarantine that races a write
   * from a different process (see `quarantine`).
   */
  private async withLock<T>(
    operation: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    // The process-local mutex wraps the lock file, not the other way round:
    // a repairing reader (below) takes the same mutex, so it cannot be
    // re-admitted in the middle of this section and move the file this
    // section is about to write.
    //
    // One deadline covers both waits. Queueing for the mutex is time this
    // call spends inside the critical path just as much as the lock-file
    // poll is, so a caller that promises `lockTimeoutMs` must not be able to
    // sit behind another operation in RAM forever while its own lock file is
    // free. The mutex is told the bound (it walks away without running
    // anything), and the lock-file loop gets the same absolute deadline, so
    // the total is one `lockTimeoutMs` rather than twice that.
    const deadline = Date.now() + this.lockTimeoutMs;
    try {
      return await withFileMutex(
        this.lockPath,
        () => this.withLockFile(operation, deadline),
        this.lockTimeoutMs,
      );
    } catch (error) {
      if (error instanceof FileMutexTimeoutError) throw this.busyFailure();
      throw error;
    }
  }

  /** The one "someone else holds it" error, whichever wait timed out. */
  private busyFailure(): ClerkCliAuthError {
    return storageError(
      `acquire lock ${this.lockPath}`,
      new Error(
        `the credential file is busy (held by another petdex process) past ${this.lockTimeoutMs}ms`,
      ),
    );
  }

  private async withLockFile<T>(
    operation: (assertOwned: () => Promise<void>) => Promise<T>,
    deadline: number,
  ): Promise<T> {
    const token = `${process.pid}:${randomUUID()}`;
    await this.acquireLock(token, deadline);
    const stopHeartbeat = this.startHeartbeat(token);
    try {
      return await operation(() => this.assertLockOwned(token));
    } finally {
      stopHeartbeat();
      await this.releaseLock(token);
    }
  }

  private async acquireLock(token: string, deadline: number): Promise<void> {
    let delay = LOCK_RETRY_BASE_MS;

    for (;;) {
      try {
        await mkdir(dirname(this.lockPath), { recursive: true });
      } catch (error) {
        // EEXIST here is a file where the lock's directory belongs, not a
        // held lock: `mkdir` never contends with a lock file.
        throw storageError(`create lock ${this.lockPath}`, error);
      }
      try {
        await writeFile(this.lockPath, `${token}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") {
          // No unlocked fallback: the caller hears about the unusable lock
          // and skips or reports the write instead of racing blind.
          throw storageError(`create lock ${this.lockPath}`, error);
        }

        if (await this.stealStaleLock(deadline)) continue;

        if (Date.now() + delay > deadline) throw this.busyFailure();
        await sleep(delay);
        delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
      }
    }
  }

  /**
   * Keep the lock's mtime fresh while it is held.
   *
   * Refreshing only when the lock still carries this call's token means a
   * lock that was taken over is not accidentally renewed by its old owner —
   * the heartbeat goes quiet and the takeover stands. The timer never keeps
   * the process alive on its own.
   */
  private startHeartbeat(token: string): () => void {
    const timer = setInterval(() => {
      void this.touchLock(token).catch(() => {});
    }, this.lockHeartbeatMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }

  private async touchLock(token: string): Promise<void> {
    let current: string;
    try {
      current = (await readFile(this.lockPath, "utf8")).trim();
    } catch {
      return; // gone: the ownership check before the rename will notice
    }
    if (current !== token) return;
    const now = new Date();
    await utimes(this.lockPath, now, now).catch(() => {});
  }

  /**
   * The last thing before the rename: prove this call still owns the lock.
   *
   * A takeover can only happen for a lock whose holder looks gone, but the
   * old holder may still be inside its write and about to rename. Checking
   * the token here refuses the rename when a takeover already happened. It
   * cannot see one that lands in the gap between this read and the rename
   * itself — that residue is documented on `withLock`.
   */
  private async assertLockOwned(token: string): Promise<void> {
    let current: string | null = null;
    try {
      current = (await readFile(this.lockPath, "utf8")).trim();
    } catch {
      current = null;
    }
    if (current === token) return;
    throw storageError(
      `commit under lock ${this.lockPath}`,
      new Error(
        "the lock was taken over while the write was in progress; the write was not committed",
      ),
    );
  }

  /**
   * Remove a lock whose holder is gone.
   *
   * A dead pid (the lock content names a process that no longer exists) is
   * taken over; a lock older than `lockStaleMs` is taken over only because a
   * live holder renews its mtime, so an old mtime means the holder stopped
   * renewing — a wedged process or one whose pid was reused. Both paths wait
   * a short grace and only remove the lock when it is still byte-for-byte
   * the one that was probed.
   */
  private async stealStaleLock(deadline: number): Promise<boolean> {
    let content: string;
    let mtimeMs: number;
    try {
      const info = await stat(this.lockPath);
      mtimeMs = info.mtimeMs;
      content = (await readFile(this.lockPath, "utf8")).trim();
    } catch {
      // Vanished between EEXIST and the probe (or an outsider's lock we
      // cannot read). Retry the create on the caller's backoff, which is
      // bounded by the deadline.
      return false;
    }
    const pid = Number.parseInt(content.split(":")[0] ?? "", 10);
    const holderDead = Number.isFinite(pid) && pid > 0 && !pidAlive(pid);
    const holderStuck = Date.now() - mtimeMs > this.lockStaleMs;
    if (!holderDead && !holderStuck) return false;
    if (Date.now() + LOCK_RETRY_BASE_MS > deadline) return false;
    await sleep(LOCK_RETRY_BASE_MS);
    // Re-check after the grace: a holder that renewed the lock in the
    // meantime (or a different holder entirely) must not be stolen from.
    try {
      const latest = await stat(this.lockPath);
      if (latest.mtimeMs === mtimeMs) {
        await this.removeLockOwnedBy(content);
      }
    } catch {
      // Already gone; the next create attempt wins.
    }
    return true;
  }

  /** Delete the lock only when it still holds the bytes we read (or wrote). */
  private async removeLockOwnedBy(expected: string): Promise<void> {
    try {
      const current = (await readFile(this.lockPath, "utf8")).trim();
      if (current !== expected) return;
    } catch {
      return; // already released
    }
    await rm(this.lockPath, { force: true }).catch(() => {});
  }

  private async releaseLock(token: string): Promise<void> {
    await this.removeLockOwnedBy(token);
  }

  private async readAll(): Promise<Record<string, string>> {
    const { values, corrupt } = await this.readSnapshot();
    if (corrupt !== undefined) await this.quarantine(corrupt);
    return values;
  }

  /**
   * Read and parse once, saying whether the bytes were torn.
   *
   * `corrupt` carries the exact content that failed to parse, so the caller
   * can quarantine *those* bytes rather than whatever the path happens to
   * hold later. Undefined means the read was fine (including absent or
   * empty), and the caller has nothing to move.
   */
  private async readSnapshot(): Promise<{
    values: Record<string, string>;
    corrupt?: string;
  }> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { values: {} };
      throw storageError(
        `Failed to read credential file ${this.filePath}`,
        error,
      );
    }
    if (!content.trim()) return { values: {} };

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { values: {}, corrupt: content };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { values: {}, corrupt: content };
    }

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") result[key] = value;
    }
    return { values: result };
  }

  /**
   * Move a file that cannot be parsed out of the way, and behave like an
   * empty store afterwards.
   *
   * A half-written file used to make every command fail — `whoami` could not
   * read, `login` could not delete or write, `logout` could not clear — with
   * no way out except finding the file by hand. Preserving it under a
   * `.corrupt-<timestamp>` name keeps the evidence for a bug report while the
   * store stays usable, and the next successful write replaces it.
   *
   * Being treated as signed out is the user-visible consequence, so the
   * quarantine is announced once per path per process with the evidence
   * file's name: silent loss reads as an expired password and sends the
   * user hunting in the wrong direction.
   *
   * The move is coordinated as a write, not as the follow-up to the read
   * that found the damage. A reader can be paused between its read and its
   * rename while a writer takes the lock, quarantines the same file and
   * writes a fresh credential. A rename from the reader's stale snapshot
   * would then move the *new* record away, leaving the path empty and a
   * perfectly good login behind a `.corrupt-*` name. So the quarantine
   * re-enters on the same process-local mutex every locked write takes, and
   * inside it re-reads the path and moves only bytes that are *still* the
   * torn ones (`expected` is what the reader actually parsed). A writer's
   * fresh file — or another reader's successful quarantine — therefore
   * wins, and this one reports nothing and moves nothing.
   *
   * The re-read inside the mutex must not go back through `readAll`, which
   * would take the mutex again and deadlock; `readSnapshot` is the
   * lock-free half this shares with it.
   *
   * Honest limit: the mutex is this process's. A reader in another process
   * can still move a file this process wrote after the reader's snapshot,
   * in the gap the cross-process lock file does not cover for reads. Within
   * one process — the CLI's normal shape, and the one where a store and its
   * keychain fallback share a path — the move is decided on current bytes.
   */
  private async quarantine(expected: string): Promise<void> {
    await withFileMutex(this.lockPath, async () => {
      const { corrupt } = await this.readSnapshot();
      // Clean, absent, or replaced since the caller's read: nothing to move.
      if (corrupt !== expected) return;
      await this.moveCorruptToEvidence();
    });
  }

  /**
   * Read inside the lock section, where the mutex is already held.
   *
   * A torn record met here is still quarantined, but through the direct
   * move: `quarantine` would take the mutex this section owns and deadlock.
   * The bytes were read a moment ago under the lock, so there is no stale
   * snapshot to guard against.
   */
  private async readAllLocked(): Promise<Record<string, string>> {
    const { values, corrupt } = await this.readSnapshot();
    if (corrupt !== undefined) await this.moveCorruptToEvidence();
    return values;
  }

  /** The rename-and-warn half of `quarantine`; the caller has the bytes. */
  private async moveCorruptToEvidence(): Promise<void> {
    const destination = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await rename(this.filePath, destination);
    } catch {
      // Already moved by a concurrent reader, or the directory is
      // unwritable. Either way the caller proceeds with an empty view.
      return;
    }
    if (quarantinedWarnings.has(destination)) return;
    quarantinedWarnings.add(destination);
    console.warn(
      `The petdex credentials file was unreadable and has been moved to ` +
        `${destination}; the CLI behaves as signed out until you run ` +
        "`petdex login`.",
    );
  }

  private async writeAll(
    values: Record<string, string>,
    assertOwned: () => Promise<void>,
  ): Promise<void> {
    // Writes go to a sibling temporary file and are renamed into place. A
    // rename within one directory is atomic, so a reader sees the previous
    // contents or the complete new ones — never the torn intermediate state
    // the parse fallback above exists to survive. The ownership check runs
    // last, after the (possibly slow) temp write. A takeover completed
    // before that check refuses the rename; one that lands between the
    // check and the rename is outside what this protocol can see (see
    // `withLock`).
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, {
        mode: 0o600,
      });
      await assertOwned();
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw storageError(
        `Failed to write credential file ${this.filePath}`,
        error,
      );
    }
  }

  async get(key: string): Promise<string | null> {
    return this.enqueue(async () => {
      const values = await this.readAll();
      return values[key] ?? null;
    });
  }

  async set(key: string, value: string): Promise<void> {
    return this.enqueue(async () => {
      await this.withLock(async (assertOwned) => {
        const values = await this.readAllLocked();
        values[key] = value;
        await this.writeAll(values, assertOwned);
      });
    });
  }

  async delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      // Read the current contents once before locking: a delete of an
      // absent key must not create the file (and must not fail on a
      // read-only home), so it is checked and short-circuited outside the
      // lock; the locked pass repeats the check in case the key appeared
      // between the two reads.
      const preview = await this.readAll();
      if (!(key in preview)) return;
      await this.withLock(async (assertOwned) => {
        const values = await this.readAllLocked();
        if (!(key in values)) return;
        delete values[key];
        await this.writeAll(values, assertOwned);
      });
    });
  }

  /**
   * Compare-and-swap one key: write only when the stored record is still
   * exactly `expected`, and report whether the write happened.
   *
   * The read, the compare and the write all run inside a single lock
   * section, which is what makes this a swap rather than the re-read-then-set
   * that still loses the race in the gap between the two: any other store
   * over this file either lands before the read (the compare then refuses) or
   * waits for the section to finish. The one window that remains is the one
   * `withLock` documents — a lock takeover between the ownership check and
   * the rename, which this call cannot see.
   *
   * A torn file is quarantined by `readAll` exactly as on a plain read, so
   * the compare sees an absent key and refuses: a damaged record is never
   * silently replaced by a value computed from bytes nobody could read.
   *
   * A refused compare writes nothing at all — in particular it does not
   * create the credential file when `expected` is `null`.
   */
  async replaceIfUnchanged(
    key: string,
    expected: string | null,
    value: string,
    guard?: { key: string; expected: string | null },
  ): Promise<boolean> {
    return this.enqueue(async () =>
      this.withLock(async (assertOwned) => {
        const values = await this.readAllLocked();
        if ((values[key] ?? null) !== expected) return false;
        if (guard && (values[guard.key] ?? null) !== guard.expected)
          return false;
        values[key] = value;
        await this.writeAll(values, assertOwned);
        return true;
      }),
    );
  }
}

/**
 * The keychain store, over an injectable file fallback.
 *
 * Exported so its own tests can supply a fallback whose reads the test holds
 * open — the interleavings that decide whether the compare is honest all
 * happen during a fallback read, and the real file store's reads are too fast
 * to place one deliberately. Production code always builds it through
 * `createCredentialStore`.
 */
export class KeychainCredentialStore implements CredentialStore {
  private keyringPromise: Promise<KeyringModule | null> | null = null;

  constructor(
    private readonly service: string,
    private readonly environment: string,
    private readonly fallback: CredentialStore,
  ) {}

  private account(key: string): string {
    return `${this.environment}:${key}`;
  }

  private warnFallback(
    operation: string,
    error: unknown,
    detailNote?: string,
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    // `Cannot find package` means the optional native dep wasn't installed
    // (e.g. npx download). That's expected — file store handles it. Only
    // surface real errors so users don't see a scary warning on every run.
    if (
      operation === "initialization" &&
      detail.includes("Cannot find package")
    ) {
      return;
    }
    const suffix = detailNote ? ` ${detailNote}` : "";
    console.warn(
      `Keychain ${operation} failed; using the file store where it stands in for the keychain. ${detail}${suffix}`,
    );
  }

  private async loadKeyring(): Promise<KeyringModule | null> {
    this.keyringPromise ??= import("@napi-rs/keyring").catch(
      (error: unknown) => {
        this.warnFallback("initialization", error);
        return null;
      },
    );
    return this.keyringPromise;
  }

  async get(key: string): Promise<string | null> {
    try {
      const keyring = await this.loadKeyring();
      if (!keyring) return this.fallback.get(key);

      const entry = new keyring.Entry(this.service, this.account(key));
      return entry.getPassword() ?? (await this.fallback.get(key));
    } catch (error) {
      this.warnFallback("get", error);
      return this.fallback.get(key);
    }
  }

  /**
   * Write the keychain and drop any older file copy of the same key.
   *
   * `get()` falls back to the file whenever the keychain holds nothing — a
   * locked login keychain, a keychain reset, or the item deleted in Keychain
   * Access. A file copy left behind by an earlier keychain-less run is then a
   * *previous account's* record, waiting to be read back as the current one.
   * Clearing it on every successful keychain write is what keeps "sign in as
   * B" meaning only B survives, whichever store the next read reaches.
   *
   * The cleanup is best effort, and that is a real remaining risk rather
   * than a formality: the keychain now holds the new value, so a file that
   * cannot be cleared costs a stale copy, not the login — but if the keychain
   * entry later disappears (reset, migration, deleted item), `get()` reads
   * that stale copy back as the current session. The warning names that; the
   * alternative, falling back to writing the file instead, would defeat the
   * point of using the keychain at all. These are the only two behaviours a
   * write can have, given a fallback copy and an API with no transaction
   * across the two stores.
   */
  async set(key: string, value: string): Promise<void> {
    try {
      const keyring = await this.loadKeyring();
      if (!keyring) {
        await this.fallback.set(key, value);
        return;
      }

      const entry = new keyring.Entry(this.service, this.account(key));
      entry.setPassword(value);
      await this.clearFallback(key);
    } catch (error) {
      this.warnFallback("set", error);
      await this.fallback.set(key, value);
    }
  }

  /**
   * Compare-and-write one key, at the strength the keyring API allows.
   *
   * The native credential stores this wraps (macOS Keychain, libsecret, the
   * Windows credential manager) offer neither a transaction nor a
   * compare-and-swap: `getPassword()` and `setPassword()` are two independent
   * calls with nothing between them. What this implementation gives is a
   * narrower window than the call that started it:
   *
   * - The compare uses native values read *after* every `fallback.get` await,
   *   not ones captured before it. A login that finishes while a fallback
   *   read is in flight is therefore seen by the compare, instead of being
   *   overwritten by a value computed from the record it replaced. The guard
   *   key is read the same way, so both sides of the condition describe the
   *   store at the same moment.
   * - Those final reads and the compare are one synchronous run of
   *   statements, so no other write from this process can land between them.
   * - The write then goes through `set`, which both writes the keychain and
   *   clears the older file copy.
   *
   * What it still does not give, and must not be read as giving: the last
   * native read and `setPassword()` are separated by an `await`. Another
   * process (or another store in this process, since a keychain `set` takes
   * no lock) can write in that gap, and the later write wins. `false` means
   * the compare *as this call performed it* did not match; `true` does not
   * mean no other writer exists. Closing the gap needs a lock every writer
   * takes or a CAS the keyring API does not offer.
   *
   * The fallback file copy is consulted exactly as `get()` consults it: a
   * keychain that holds nothing, or a keychain call that fails, means the
   * file is the store's current answer, so the compare is against that. When
   * the keychain is unusable the whole operation is delegated to the
   * fallback's own compare-and-swap, which is a real critical section and
   * keeps the stronger guarantee in the degraded mode. A successful write
   * goes through `set`, so it also inherits that method's rule of clearing
   * the older file copy — including the best-effort residue documented
   * there.
   */
  async replaceIfUnchanged(
    key: string,
    expected: string | null,
    value: string,
    guard?: { key: string; expected: string | null },
  ): Promise<boolean> {
    let keyring: KeyringModule | null;
    try {
      keyring = await this.loadKeyring();
    } catch (error) {
      this.warnFallback("get", error);
      return this.fallback.replaceIfUnchanged(key, expected, value, guard);
    }
    if (!keyring) {
      return this.fallback.replaceIfUnchanged(key, expected, value, guard);
    }

    // The two fallback reads below are the only awaits before the compare;
    // the native values are read again after them, so neither read can hide
    // a login that landed while it was in flight.
    let fallbackValue: string | null = null;
    let fallbackGuard: string | null = null;
    const entry = new keyring.Entry(this.service, this.account(key));
    const guardEntry = guard
      ? new keyring.Entry(this.service, this.account(guard.key))
      : null;
    try {
      // Only consult the fallback when the keychain itself answers nothing;
      // a keychain hit is authoritative and needs no file read at all.
      const nativeBefore = entry.getPassword();
      if (nativeBefore === null) fallbackValue = await this.fallback.get(key);
      if (guard && guardEntry) {
        const guardBefore = guardEntry.getPassword();
        if (guardBefore === null)
          fallbackGuard = await this.fallback.get(guard.key);
      }
      // Re-read both native records now that every await is behind us. A
      // keychain write that landed during a fallback read is the newer
      // session, and comparing it (rather than the pre-await read) is what
      // refuses this write instead of overwriting it.
      const current = entry.getPassword() ?? fallbackValue;
      const guardCurrent = guardEntry
        ? (guardEntry.getPassword() ?? fallbackGuard)
        : null;
      // From here to `set`, every statement below is synchronous in the
      // values it compares — the remaining await is the `set` itself, which
      // is the gap this method documents.
      if (current !== expected) return false;
      if (guard && guardCurrent !== guard.expected) return false;
    } catch (error) {
      this.warnFallback("get", error);
      return this.fallback.replaceIfUnchanged(key, expected, value, guard);
    }
    await this.set(key, value);
    return true;
  }

  /** Remove the file copy after a successful keychain write. Never throws. */
  /**
   * Remove the file copy after a successful keychain write. Never throws.
   *
   * The keychain write already succeeded, so this is not a fallback: it is
   * cleanup of a copy that must not outlive it. The warning says so, and
   * names what a failure leaves behind — an older credential that a later
   * keychain miss would read as current.
   */
  private async clearFallback(key: string): Promise<void> {
    try {
      await this.fallback.delete(key);
    } catch (error) {
      this.warnFallback(
        "cleanup",
        error,
        "The newer value is saved in the keychain, but an older file copy could not be removed; if the keychain entry disappears later, that older copy is read as current.",
      );
    }
  }

  /**
   * Clear both copies, fallback first, and stop at the first failure.
   *
   * The order is the invariant: `get()` prefers the keychain and falls back
   * to the file only when the keychain holds nothing, so a partial failure
   * must never leave a key that still *reads back* after being reported as
   * cleared.
   *
   * - The fallback delete fails: the keychain is never touched, so the key
   *   survives whole there (and in the untouched file), and the error names
   *   the file step.
   * - The keychain delete fails: the fallback is already gone and the keychain
   *   still holds the key, so `get()` reads the intact entry and the error
   *   names the keychain step.
   *
   * Both branches report failure, so the CLI never prints "Signed out" over
   * a credential that still works. `logout` clears `tokens` and `user`
   * through `Promise.allSettled`, so each key takes its own report and one
   * stuck key cannot hide the other's success. The order this replaces —
   * keychain first — could end with the keychain cleared and the fallback
   * readable, which is the half-delete the reviewer's revival probe found,
   * just noisier.
   *
   * `deletePassword()` returning false is not a failure: it means the
   * keychain held nothing, which the fallback-first delete has already
   * cleaned.
   */
  async delete(key: string): Promise<void> {
    try {
      await this.fallback.delete(key);
    } catch (error) {
      throw storageError("Failed to delete file credential", error);
    }

    try {
      const keyring = await this.loadKeyring();
      if (!keyring) return;
      const entry = new keyring.Entry(this.service, this.account(key));
      entry.deletePassword();
    } catch (error) {
      // The keychain still holds the old copy and the fallback is gone:
      // `get()` reads the intact keychain entry, so the key survives and the
      // error names what failed.
      throw storageError("Failed to delete keychain credential", error);
    }
  }
}

function createFileStore(options?: CreateStoreOptions): CredentialStore {
  const environment = environmentName(options);
  return new FileCredentialStore(
    options?.filePath ?? defaultFilePath(environment),
    {
      lockPath: options?.lockPath,
      lockTimeoutMs: options?.lockTimeoutMs,
      lockStaleMs: options?.lockStaleMs,
      lockHeartbeatMs: options?.lockHeartbeatMs,
    },
  );
}

export function createCredentialStore(
  kind: StorageKind,
  options?: CreateStoreOptions,
): CredentialStore {
  if (kind === "memory") return new MemoryCredentialStore();
  if (kind === "file") return createFileStore(options);

  const fallback = createFileStore(options);
  const service = options?.keychainService ?? "clerk-cli-auth";
  const environment = environmentName(options);
  return new KeychainCredentialStore(service, environment, fallback);
}
