import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  canAccessCollaboratorArea,
  canAccessCollaboratorAreaClientSafe,
  canModeratePublishedPets,
  canModeratePublishedPetsClientSafe,
  canReviewPetSubmissions,
  isAdmin,
  isCollaborator,
} from "@/lib/admin";

const ENV_KEYS = [
  "PETDEX_ADMIN_USER_IDS",
  "NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS",
  "PETDEX_COLLABORATOR_USER_IDS",
  "NEXT_PUBLIC_PETDEX_COLLABORATOR_USER_IDS",
  "PETDEX_MODERATOR_USER_IDS",
  "NEXT_PUBLIC_PETDEX_MODERATOR_USER_IDS",
] as const;

const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

describe("published pet moderation permissions", () => {
  it("lets moderators enter collaborator area without review permissions", () => {
    process.env.PETDEX_MODERATOR_USER_IDS = "user_mod";

    expect(canModeratePublishedPets("user_mod")).toBe(true);
    expect(canAccessCollaboratorArea("user_mod")).toBe(true);
    expect(isAdmin("user_mod")).toBe(false);
    expect(isCollaborator("user_mod")).toBe(false);
    expect(canReviewPetSubmissions("user_mod")).toBe(false);
  });

  it("keeps public moderator visibility separate from collaborator review", () => {
    process.env.NEXT_PUBLIC_PETDEX_MODERATOR_USER_IDS = "user_mod";

    expect(canModeratePublishedPetsClientSafe("user_mod")).toBe(true);
    expect(canAccessCollaboratorAreaClientSafe("user_mod")).toBe(true);
  });

  it("treats admins as moderators", () => {
    process.env.PETDEX_ADMIN_USER_IDS = "user_admin";
    process.env.NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS = "user_admin";

    expect(canModeratePublishedPets("user_admin")).toBe(true);
    expect(canModeratePublishedPetsClientSafe("user_admin")).toBe(true);
  });
});
