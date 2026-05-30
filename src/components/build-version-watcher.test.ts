import { describe, expect, it } from "bun:test";

import type { BuildVersionUpdateReason } from "@/lib/build-version-monitor";
import { createBuildVersionMonitor } from "@/lib/build-version-monitor";

type Listener = (event?: unknown) => void;

class BuildVersionHarness {
  documentListeners = new Map<string, Set<Listener>>();
  intervals = new Map<number, () => void>();
  visible = true;
  windowListeners = new Map<string, Set<Listener>>();

  #nextIntervalId = 1;

  addDocumentListener = (type: string, listener: Listener) => {
    this.#listenersFor(this.documentListeners, type).add(listener);
  };

  addWindowListener = (type: string, listener: Listener) => {
    this.#listenersFor(this.windowListeners, type).add(listener);
  };

  clearInterval = (id: number) => {
    this.intervals.delete(id);
  };

  dispatchDocument(type: string, event?: unknown) {
    for (const listener of this.documentListeners.get(type) ?? []) {
      listener(event);
    }
  }

  dispatchWindow(type: string, event?: unknown) {
    for (const listener of this.windowListeners.get(type) ?? []) {
      listener(event);
    }
  }

  isVisible = () => this.visible;

  removeDocumentListener = (type: string, listener: Listener) => {
    this.documentListeners.get(type)?.delete(listener);
  };

  removeWindowListener = (type: string, listener: Listener) => {
    this.windowListeners.get(type)?.delete(listener);
  };

  runNextInterval() {
    const callback = [...this.intervals.values()][0];
    callback?.();
  }

  setInterval = (listener: () => void) => {
    const id = this.#nextIntervalId;
    this.#nextIntervalId += 1;
    this.intervals.set(id, listener);
    return id;
  };

  #listenersFor(map: Map<string, Set<Listener>>, type: string) {
    let listeners = map.get(type);
    if (!listeners) {
      listeners = new Set();
      map.set(type, listeners);
    }
    return listeners;
  }
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

function createMonitorFixture({
  currentVersion = null,
  versions,
  visible = true,
}: {
  currentVersion?: string | null;
  versions: Array<string | null>;
  visible?: boolean;
}) {
  const harness = new BuildVersionHarness();
  harness.visible = visible;
  const updates: BuildVersionUpdateReason[] = [];
  const fetchVersion = async () => versions.shift() ?? null;

  const monitor = createBuildVersionMonitor({
    addDocumentListener: harness.addDocumentListener,
    addWindowListener: harness.addWindowListener,
    clearInterval: harness.clearInterval,
    currentVersion,
    fetchVersion,
    intervalMs: 60_000,
    isChunkLoadFailure: (event) =>
      String((event as { message?: unknown })?.message ?? "").includes(
        "ChunkLoadError",
      ),
    isVisible: harness.isVisible,
    onUpdate: (reason) => updates.push(reason),
    removeDocumentListener: harness.removeDocumentListener,
    removeWindowListener: harness.removeWindowListener,
    setInterval: harness.setInterval,
  });

  return { harness, monitor, updates };
}

describe("BuildVersionWatcher polling behavior", () => {
  it("polls only while visible and shows one prompt when the build changes", async () => {
    const { harness, monitor, updates } = createMonitorFixture({
      currentVersion: "v1",
      versions: ["v1", "v2", "v3"],
    });

    monitor.start();
    await flushPromises();

    expect(harness.intervals.size).toBe(1);

    harness.runNextInterval();
    await flushPromises();

    expect(updates).toEqual(["version"]);
    expect(harness.intervals.size).toBe(0);

    await monitor.checkNow();
    expect(updates).toEqual(["version"]);
  });

  it("compares remote versions against the running build even if the first fetch fails", async () => {
    const { harness, monitor, updates } = createMonitorFixture({
      currentVersion: "old-build",
      versions: [null, "new-build"],
    });

    monitor.start();
    await flushPromises();

    expect(updates).toEqual([]);

    harness.runNextInterval();
    await flushPromises();

    expect(updates).toEqual(["version"]);
    expect(harness.intervals.size).toBe(0);
  });

  it("starts polling when a hidden tab becomes visible and clears it when hidden again", async () => {
    const { harness, monitor, updates } = createMonitorFixture({
      versions: ["v1", "v1"],
      visible: false,
    });

    monitor.start();
    await flushPromises();

    expect(harness.intervals.size).toBe(0);

    harness.visible = true;
    harness.dispatchDocument("visibilitychange");
    await flushPromises();

    expect(updates).toEqual([]);
    expect(harness.intervals.size).toBe(1);

    harness.visible = false;
    harness.dispatchDocument("visibilitychange");

    expect(harness.intervals.size).toBe(0);
  });

  it("checks immediately on focus when visible", async () => {
    const { harness, monitor, updates } = createMonitorFixture({
      versions: ["v1", "v2"],
    });

    monitor.start();
    await flushPromises();

    harness.dispatchWindow("focus");
    await flushPromises();

    expect(updates).toEqual(["version"]);
  });

  it("uses the same prompt path for stale chunk failures", () => {
    const { harness, monitor, updates } = createMonitorFixture({
      versions: ["v1"],
    });

    monitor.start();
    harness.dispatchWindow("error", { message: "ChunkLoadError" });

    expect(updates).toEqual(["asset-load"]);
    expect(harness.intervals.size).toBe(0);
  });

  it("cleans up intervals and listeners on stop", async () => {
    const { harness, monitor, updates } = createMonitorFixture({
      versions: ["v1", "v2"],
    });

    monitor.start();
    await flushPromises();
    monitor.stop();

    expect(harness.intervals.size).toBe(0);
    expect(harness.documentListeners.get("visibilitychange")?.size).toBe(0);
    expect(harness.windowListeners.get("focus")?.size).toBe(0);
    expect(harness.windowListeners.get("error")?.size).toBe(0);
    expect(harness.windowListeners.get("unhandledrejection")?.size).toBe(0);

    harness.dispatchWindow("focus");
    harness.dispatchWindow("error", { message: "ChunkLoadError" });
    await flushPromises();

    expect(updates).toEqual([]);
  });
});
