import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClerkCliAuth } from "../clerk-cli-auth";
import type { CredentialStore } from "../types";
import { createCredentialStore } from "./credential-store";

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

test("a corrupt credential file reads empty and is rewritten on the next write", async () => {
  await writeFile(filePath, "{ half-written", "utf8");
  // Used to reject, which left every later get/set/delete — login
  // included — failing with no CLI path back to a usable store.
  expect(await fallback.get("tokens")).toBeNull();
  expect(warning).toHaveBeenCalled();
  await fallback.set("tokens", "fresh-token");
  expect(await fallback.get("tokens")).toBe("fresh-token");
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
