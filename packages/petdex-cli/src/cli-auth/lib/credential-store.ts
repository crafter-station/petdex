import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CredentialStore, StorageKind } from "../types.js";
import { ClerkCliAuthError } from "../types.js";

export interface CreateStoreOptions {
  keychainService?: string;
  environment?: string;
  filePath?: string;
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
}

class FileCredentialStore implements CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const content = await readFile(this.filePath, "utf8");
      if (!content.trim()) return {};
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return {};

      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") result[key] = value;
      }
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw storageError(
        `Failed to read credential file ${this.filePath}`,
        error,
      );
    }
  }

  private async writeAll(values: Record<string, string>): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify(values, null, 2)}\n`, {
        mode: 0o600,
      });
      await chmod(this.filePath, 0o600);
    } catch (error) {
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
      const values = await this.readAll();
      values[key] = value;
      await this.writeAll(values);
    });
  }

  async delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      const values = await this.readAll();
      delete values[key];
      await this.writeAll(values);
    });
  }
}

class KeychainCredentialStore implements CredentialStore {
  private keyringPromise: Promise<KeyringModule | null> | null = null;

  constructor(
    private readonly service: string,
    private readonly environment: string,
    private readonly fallback: CredentialStore,
  ) {}

  private account(key: string): string {
    return `${this.environment}:${key}`;
  }

  private warnFallback(operation: string, error: unknown): void {
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
    console.warn(
      `Keychain ${operation} failed; falling back to file store. ${detail}`,
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

  async set(key: string, value: string): Promise<void> {
    try {
      const keyring = await this.loadKeyring();
      if (!keyring) {
        await this.fallback.set(key, value);
        return;
      }

      const entry = new keyring.Entry(this.service, this.account(key));
      entry.setPassword(value);
    } catch (error) {
      this.warnFallback("set", error);
      await this.fallback.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const keyring = await this.loadKeyring();
      if (keyring) {
        const entry = new keyring.Entry(this.service, this.account(key));
        entry.deletePassword();
      }
    } catch (error) {
      this.warnFallback("delete", error);
    }
    await this.fallback.delete(key);
  }
}

function createFileStore(options?: CreateStoreOptions): CredentialStore {
  const environment = environmentName(options);
  return new FileCredentialStore(
    options?.filePath ?? defaultFilePath(environment),
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
