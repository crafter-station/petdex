export type BuildVersionUpdateReason = "version" | "asset-load";

type Listener = (event: unknown) => void;
type IntervalId = number;

type BuildVersionMonitorOptions = {
  addDocumentListener: (type: string, listener: Listener) => void;
  addWindowListener: (type: string, listener: Listener) => void;
  clearInterval: (id: IntervalId) => void;
  currentVersion: string | null;
  fetchVersion: () => Promise<string | null>;
  intervalMs: number;
  isChunkLoadFailure: (event: unknown) => boolean;
  isVisible: () => boolean;
  onUpdate: (reason: BuildVersionUpdateReason) => void;
  removeDocumentListener: (type: string, listener: Listener) => void;
  removeWindowListener: (type: string, listener: Listener) => void;
  setInterval: (listener: () => void, intervalMs: number) => IntervalId;
};

export function createBuildVersionMonitor({
  addDocumentListener,
  addWindowListener,
  clearInterval,
  currentVersion: initialCurrentVersion,
  fetchVersion,
  intervalMs,
  isChunkLoadFailure,
  isVisible,
  onUpdate,
  removeDocumentListener,
  removeWindowListener,
  setInterval,
}: BuildVersionMonitorOptions) {
  let checking = false;
  let currentVersion = initialCurrentVersion;
  let intervalId: IntervalId | null = null;
  let stopped = false;
  let updateDetected = false;

  function clearForegroundInterval() {
    if (intervalId === null) {
      return;
    }

    clearInterval(intervalId);
    intervalId = null;
  }

  function showUpdate(reason: BuildVersionUpdateReason) {
    if (updateDetected || stopped) {
      return;
    }

    updateDetected = true;
    clearForegroundInterval();
    onUpdate(reason);
  }

  async function checkNow() {
    if (checking || stopped || updateDetected) {
      return;
    }

    checking = true;

    try {
      const latestVersion = await fetchVersion();

      if (!latestVersion) {
        return;
      }

      if (!currentVersion) {
        currentVersion = latestVersion;
        return;
      }

      if (latestVersion !== currentVersion) {
        showUpdate("version");
      }
    } finally {
      checking = false;
    }
  }

  function startForegroundInterval() {
    if (stopped || updateDetected || !isVisible()) {
      return;
    }

    clearForegroundInterval();
    intervalId = setInterval(() => {
      void checkNow();
    }, intervalMs);
  }

  function handleVisibilityChange() {
    if (!isVisible()) {
      clearForegroundInterval();
      return;
    }

    void checkNow();
    startForegroundInterval();
  }

  function handleFocus() {
    if (isVisible()) {
      void checkNow();
    }
  }

  function handleAssetLoadFailure(event: unknown) {
    if (isChunkLoadFailure(event)) {
      showUpdate("asset-load");
    }
  }

  function start() {
    stopped = false;

    void checkNow();
    startForegroundInterval();

    addDocumentListener("visibilitychange", handleVisibilityChange);
    addWindowListener("focus", handleFocus);
    addWindowListener("error", handleAssetLoadFailure);
    addWindowListener("unhandledrejection", handleAssetLoadFailure);
  }

  function stop() {
    stopped = true;
    clearForegroundInterval();
    removeDocumentListener("visibilitychange", handleVisibilityChange);
    removeWindowListener("focus", handleFocus);
    removeWindowListener("error", handleAssetLoadFailure);
    removeWindowListener("unhandledrejection", handleAssetLoadFailure);
  }

  return {
    checkNow,
    start,
    stop,
  };
}
