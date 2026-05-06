"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type HeaderState = {
  signedIn: boolean;
  notifications: { unreadCount: number };
  feedback: { count: number; adminCount: number };
  caught: string[];
};

const INITIAL: HeaderState = {
  signedIn: false,
  notifications: { unreadCount: 0 },
  feedback: { count: 0, adminCount: 0 },
  caught: [],
};

type Ctx = {
  state: HeaderState;
  refresh: () => Promise<void>;
};

const HeaderStateContext = createContext<Ctx | null>(null);

const POLL_MS = 90_000;

// Single source of truth for SiteHeader badges + caught-slug set.
// Replaces 3 separate fetches per page-view (auth-badge feedback unread,
// notifications-bell unread, pet-gallery caught slugs) with 1 polled
// aggregate from /api/me/header-state. Cuts Edge Requests ~3x on busy
// pages, which is what was driving the May 5-6 Vercel spike.
export function HeaderStateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [state, setState] = useState<HeaderState>(INITIAL);
  const stopped = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/me/header-state", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as HeaderState;
      if (!stopped.current) setState(json);
    } catch {
      /* offline / network blip — keep last known state */
    }
  }, []);

  useEffect(() => {
    stopped.current = false;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped.current = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return (
    <HeaderStateContext.Provider value={{ state, refresh }}>
      {children}
    </HeaderStateContext.Provider>
  );
}

export function useHeaderState(): Ctx {
  const ctx = useContext(HeaderStateContext);
  if (ctx) return ctx;
  return { state: INITIAL, refresh: async () => {} };
}
