import { describe, expect, it } from "bun:test";

import { downloadPetZip } from "@/lib/download-pet-zip";

const ZIP_URL = "https://assets.petdex.dev/pets/roxy-7f5395e0f425/zip.zip";
const OBJECT_URL = "blob:petdex-pet-zip";

describe("downloadPetZip", () => {
  it("names the saved file after the slug, not the R2 object key", async () => {
    const env = installBrowserEnv(
      async () => new Response("zip-bytes", { status: 200 }),
    );

    try {
      await downloadPetZip(ZIP_URL, "roxy-2");

      expect(env.fetched).toEqual([ZIP_URL]);
      expect(env.clicks).toEqual([
        { href: OBJECT_URL, filename: "roxy-2.zip" },
      ]);
      expect(env.revoked).toEqual([]);

      env.runPendingTimers();

      expect(env.revoked).toEqual([OBJECT_URL]);
    } finally {
      env.restore();
    }
  });

  it("falls back to the raw zip url when the fetch rejects", async () => {
    const env = installBrowserEnv(async () => {
      throw new Error("blocked before the request left the browser");
    });

    try {
      await downloadPetZip(ZIP_URL, "boba");

      expect(env.clicks).toEqual([{ href: ZIP_URL, filename: "boba.zip" }]);
      expect(env.revoked).toEqual([]);
    } finally {
      env.restore();
    }
  });

  it("falls back when a stalled download reaches its deadline", async () => {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    const controller = new AbortController();
    let requestedTimeout = 0;
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (milliseconds: number) => {
        requestedTimeout = milliseconds;
        return controller.signal;
      },
    });
    const env = installBrowserEnv(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("download deadline")),
            { once: true },
          );
        }),
    );
    try {
      const pending = downloadPetZip(ZIP_URL, "boba");
      expect(requestedTimeout).toBe(30_000);
      controller.abort();
      await pending;
      expect(env.clicks).toEqual([{ href: ZIP_URL, filename: "boba.zip" }]);
      expect(env.revoked).toEqual([]);
    } finally {
      env.restore();
      restoreProperty(AbortSignal, "timeout", original);
    }
  });

  it("falls back when the response body fails partway through", async () => {
    const env = installBrowserEnv(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection lost"));
            },
          }),
        ),
    );
    try {
      await downloadPetZip(ZIP_URL, "boba");
      expect(env.clicks).toEqual([{ href: ZIP_URL, filename: "boba.zip" }]);
      expect(env.revoked).toEqual([]);
    } finally {
      env.restore();
    }
  });

  it("falls back to the raw zip url when the assets host rejects the fetch", async () => {
    const env = installBrowserEnv(
      async () => new Response("forbidden", { status: 403 }),
    );

    try {
      await downloadPetZip(ZIP_URL, "boba");

      expect(env.clicks).toEqual([{ href: ZIP_URL, filename: "boba.zip" }]);
    } finally {
      env.restore();
    }
  });
});

type InstallEnv = {
  fetched: string[];
  clicks: Array<{ href: string; filename: string }>;
  revoked: string[];
  runPendingTimers: () => void;
  restore: () => void;
};

function installBrowserEnv(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): InstallEnv {
  const fetched: string[] = [];
  const clicks: Array<{ href: string; filename: string }> = [];
  const revoked: string[] = [];
  const timers: Array<() => void> = [];

  const anchor = {
    href: "",
    download: "",
    rel: "",
    click() {
      clicks.push({ href: this.href, filename: this.download });
    },
    remove() {},
  };

  const restoreDocument = installGlobal("document", {
    createElement: () => anchor,
    body: { appendChild: () => {} },
  });
  const restoreFetch = installGlobal("fetch", (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    fetched.push(url);
    return handler(url, init);
  }) as typeof globalThis.fetch);
  const restoreTimeout = installGlobal("setTimeout", ((
    callback: () => void,
  ) => {
    timers.push(callback);
    return 0;
  }) as unknown as typeof setTimeout);
  const restoreObjectUrls = installObjectUrls(revoked);

  return {
    fetched,
    clicks,
    revoked,
    runPendingTimers: () => {
      while (timers.length > 0) timers.shift()?.();
    },
    restore: () => {
      restoreObjectUrls();
      restoreTimeout();
      restoreFetch();
      restoreDocument();
    },
  };
}

function installObjectUrls(revoked: string[]): () => void {
  const originalCreate = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL",
  );
  const originalRevoke = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL",
  );
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => OBJECT_URL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
  return () => {
    restoreProperty(URL, "createObjectURL", originalCreate);
    restoreProperty(URL, "revokeObjectURL", originalRevoke);
  };
}

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function installGlobal(key: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  return () => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  };
}
