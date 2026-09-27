import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { renderToStaticMarkup } from "react-dom/server";

import * as schema from "./db/schema";
import { type HeaderState, normalizeHeaderState } from "./header-state";

const client = new PGlite();
const fixture = drizzle(client, { schema });
const paths: string[] = [];
let headerState: HeaderState = normalizeHeaderState({});
let clerkUnavailable = false;
let pageRequests: Array<{
  requester: { displayName: string; handle: string };
  voters: Array<{ displayName: string }>;
}> = [];
mock.module("server-only", () => ({}));
mock.module("@/lib/mock/db", () => ({
  getMockDb: () => ({ db: fixture }),
  mockDbReady: async () => {},
}));
mock.module("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "owner" }),
  clerkClient: async () => ({
    users: {
      updateUser: async () => {},
      getUserList: async () => {
        if (clerkUnavailable) throw new Error("offline");
        return {
          data: ["owner", "voter"].map((id) => ({
            id,
            username: `old-${id}`,
            firstName: "Old",
            lastName: id,
            imageUrl: null,
          })),
        };
      },
    },
  }),
}));
mock.module("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useUser: () => ({
    isLoaded: true,
    user: {
      id: "owner",
      fullName: "Old owner",
      username: "old-owner",
      imageUrl: "https://img.clerk.com/avatar.png",
      primaryEmailAddress: { emailAddress: "owner@example.com" },
    },
  }),
  useClerk: () => ({
    signOut: () => {},
    openUserProfile: () => {},
    openSignIn: () => {},
  }),
  SignInButton: () => null,
}));
mock.module("@/lib/ratelimit", () => ({
  profileEditRatelimit: { limit: async () => ({ success: true }) },
  profilePinRatelimit: { limit: async () => ({ success: true }) },
  petRequestRatelimit: {},
}));
mock.module("next/cache", () => ({
  revalidatePath: (path: string) => {
    paths.push(path);
  },
}));
mock.module("@/lib/db/cached-aggregates", () => ({
  invalidatePublicProfileCaches: async () => {},
  invalidatePublicHandleCaches: async () => {},
}));
mock.module("@/lib/query-embed", () => ({ embedQuery: async () => [] }));
mock.module("@/lib/r2", () => ({
  R2_PUBLIC_BASE: "https://assets.petdex.dev",
}));
mock.module("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
mock.module("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
mock.module("@/components/site-header", () => ({ SiteHeader: () => null }));
mock.module("@/components/site-footer", () => ({ SiteFooter: () => null }));
mock.module("@/components/requests/requests-view", () => ({
  RequestsView: ({ initial }: { initial: typeof pageRequests }) => {
    pageRequests = initial;
    return null;
  },
}));
mock.module("@/components/layout/header-state-provider", () => ({
  useHeaderState: () => ({ state: headerState }),
}));
mock.module("@/components/auth/auth-intent", () => ({
  useAuthIntent: () => ({ intentVersion: 0, consumeAuthIntent: () => {} }),
}));
mock.module("@/components/notifications/notifications-bell", () => ({
  NotificationsBell: () => null,
}));

await client.exec(`CREATE TABLE user_profiles (user_id text PRIMARY KEY, display_name text, handle text, bio text, preferred_locale text NOT NULL DEFAULT 'en', featured_pet_slugs jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE pet_requests (id text PRIMARY KEY, query text, requested_by text, upvote_count integer, status text, fulfilled_pet_slug text, image_url text, image_review_status text, created_at timestamptz DEFAULT now());
CREATE TABLE pet_request_votes (request_id text, user_id text, created_at timestamptz DEFAULT now());
CREATE TABLE notifications (user_id text, read_at timestamptz);
CREATE TABLE pet_likes (user_id text, pet_slug text);
CREATE TABLE feedback (id text, user_id text, user_last_read_at timestamptz);
CREATE TABLE feedback_replies (feedback_id text, author_kind text, created_at timestamptz);`);
const { PATCH } = await import("@/app/api/profile/route");
const { GET: header } = await import("@/app/api/me/header-state/route");
const { GET: requests } = await import("@/app/api/pet-requests/route");
const { default: RequestsPage } = await import("@/app/[locale]/requests/page");
const { AuthBadge } = await import("@/components/auth/auth-badge-auth");

function edit(body: unknown) {
  return PATCH(
    new Request("https://petdex.dev/api/profile", {
      method: "PATCH",
      headers: {
        origin: "https://petdex.dev",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}
async function readHeader() {
  const response = await header(
    new Request("https://petdex.dev/api/me/header-state", {
      headers: { cookie: "__session=test" },
    }),
  );
  headerState = normalizeHeaderState(await response.json());
  return headerState;
}
async function assertRequests(name: string, handle: string) {
  const response = await requests(
    new Request("https://petdex.dev/api/pet-requests?status=all"),
  );
  const payload = await response.json();
  expect(payload.requests[0].requester.displayName).toBe(name);
  expect(payload.requests[0].requester.handle).toBe(handle);
  expect(payload.requests[0].voters[0].displayName).toBe("Saved voter");
  renderToStaticMarkup(await RequestsPage());
  expect(pageRequests[0].requester.displayName).toBe(name);
  expect(pageRequests[0].requester.handle).toBe(handle);
  expect(pageRequests[0].voters[0].displayName).toBe("Saved voter");
}

beforeEach(async () => {
  paths.length = 0;
  clerkUnavailable = false;
  await client.exec(
    "TRUNCATE user_profiles, pet_requests, pet_request_votes, notifications, pet_likes; INSERT INTO user_profiles (user_id, display_name, handle) VALUES ('owner', 'Previous name', 'owner'), ('voter', 'Saved voter', 'voter'); INSERT INTO pet_requests (id, query, requested_by, upvote_count, status, image_review_status) VALUES ('request', 'Pet', 'owner', 1, 'open', 'none'); INSERT INTO pet_request_votes VALUES ('request', 'voter', now()); INSERT INTO notifications VALUES ('owner', null); INSERT INTO pet_likes VALUES ('owner', 'boba')",
  );
});
afterAll(async () => {
  await client.close();
});
test("editing the name updates all identity consumers", async () => {
  expect((await edit({ displayName: " New   name " })).status).toBe(200);
  expect((await readHeader()).profile.displayName).toBe("New name");
  expect(headerState.notifications.unreadCount).toBe(1);
  expect(headerState.caught).toEqual(["boba"]);
  expect(renderToStaticMarkup(<AuthBadge />)).toContain('alt="New name"');
  await assertRequests("New name", "owner");
  expect(paths).toEqual(["/[locale]/requests"]);
});
test("clearing the override falls back to Clerk", async () => {
  expect((await edit({ displayName: null })).status).toBe(200);
  expect((await readHeader()).profile.displayName).toBeNull();
  expect(renderToStaticMarkup(<AuthBadge />)).toContain('alt="Old owner"');
  await assertRequests("Old owner", "owner");
});
test("saved names and handles survive a Clerk outage", async () => {
  expect(
    (await edit({ displayName: "Saved name", handle: "new-handle" })).status,
  ).toBe(200);
  clerkUnavailable = true;
  await assertRequests("Saved name", "new-handle");
});
test("profiles without an override preserve Clerk names", async () => {
  await client.exec("DELETE FROM user_profiles WHERE user_id = 'owner'");
  expect((await readHeader()).profile.displayName).toBeNull();
  await assertRequests("Old owner", "old-owner");
});
test("bio-only edits do not invalidate request pages", async () => {
  expect((await edit({ bio: "hello" })).status).toBe(200);
  expect(paths).toEqual([]);
});
