"use client";

// Mock implementation of @clerk/nextjs (client side) for PETDEX_MOCK=1.
// next.config.ts swaps the real package for this file. Hooks return a
// fixed signed-in user so all client UI behaves like a logged-in
// contributor without ever calling Clerk.

import type { ReactNode } from "react";

import { MOCK_USER } from "./index";

const MOCK_USER_OBJ = {
  id: MOCK_USER.userId,
  username: MOCK_USER.username,
  firstName: MOCK_USER.firstName,
  lastName: MOCK_USER.lastName,
  fullName: `${MOCK_USER.firstName} ${MOCK_USER.lastName}`,
  imageUrl: MOCK_USER.imageUrl ?? "",
  primaryEmailAddress: { emailAddress: MOCK_USER.email },
  emailAddresses: [{ emailAddress: MOCK_USER.email, id: "email_mock" }],
  publicMetadata: {} as Record<string, unknown>,
  externalAccounts: [] as Array<unknown>,
  reload: async () => undefined,
  update: async () => MOCK_USER_OBJ,
};

export function ClerkProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function useAuth() {
  return {
    isLoaded: true,
    isSignedIn: true,
    userId: MOCK_USER.userId,
    sessionId: "sess_mock",
    orgId: null,
    orgRole: null,
    signOut: async () => undefined,
    getToken: async () => "mock_token",
  };
}

export function useUser() {
  return {
    isLoaded: true,
    isSignedIn: true,
    user: MOCK_USER_OBJ,
  };
}

export function useClerk() {
  return {
    user: MOCK_USER_OBJ,
    session: { id: "sess_mock" },
    signOut: async () => undefined,
    openSignIn: () => undefined,
    openSignUp: () => undefined,
    redirectToSignIn: () => undefined,
  };
}

export function SignInButton({ children }: { children?: ReactNode }) {
  return <>{children ?? "Sign in (mock)"}</>;
}

export function SignUpButton({ children }: { children?: ReactNode }) {
  return <>{children ?? "Sign up (mock)"}</>;
}

export function UserButton() {
  return (
    <div
      style={{
        width: 44,
        height: 44,
        borderRadius: "50%",
        background: "#666",
        color: "white",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        fontFamily: "monospace",
      }}
      title={`${MOCK_USER.email} (mock)`}
    >
      {MOCK_USER.username?.[0]?.toUpperCase() ?? "M"}
    </div>
  );
}

export function SignedIn({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function SignedOut(_: { children: ReactNode }) {
  return null;
}
