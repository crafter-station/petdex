export type CollectionRecord = {
  id: string;
  slug: string;
  title: string;
  description: string;
  externalUrl: string | null;
  coverPetSlug: string | null;
  featured: boolean;
  createdAt: string;
  updatedAt: string;
  petSlugs: string[];
};

export type CollectionAction = "list" | "create" | "edit" | "delete";

export type ParsedCollectionArgs = {
  action: CollectionAction;
  ref: string | null;
  title: string | null;
  description: string | null;
  petSlugs: string[] | null;
  /**
   * null when --cover was not passed at all, "" when it was passed blank
   * (which clears the cover), and a slug otherwise. The three states matter:
   * the entrypoint only puts the field in the body when it is not null, so
   * collapsing a blank to null would turn a clear into a no-op.
   */
  coverPetSlug: string | null;
  externalUrl: string | null;
  allApproved: boolean;
  yes: boolean;
  json: boolean;
};

export const MAX_COLLECTION_PETS = 24;

const PET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Whether a boolean flag is set, accepting both `--flag` and `--flag=<value>`.
 *
 * Only the two spellings a script actually writes mean false: `--flag=false`
 * and `--flag=0`. Everything else that follows an `=` is a value the flag was
 * never given, and reading it as true is the safe direction for `--json` (it
 * asks for machine output) but not for `--yes`, which authorizes an
 * irreversible delete. The caller passes `strict` where a wrong `true` is
 * destructive: then only `--flag` and an explicit affirmative count, and
 * `--yes=no`, `--yes=off`, `--yes=` and a stray word all refuse.
 *
 * Exported because the entrypoint has to answer the same question before it
 * has parsed the arguments: the first-run notice is suppressed for
 * machine-readable output, and `--json=true` counts.
 */
const AFFIRMATIVE_VALUES = new Set(["1", "true", "yes", "on"]);

export function hasBooleanFlag(
  args: string[],
  name: string,
  options: { strict?: boolean } = {},
): boolean {
  const prefix = `${name}=`;
  const equals = args.find((arg) => arg.startsWith(prefix));
  if (equals !== undefined) {
    const value = equals.slice(prefix.length).trim().toLowerCase();
    return options.strict
      ? AFFIRMATIVE_VALUES.has(value)
      : value !== "false" && value !== "0";
  }
  return args.includes(name);
}

/**
 * Whether a locally-computed member list is definitely going to be rejected.
 *
 * Mirrors collectionPetLimitExceeded() on the server: the cap bounds growth, so
 * only a create — which has no stored members to compare against — can be
 * decided from the list alone. An edit may legitimately hold more than the cap
 * (a collection created before it existed), so it is left to the server, which
 * knows what the row already stores.
 */
export function overCollectionPetLimit(
  action: CollectionAction,
  memberCount: number,
): boolean {
  return action === "create" && memberCount > MAX_COLLECTION_PETS;
}

const ERROR_MESSAGES: Record<string, string> = {
  collection_cap_reached: "collection limit reached",
  // Only an edit reaches this: the create path is refused locally by
  // overCollectionPetLimit() and by the --all-approved preflight, and both
  // report their own message. So this must describe the growth rule the server
  // enforces — an over-cap row keeps its members and may still be renamed or
  // shrunk — rather than a flat "cannot contain" the row already disproves.
  // Reachable only from an edit: a create is refused locally by
  // overCollectionPetLimit() and by the --all-approved preflight, which report
  // their own messages. An edit reaches it either with an explicit --pets list
  // or with --all-approved, and "pass a subset with --pets" is the fix in both
  // cases — a caller already using --pets passes a smaller one, and a caller
  // using --all-approved switches to --pets. Naming the flag would be wrong for
  // whichever of the two did not send it.
  collection_pet_limit: `collection cannot grow past ${MAX_COLLECTION_PETS} pets; pass a subset with --pets`,
  collection_slug_conflict: "could not allocate a unique collection slug",
  cover_not_in_collection: "cover pet must be in the collection",
  description_length: "description must be at most 280 characters",
  description_type: "description must be a string",
  // Reached only through a race: the --all-approved preflight reads a non-zero
  // count and the account's approved set is empty by the time the write lands.
  // The local gates refuse every other way to send an empty list.
  empty_pet_slugs:
    "the server refused an empty member list; it would have removed every member",
  featured_not_deletable: "featured collections cannot be deleted",
  featured_not_editable: "featured collections cannot be edited",
  invalid_body: "request body must be a JSON object",
  invalid_cover_pet: "invalid cover pet slug",
  invalid_url: "external URL must use https",
  nothing_to_update: "nothing to update",
  not_found: "collection not found or not owned by you",
  pet_not_owned_or_approved: "all pets must be approved and owned by you",
  pet_slug:
    "every pet slug must be lowercase letters, digits and single hyphens",
  pet_slugs: "petSlugs must be a list of pet slugs",
  title_length: "title must be between 2 and 80 characters",
  unauthorized: "not signed in; run `petdex login`",
};

export function parseCollectionArgs(args: string[]): ParsedCollectionArgs {
  const action = args[0];
  if (
    action !== "list" &&
    action !== "create" &&
    action !== "edit" &&
    action !== "delete"
  ) {
    throw new Error("usage");
  }
  const ref =
    action === "create" || action === "list"
      ? null
      : args[1] && !args[1].startsWith("--")
        ? args[1]
        : null;
  if ((action === "edit" || action === "delete") && !ref)
    throw new Error("missing_collection");
  const readBoolean = (name: string): boolean => hasBooleanFlag(args, name);

  const readFlag = (name: string): string | null => {
    const prefix = `${name}=`;
    const equals = args.find((arg) => arg.startsWith(prefix));
    if (equals !== undefined) return equals.slice(prefix.length);
    const index = args.indexOf(name);
    if (index === -1) return null;
    const value = args[index + 1];
    return value !== undefined && !value.startsWith("--") ? value : null;
  };
  const allApproved = readBoolean("--all-approved");
  // --pets and --cover only travel in the request body, and only create and
  // edit have one: list returns before the body is built and delete sends no
  // body at all. On those two actions both flags are inert, and the parser's
  // rule elsewhere is to ignore a flag an action does not use — an unknown
  // --flag, or --title on a list, is accepted and dropped. Refusing them here
  // would fail a command that never reads the value.
  const sendsBody = action === "create" || action === "edit";
  const petsArg = readFlag("--pets");
  // --all-approved replaces the explicit list server-side, so an oversized or
  // malformed --pets is never sent and must not fail the command locally.
  const petSlugs =
    petsArg === null || allApproved || !sendsBody
      ? null
      : Array.from(
          new Set(
            petsArg
              .split(",")
              .map((slug) => slug.trim().toLowerCase())
              .filter(Boolean),
          ),
        );
  // `--pets ""` (or `--pets $UNSET_VAR`) parses to an empty list, which the
  // server reads as "replace the members with nothing" and silently empties
  // the collection. Refuse it: an accidental empty expansion must not destroy
  // data, and there is no way to tell the two apart.
  if (petSlugs !== null && petSlugs.length === 0) throw new Error("empty_pets");
  if (petSlugs?.some((slug) => !PET_SLUG.test(slug)))
    throw new Error("pet_slug");
  // Only a create can be judged here. The pet cap bounds growth, so whether an
  // over-cap list is allowed depends on what the collection already stores: a
  // row created before the cap existed keeps its members and may still be
  // renamed or shrunk. A create has no stored row, so over-cap is always a
  // rejection; an edit knows nothing about the stored members yet and has to
  // let the server decide instead of blocking a legal rename locally.
  if (petSlugs && overCollectionPetLimit(action, petSlugs.length))
    throw new Error("collection_pet_limit");
  const title = readFlag("--title");
  if (action === "create" && title === null) throw new Error("missing_title");
  const description = readFlag("--desc");
  // --cover has three states and they must stay distinct. Absent means "leave
  // the cover alone"; blank means "clear it", which the server normalizes from
  // "" to null (normalizeCollectionCover) and `--cover "$UNSET"` produces by
  // accident; a slug means "set it". Collapsing the blank to null would merge
  // the first two: the entrypoint only sends the field when it is not null, so
  // the clear would become a no-op — or, with no other flag set, a refusal
  // from the nothing_to_update check below.
  const coverArg = sendsBody ? readFlag("--cover") : null;
  const coverPetSlug = coverArg === null ? null : coverArg.trim().toLowerCase();
  if (coverPetSlug && !PET_SLUG.test(coverPetSlug)) {
    throw new Error("cover_pet_slug");
  }
  // The checks below judge a cover that names a member, so they read the blank
  // state as "no cover named" rather than as a slug.
  const namedCover = coverPetSlug || null;
  // A cover must name a member. The server rejects a cover that is not in the
  // list it is writing, so a request that names both is decidable here, and
  // refusing it locally names the flag to fix instead of making the caller
  // round-trip for a restatement of the rule. Two shapes are decidable:
  //   - an action whose explicit --pets omits the cover, and
  //   - a create with a cover but no member list at all (--pets is the only
  //     source of members on create).
  // An edit with no --pets keeps the stored members, which the parser cannot
  // see, so that case is left to the server — as is --all-approved, which
  // supplies the members server-side.
  if (sendsBody) {
    if (namedCover !== null && petSlugs !== null) {
      if (!petSlugs.includes(namedCover)) {
        throw new Error("cover_not_in_pets");
      }
    } else if (action === "create" && namedCover !== null && !allApproved) {
      throw new Error("cover_without_pets");
    }
  }
  const externalUrl = readFlag("--external-url");
  if (
    action === "edit" &&
    title === null &&
    description === null &&
    petSlugs === null &&
    coverPetSlug === null &&
    externalUrl === null &&
    !allApproved
  ) {
    throw new Error("nothing_to_update");
  }
  return {
    action,
    ref,
    title,
    description,
    petSlugs,
    coverPetSlug,
    externalUrl,
    allApproved,
    // Strict: this flag authorizes an irreversible delete, so an unexpected
    // value must refuse rather than confirm. `--yes=no` read as true deleted
    // the collection.
    yes: hasBooleanFlag(args, "--yes", { strict: true }),
    json: readBoolean("--json"),
  };
}

/**
 * Parse a response body into a JSON object, or null when the body is not one.
 *
 * A non-JSON body is NOT the same as an empty object: a captive portal, a
 * misconfigured proxy, or a CDN error page answers with HTTP 200 and HTML.
 * Collapsing that to {} made `delete` report success and `list` print
 * nothing, so a caller could not tell a real result from a proxy page.
 */
function parseCollectionResponse(
  raw: string | null,
): { error?: string; [key: string]: unknown } | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as { error?: string; [key: string]: unknown };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * The collection list out of a `list` response, or a thrown sentence.
 *
 * collectionRequest only proves the body parsed to a JSON object, not that it
 * has the shape this command indexes into. A version-skewed deployment, or an
 * error envelope sent with 200, otherwise reaches the caller as a raw engine
 * string ("{} is not iterable"). The element check is part of that: a null
 * entry in an otherwise valid array threw the same class of string.
 */
export function readCollectionList(result: unknown): CollectionRecord[] {
  const collections = (result as { collections?: unknown } | null)?.collections;
  if (!Array.isArray(collections)) {
    throw new Error(
      "Unexpected response from the server: the body has no collection list. Check PETDEX_URL, or retry.",
    );
  }
  for (const entry of collections) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        "Unexpected response from the server: the collection list holds a malformed entry. Check PETDEX_URL, or retry.",
      );
    }
  }
  return collections as CollectionRecord[];
}

/**
 * Confirm a collection mutation the server acknowledged.
 *
 * A 2xx is not proof: collectionRequest rejects an error envelope only when it
 * arrives with a non-2xx status, so a 200 carrying `{"error":"not_found"}` — a
 * version-skewed deployment, or a proxy that rewrites the status — would be
 * reported as success. All three mutating routes answer `{ok:true}` on the real
 * path, so require it rather than trusting the status alone.
 *
 * This matters most for `delete`, which cannot be undone, but the same reading
 * applies to the other two: under `--json` a create or edit would print the
 * error envelope and still exit 0, and a caller deciding on the exit code alone
 * would take it for success.
 */
export function confirmCollectionMutation(
  result: unknown,
  action: "created" | "updated" | "deleted",
): void {
  if ((result as { ok?: unknown } | null)?.ok !== true) {
    throw new Error(
      `Unexpected response from the server: the collection was not confirmed ${action}. Check the collection ${
        action === "deleted" ? "list " : ""
      }before retrying.`,
    );
  }
}

export async function collectionRequest(
  baseUrl: string,
  token: string,
  method: string,
  id: string | null,
  body?: Record<string, unknown>,
  query = "",
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/cli/collections${id ? `/${encodeURIComponent(id)}` : ""}${query}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // A non-JSON body is NOT the same as an empty object. A captive portal, a
  // misconfigured proxy, or a CDN error page answers with HTTP 200 and HTML;
  // collapsing that to {} made `delete` report success and `list` print
  // nothing, so the caller could not tell a real result from a proxy page.
  const data = parseCollectionResponse(await res.text().catch(() => null));
  if (!data) {
    // Report the transport failure as itself. Deriving it from res.ok would
    // call a 200 with an unreadable body a success.
    throw new Error(
      res.ok
        ? `unexpected_response_${res.status} (expected JSON)`
        : `request_failed_${res.status}`,
    );
  }
  if (!res.ok) {
    if (res.status === 429 || data.error === "rate_limited") {
      throw new Error("rate limited; retry later (rate_limited)");
    }
    const code = data.error;
    if (code && ERROR_MESSAGES[code]) {
      throw new Error(`${ERROR_MESSAGES[code]} (${code})`);
    }
    throw new Error(code ?? `request_failed_${res.status}`);
  }
  return data;
}

export type ApprovedPetCount =
  | { ok: true; count: number }
  | { ok: false; reason: "invalid_approved_pets" | "empty_approved_pets" };

/**
 * Validate the approved-pet count the `--all-approved` preflight fetched.
 *
 * Split out of the entrypoint so it can be tested without the keychain-backed
 * auth the entrypoint needs. Returning the narrowed count rather than a verdict
 * keeps the entrypoint from re-checking the type to satisfy the compiler, which
 * would be a second copy of the same rule.
 */
export function readApprovedPetCount(value: unknown): ApprovedPetCount {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { ok: false, reason: "invalid_approved_pets" };
  }
  // --all-approved resolves server-side to the approved set, so an account with
  // none sends an empty member list — which the server reads as "replace the
  // members with nothing". On an edit that silently empties the collection and
  // still reports success. parseCollectionArgs refuses the same hazard for an
  // explicit `--pets ""`; refuse it here too, or the guard is bypassable by
  // spelling the empty list differently.
  if (value === 0) {
    return { ok: false, reason: "empty_approved_pets" };
  }
  return { ok: true, count: value };
}
