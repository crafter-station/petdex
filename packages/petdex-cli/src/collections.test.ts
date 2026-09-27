import { describe, expect, it } from "bun:test";

import {
  collectionRequest,
  confirmCollectionMutation,
  hasBooleanFlag,
  MAX_COLLECTION_PETS,
  overCollectionPetLimit,
  parseCollectionArgs,
  readApprovedPetCount,
  readCollectionList,
} from "./collections";

describe("collectionRequest", () => {
  it("sends bearer credentials and parses a successful response", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = new Request(input as string, init);
      return new Response(JSON.stringify({ collections: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test/", "token", "GET", null),
      ).resolves.toEqual({ collections: [] });
      expect(request?.url).toBe("https://petdex.test/api/cli/collections");
      expect(request?.headers.get("authorization")).toBe("Bearer token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("supports the approved-pet count preflight query", async () => {
    const originalFetch = globalThis.fetch;
    let request: Request | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = new Request(input as string, init);
      return new Response(
        JSON.stringify({ collections: [], approvedPetCount: 1 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest(
          "https://petdex.test",
          "token",
          "GET",
          null,
          undefined,
          "?includeApprovedPetCount=1",
        ),
      ).resolves.toMatchObject({ approvedPetCount: 1 });
      expect(request?.url).toBe(
        "https://petdex.test/api/cli/collections?includeApprovedPetCount=1",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the server error code", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
      })) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test", "token", "GET", "missing"),
      ).rejects.toThrow("not_found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("parses equals syntax, preserves empty values, and validates slugs", () => {
    expect(
      parseCollectionArgs([
        "edit",
        "legacy-id",
        "--title=Renamed",
        "--desc",
        "",
        "--pets",
        "Boba,dora,Boba",
        "--cover",
        "boba",
        "--external-url=https://example.test",
        "--json",
      ]),
    ).toMatchObject({
      action: "edit",
      ref: "legacy-id",
      title: "Renamed",
      description: "",
      petSlugs: ["boba", "dora"],
      coverPetSlug: "boba",
      externalUrl: "https://example.test",
      json: true,
    });
    expect(
      parseCollectionArgs(["edit", "legacy-id", "--cover", " Boba "]),
    ).toMatchObject({ coverPetSlug: "boba" });
    expect(() =>
      parseCollectionArgs(["create", "--title", "Pets", "--pets", "bad slug"]),
    ).toThrow(/^pet_slug$/);
    // Asserted against the exact code, not a substring: "cover_pet_slug"
    // contains "pet_slug", so toThrow("pet_slug") also passed when the cover
    // branch threw its own code — and would keep passing if it threw the
    // member-list one instead.
    expect(() =>
      parseCollectionArgs(["create", "--title", "Pets", "--cover", "bad slug"]),
    ).toThrow(/^cover_pet_slug$/);
    expect(() =>
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--pets",
        Array.from({ length: 25 }, (_, index) => `pet-${index}`).join(","),
      ]),
    ).toThrow("collection_pet_limit");
  });

  it("defers an over-cap edit to the server but still rejects a create", () => {
    // The two entry points that gate on the cap — the argument parser and the
    // --all-approved preflight in the entrypoint — share this predicate, so a
    // change to the create/edit split lands in both.
    expect(overCollectionPetLimit("create", MAX_COLLECTION_PETS + 1)).toBe(
      true,
    );
    expect(overCollectionPetLimit("create", MAX_COLLECTION_PETS)).toBe(false);
    // An edit may hold more than the cap: the answer depends on the stored
    // members, which only the server has.
    expect(overCollectionPetLimit("edit", MAX_COLLECTION_PETS + 6)).toBe(false);
    expect(overCollectionPetLimit("delete", 99)).toBe(false);
    expect(overCollectionPetLimit("list", 99)).toBe(false);
  });

  it("lets an edit past the local cap and defers to the server", () => {
    // The cap bounds growth, so whether an over-cap list is allowed depends on
    // what the collection already stores. A collection created before the cap
    // existed still holds its members, and renaming it resends that same list.
    // Rejecting it here would make the collection uneditable from the CLI even
    // though the server accepts an unchanged over-cap list.
    const stored = Array.from(
      { length: MAX_COLLECTION_PETS + 6 },
      (_, index) => `pet-${index}`,
    );

    expect(
      parseCollectionArgs([
        "edit",
        "c1",
        "--title",
        "New",
        "--pets",
        stored.join(","),
      ]).petSlugs,
    ).toHaveLength(MAX_COLLECTION_PETS + 6);
  });

  it("ignores --pets validation when --all-approved wins", () => {
    // The server replaces the explicit list with every approved pet whenever
    // allApproved is set, so a --pets list that is oversized or malformed is
    // never sent and must not fail the command locally.
    const oversized = Array.from(
      { length: MAX_COLLECTION_PETS + 1 },
      (_, index) => `pet-${index}`,
    ).join(",");

    expect(
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--all-approved",
        "--pets",
        oversized,
      ]),
    ).toMatchObject({ allApproved: true });

    expect(
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--all-approved",
        "--pets",
        "not a slug",
      ]),
    ).toMatchObject({ allApproved: true });
  });

  it("accepts --flag=true for the boolean flags", () => {
    // args.includes("--yes") is false for "--yes=true", so a caller who wrote
    // the value form was told the flag was missing.
    expect(parseCollectionArgs(["delete", "c1", "--yes=true"])).toMatchObject({
      yes: true,
    });
    expect(
      parseCollectionArgs(["create", "--title", "T", "--all-approved=true"]),
    ).toMatchObject({ allApproved: true });
    expect(parseCollectionArgs(["list", "--json=true"])).toMatchObject({
      json: true,
    });
  });

  it("refuses a --cover the explicit --pets list omits", () => {
    // The server rejects a cover that is not in the list it writes, so a
    // request naming both is decidable locally. An edit with no --pets keeps
    // the stored members, which the parser cannot see, so that stays with the
    // server.
    expect(() =>
      parseCollectionArgs(["edit", "c1", "--pets", "boba", "--cover", "mochi"]),
    ).toThrow("cover_not_in_pets");
    expect(() =>
      parseCollectionArgs([
        "create",
        "--title",
        "T",
        "--pets",
        "boba",
        "--cover",
        "mochi",
      ]),
    ).toThrow("cover_not_in_pets");

    // A cover that is in the list is fine on both actions.
    expect(
      parseCollectionArgs(["edit", "c1", "--pets", "boba", "--cover", "boba"]),
    ).toMatchObject({ petSlugs: ["boba"], coverPetSlug: "boba" });
    // --all-approved supplies the members server-side, so the parser cannot
    // judge the cover and must not reject it.
    expect(
      parseCollectionArgs(["edit", "c1", "--all-approved", "--cover", "boba"]),
    ).toMatchObject({ coverPetSlug: "boba" });
  });

  it("keeps a blank --cover as an explicit clear rather than dropping it", () => {
    // --cover has three states and they must stay distinct. Absent leaves the
    // cover alone; blank clears it, which the server normalizes from "" to null
    // (normalizeCollectionCover) and `--cover "$UNSET_VAR"` produces by
    // accident; a slug sets it. Collapsing the blank to null would merge the
    // first two, and the entrypoint only sends the field when it is not null,
    // so the clear would silently become a no-op.
    for (const args of [
      ["create", "--title", "T", "--pets", "boba", "--cover", ""],
      ["create", "--title", "T", "--pets", "boba", "--cover="],
      ["edit", "c1", "--pets", "boba", "--cover", ""],
      ["edit", "c1", "--cover", " "],
    ]) {
      expect(parseCollectionArgs(args).coverPetSlug).toBe("");
    }
    // Absent is still null, not blank.
    expect(
      parseCollectionArgs(["edit", "c1", "--title", "T"]).coverPetSlug,
    ).toBeNull();
    // A blank cover is a real update on its own, so it must not be refused for
    // having nothing to do...
    expect(
      parseCollectionArgs(["edit", "c1", "--cover", ""]).coverPetSlug,
    ).toBe("");
    // ...and it names no member, so it must not be judged as a slug that has to
    // appear in --pets.
    expect(
      parseCollectionArgs(["edit", "c1", "--pets", "boba", "--cover", ""]),
    ).toMatchObject({ petSlugs: ["boba"], coverPetSlug: "" });
  });

  it("ignores --pets and --cover on actions that never send them", () => {
    // list returns before the body is built and delete sends no body at all, so
    // both flags are inert there. Every check on a value flag is scoped to the
    // actions that send it, matching how the parser already treats a flag an
    // action does not use (an unknown --flag, or --title on a list, is dropped
    // rather than refused). Without the scoping, a malformed or over-cap value
    // would fail a command that never reads it.
    const inert: Array<[string[], string]> = [
      [["list", "--pets", "boba", "--cover", "mochi"], "list"],
      [
        ["delete", "c1", "--yes", "--pets", "boba", "--cover", "mochi"],
        "delete",
      ],
    ];
    for (const [args, action] of inert) {
      expect(parseCollectionArgs(args)).toMatchObject({
        action,
        petSlugs: null,
        coverPetSlug: null,
      });
    }
    // The values that would be refused on create/edit are accepted here, and
    // dropped rather than carried into the parsed result.
    for (const args of [
      ["list", "--pets", ""],
      ["list", "--pets", "NOT A SLUG"],
      ["list", "--cover", "NOT A SLUG"],
      ["delete", "c1", "--yes", "--pets", ""],
      ["delete", "c1", "--yes", "--cover", "NOT A SLUG"],
      [
        "delete",
        "c1",
        "--yes",
        "--pets",
        Array.from({ length: 30 }, (_, i) => `p${i}`).join(","),
      ],
    ]) {
      expect(parseCollectionArgs(args)).toMatchObject({
        petSlugs: null,
        coverPetSlug: null,
      });
    }
  });

  it("refuses a create --cover that names no member", () => {
    // The server requires the cover to be a member. On a create the member list
    // is the only source of members, so --cover with neither --pets nor
    // --all-approved is guaranteed to come back cover_not_in_collection. Catch
    // it locally so the message names the flag to add.
    // The exact code, not a regex that accepts either: a cover with no member
    // list is the case this gate exists for, and asserting the pair would let
    // the wrong branch satisfy it.
    expect(() =>
      parseCollectionArgs(["create", "--title", "T", "--cover", "boba"]),
    ).toThrow("cover_without_pets");
    // An explicit but empty --pets is refused earlier, as empty_pets. Which one
    // fires must not depend on argument order.
    expect(() =>
      parseCollectionArgs([
        "create",
        "--title",
        "T",
        "--pets",
        "",
        "--cover",
        "boba",
      ]),
    ).toThrow("empty_pets");

    // Both ways of supplying members make the cover legal again.
    expect(
      parseCollectionArgs([
        "create",
        "--title",
        "T",
        "--pets",
        "boba",
        "--cover",
        "boba",
      ]),
    ).toMatchObject({ coverPetSlug: "boba" });
    expect(
      parseCollectionArgs([
        "create",
        "--title",
        "T",
        "--all-approved",
        "--cover",
        "boba",
      ]),
    ).toMatchObject({ coverPetSlug: "boba" });
    // An edit derives the cover from the stored members, so it is unaffected.
    expect(
      parseCollectionArgs(["edit", "c1", "--cover", "boba"]),
    ).toMatchObject({ coverPetSlug: "boba" });
  });

  it("refuses an empty --pets list instead of emptying the collection", () => {
    // `--pets ""` and `--pets $UNSET_VAR` both parse to []. The server treats
    // an empty list as "replace the members with nothing", so sending it would
    // silently wipe the collection on a typo.
    for (const args of [
      ["edit", "c1", "--pets", ""],
      ["edit", "c1", "--pets="],
      ["edit", "c1", "--pets", ","],
      ["edit", "c1", "--pets", " , "],
    ]) {
      expect(() => parseCollectionArgs(args)).toThrow("empty_pets");
    }
  });

  it("still accepts a real --pets list and treats an absent flag as unchanged", () => {
    expect(
      parseCollectionArgs(["edit", "c1", "--pets", "boba"]).petSlugs,
    ).toEqual(["boba"]);
    // Absent stays null so the server leaves the current members alone.
    expect(
      parseCollectionArgs(["edit", "c1", "--desc", "x"]).petSlugs,
    ).toBeNull();
    // --all-approved replaces the list server-side, so an empty --pets is moot.
    expect(
      parseCollectionArgs(["edit", "c1", "--all-approved", "--pets", ""])
        .petSlugs,
    ).toBeNull();
  });

  it("reports --json=true as machine-readable output", () => {
    // The entrypoint suppresses the first-run notice before it parses the
    // arguments, so it asks hasBooleanFlag directly. Reading the raw args
    // there would let a `--json=true` invocation print the notice into the
    // JSON stream a caller is piping.
    expect(hasBooleanFlag(["list", "--json=true"], "--json")).toBe(true);
    expect(hasBooleanFlag(["list", "--json"], "--json")).toBe(true);
    expect(hasBooleanFlag(["list", "--json=false"], "--json")).toBe(false);
    expect(hasBooleanFlag(["list"], "--json")).toBe(false);
  });

  it("treats an explicit false value as absent", () => {
    expect(parseCollectionArgs(["delete", "c1", "--yes=false"])).toMatchObject({
      yes: false,
    });
    expect(
      parseCollectionArgs(["create", "--title", "T", "--all-approved=0"]),
    ).toMatchObject({ allApproved: false });
  });

  it("still validates --pets when --all-approved is absent", () => {
    expect(() =>
      parseCollectionArgs([
        "create",
        "--title",
        "Pets",
        "--pets",
        "not a slug",
      ]),
    ).toThrow("pet_slug");
  });

  it("maps rate limits to an actionable error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
      })) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test", "token", "GET", null),
      ).rejects.toThrow("rate limited");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a 200 whose body is not a JSON object", async () => {
    // A captive portal, a misconfigured proxy, or a CDN error page answers
    // with HTTP 200 and HTML. Collapsing that to {} made `delete` report
    // success and `list` print nothing, so the caller could not tell a real
    // result from a proxy page.
    const originalFetch = globalThis.fetch;
    for (const body of ["<html>WiFi login</html>", "", "{not json", "[1,2]"]) {
      globalThis.fetch = (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch;
      try {
        await expect(
          collectionRequest("https://petdex.test", "token", "GET", null),
        ).rejects.toThrow("unexpected_response_200");
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  it("still returns a real JSON body on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ collections: [] }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      await expect(
        collectionRequest("https://petdex.test", "token", "GET", null),
      ).resolves.toEqual({ collections: [] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps collection pet limits to an actionable error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "collection_pet_limit" }), {
        status: 400,
      })) as unknown as typeof fetch;
    try {
      // Only an edit reaches this string: create is refused locally. So it has
      // to describe the growth rule, not a flat cap the stored row may already
      // exceed — and it must not blame --all-approved, which the caller of an
      // edit that hits this has not passed.
      const message = await collectionRequest(
        "https://petdex.test",
        "token",
        "POST",
        null,
      ).then(
        () => "",
        (error: Error) => error.message,
      );

      expect(message).toContain("cannot grow past 24 pets");
      expect(message).not.toContain("--all-approved");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("readApprovedPetCount", () => {
  it("refuses a zero count, which would send an empty member list", () => {
    // The server reads an empty list as "replace the members with nothing", and
    // deleteCollectionItemsQuery then emits a DELETE with no pet_slug filter —
    // so --all-approved on an account with no approved pets left wiped the
    // collection and still answered 200. Un-approving a pet leaves its member
    // rows behind, so a non-empty collection with an empty approved set is
    // reachable, not theoretical.
    expect(readApprovedPetCount(0)).toEqual({
      ok: false,
      reason: "empty_approved_pets",
    });
  });

  it("rejects a malformed count instead of trusting it", () => {
    for (const bad of [undefined, null, "3", 1.5, -1, Number.NaN, {}]) {
      expect(readApprovedPetCount(bad)).toEqual({
        ok: false,
        reason: "invalid_approved_pets",
      });
    }
  });

  it("narrows a real count so the caller does not re-check the type", () => {
    // Guards against the fix overshooting: petdex collection edit <ref>
    // --all-approved is the documented invocation and must still run. The
    // narrowed count is what the entrypoint compares against the cap, so a
    // helper that returned a bare verdict would need a second, duplicating
    // typeof check at the callsite.
    for (const good of [1, 24, 500]) {
      expect(readApprovedPetCount(good)).toEqual({ ok: true, count: good });
    }
  });
});

describe("parseCollectionArgs confirms a deletion only on an explicit yes", () => {
  it("does not read a negative or empty --yes value as confirmation", () => {
    // The assertion that makes the strict reading load-bearing: testing
    // hasBooleanFlag directly proves the option works, not that the parser
    // passes it. Reverting the parser to the lenient call left the direct test
    // green, because the delete path is the only thing that reads --yes.
    for (const spelling of [
      "--yes=no",
      "--yes=off",
      "--yes=n",
      "--yes=",
      "--yes=maybe",
    ]) {
      expect(
        parseCollectionArgs(["delete", "c1", spelling]).yes,
        `${spelling} must not confirm`,
      ).toBe(false);
    }
    for (const spelling of ["--yes", "--yes=true", "--yes=1", "--yes=yes"]) {
      expect(
        parseCollectionArgs(["delete", "c1", spelling]).yes,
        `${spelling} must confirm`,
      ).toBe(true);
    }
  });
});

describe("hasBooleanFlag with strict", () => {
  it("refuses a negative or unrecognised value where a wrong true destroys data", () => {
    // --yes authorizes an irreversible delete. Reading `--yes=no` as true
    // deleted the collection, and `--yes "$CONFIRM"` with an unset variable
    // sent an empty value that did the same. Only an explicit affirmative may
    // confirm.
    for (const spelling of [
      "--yes=no",
      "--yes=off",
      "--yes=n",
      "--yes=",
      "--yes=maybe",
      "--yes=NO",
    ]) {
      expect(
        hasBooleanFlag(["delete", "c1", spelling], "--yes", { strict: true }),
      ).toBe(false);
    }
    for (const spelling of [
      "--yes",
      "--yes=true",
      "--yes=1",
      "--yes=yes",
      "--yes=on",
      "--yes=TRUE",
    ]) {
      expect(
        hasBooleanFlag(["delete", "c1", spelling], "--yes", { strict: true }),
      ).toBe(true);
    }
  });

  it("keeps the lenient reading for --json, where a stray value still means machine output", () => {
    // The opposite direction is the safe one here: a caller asking for JSON
    // gets it, and a value the flag was never given does not silently switch
    // the output back to the human table.
    expect(hasBooleanFlag(["list", "--json=1"], "--json")).toBe(true);
    expect(hasBooleanFlag(["list", "--json=whatever"], "--json")).toBe(true);
    expect(hasBooleanFlag(["list", "--json=false"], "--json")).toBe(false);
    expect(hasBooleanFlag(["list", "--json=0"], "--json")).toBe(false);
  });
});

describe("readCollectionList", () => {
  it("refuses a body with no collection list", () => {
    // The raw engine string this replaces was "{} is not iterable". A
    // version-skewed deployment, or an error envelope sent with 200, produced
    // it — and the caller could not tell it from a bug in the CLI.
    expect(() => readCollectionList({})).toThrow(/no collection list/);
    expect(() => readCollectionList({ collections: null })).toThrow(
      /no collection list/,
    );
    expect(() => readCollectionList(null)).toThrow(/no collection list/);
  });

  it("refuses a malformed entry inside an otherwise valid list", () => {
    // The array check alone does not make the elements readable: a null entry
    // threw `null is not an object (evaluating 'c.slug')`, the same class of
    // raw engine string the guard exists to prevent.
    expect(() => readCollectionList({ collections: [null] })).toThrow(
      /malformed entry/,
    );
    expect(() => readCollectionList({ collections: ["boba"] })).toThrow(
      /malformed entry/,
    );
  });

  it("returns the records for a well-formed list, including an empty one", () => {
    expect(readCollectionList({ collections: [] })).toEqual([]);
    const record = {
      id: "col_1",
      slug: "desk-crew",
      title: "Desk crew",
      description: "",
      externalUrl: null,
      coverPetSlug: null,
      featured: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      petSlugs: ["boba"],
    };
    expect(readCollectionList({ collections: [record] })).toEqual([record]);
  });
});

describe("confirmCollectionMutation", () => {
  it("requires an explicit ok, not just a 2xx status", () => {
    // collectionRequest rejects an error envelope only when it arrives with a
    // non-2xx status, so a 200 carrying {"error":"not_found"} used to be
    // reported as a successful deletion — on an irreversible action, and with
    // --json printing the error envelope while still exiting 0.
    expect(() =>
      confirmCollectionMutation({ error: "not_found" }, "deleted"),
    ).toThrow(/not confirmed deleted/);
    expect(() => confirmCollectionMutation({}, "created")).toThrow(
      /not confirmed created/,
    );
    expect(() => confirmCollectionMutation(null, "updated")).toThrow(
      /not confirmed updated/,
    );
    expect(() => confirmCollectionMutation({ ok: "true" }, "deleted")).toThrow(
      /not confirmed deleted/,
    );
  });

  it("accepts the server's real response for each action", () => {
    expect(() =>
      confirmCollectionMutation({ ok: true }, "created"),
    ).not.toThrow();
    expect(() =>
      confirmCollectionMutation({ ok: true }, "updated"),
    ).not.toThrow();
    expect(() =>
      confirmCollectionMutation({ ok: true }, "deleted"),
    ).not.toThrow();
  });
});
