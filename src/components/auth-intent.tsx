"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type AuthIntentContextValue = {
  authActive: boolean;
  intentVersion: number;
  requestAuth: () => void;
  consumeAuthIntent: (version: number) => void;
};

const AuthIntentContext = createContext<AuthIntentContextValue | null>(null);

function hasClerkSessionCookie(): boolean {
  return document.cookie.split(";").some((part) => {
    const name = part.trim().split("=", 1)[0];
    return name === "__session" || name.startsWith("__session_");
  });
}

function urlRequestsAuth(): boolean {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get("signin") === "1" ||
    params.get("signIn") === "1" ||
    params.get("auth") === "1"
  );
}

export function AuthIntentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [authActive, setAuthActive] = useState(false);
  const [intentVersion, setIntentVersion] = useState(0);

  const requestAuth = useCallback(() => {
    setAuthActive(true);
    setIntentVersion((current) => current + 1);
  }, []);

  const consumeAuthIntent = useCallback((version: number) => {
    setIntentVersion((current) => (current === version ? 0 : current));
  }, []);

  useEffect(() => {
    if (hasClerkSessionCookie()) {
      setAuthActive(true);
    }
    if (urlRequestsAuth()) {
      requestAuth();
    }
    const onAuthIntent = () => requestAuth();
    window.addEventListener("petdex:auth-intent", onAuthIntent);
    return () => {
      window.removeEventListener("petdex:auth-intent", onAuthIntent);
    };
  }, [requestAuth]);

  const value = useMemo(
    () => ({ authActive, consumeAuthIntent, intentVersion, requestAuth }),
    [authActive, consumeAuthIntent, intentVersion, requestAuth],
  );

  return (
    <AuthIntentContext.Provider value={value}>
      {children}
    </AuthIntentContext.Provider>
  );
}

export function useAuthIntent(): AuthIntentContextValue {
  const ctx = useContext(AuthIntentContext);
  if (ctx) return ctx;
  return {
    authActive: false,
    consumeAuthIntent: () => {},
    intentVersion: 0,
    requestAuth: () => {},
  };
}
