/**
 * One mutex per filesystem path, shared by every store in this process.
 *
 * The file store's cross-process lock is a sibling `.lock` file, and its
 * holder is the only writer for its duration. That is enough for writes, but
 * it is *not* enough for the one operation a reader also performs: moving a
 * torn credential file aside (see `quarantine` in `credential-store.ts`). A
 * reader that took a snapshot before a writer replaced the file would,
 * under a plain lock, be re-admitted after the writer and move the writer's
 * brand-new file — the reader's snapshot is stale by then.
 *
 * So the in-process mutex is kept in both directions:
 *
 * - a reader that has to repair the file takes the mutex and re-reads inside
 *   it, so it only moves bytes that are still torn when it acts;
 * - every locked read-modify-write takes the mutex *around* the lock file
 *   section, so a repairing reader from this process cannot land inside a
 *   writer's section.
 *
 * Covering both at once is what makes "the file I want to quarantine is the
 * one I read as corrupt" a statement that cannot go stale in between. The
 * mutex is per resolved path, so two store instances over the same file (the
 * shape most tests use, and the shape `KeychainCredentialStore` uses for its
 * fallback) queue behind each other exactly like two processes would.
 *
 * Honest limit: this is process-local. A read in process B still races a
 * write in process A. That race is bounded by the write's own atomicity: the
 * runtime under test here is a single CLI command, and the fallback file is
 * only consulted by the process that owns the keychain entry. The
 * cross-process residue is documented on `quarantine`.
 */
const mutexes = new Map<string, Promise<unknown>>();

export async function withFileMutex<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutexes.get(key) ?? Promise.resolve();
  // `operation` runs whether the previous holder resolved or rejected: a
  // failed section must not wedge the queue for every later caller.
  const next = previous.then(operation, operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  mutexes.set(key, settled);
  try {
    return await next;
  } finally {
    // Drop the entry once this holder is the tail, so a long-lived process
    // does not accumulate one promise per path it ever touched.
    if (mutexes.get(key) === settled) mutexes.delete(key);
  }
}
