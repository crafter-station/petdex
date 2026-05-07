import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type {
  ReviewChecks,
  SubmissionReviewDecision,
  SubmissionReviewStatus,
} from "@/lib/submission-review-types";

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
]);

export const petKind = pgEnum("pet_kind", ["creature", "object", "character"]);

// How this pet entered the catalog. 'submit' = uploaded through the
// regular /submit flow. 'discover' = added by an admin on behalf of
// an external author who hasn't claimed yet. 'claimed' = was
// 'discover' and the original author has since signed in and claimed
// ownership through /my-pets, so it now behaves like a normal submission.
export const petSource = pgEnum("pet_source", [
  "submit",
  "discover",
  "claimed",
]);

export const adCampaignStatus = pgEnum("ad_campaign_status", [
  "pending_payment",
  "active",
  "exhausted",
  "paused",
  "deleted",
]);

export const adEventKind = pgEnum("ad_event_kind", [
  "hover",
  "click",
  "dismissed",
  "time_in_view",
]);

export const submittedPets = pgTable(
  "submitted_pets",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description").notNull(),
    spritesheetUrl: text("spritesheet_url").notNull(),
    petJsonUrl: text("pet_json_url").notNull(),
    zipUrl: text("zip_url").notNull(),
    kind: petKind("kind").notNull().default("creature"),
    vibes: jsonb("vibes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    tags: jsonb("tags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    dominantColor: text("dominant_color"),
    colorFamily: text("color_family"),
    soundUrl: text("sound_url"),
    featured: boolean("featured").notNull().default(false),
    // 64-bit dHash of the first idle frame as a 16-char hex string. Used
    // for fast perceptual-similarity dedup at admin review time.
    dhash: text("dhash"),
    // Gemini embedding + embedding_model live in raw pgvector columns.
    // Drizzle has no first-class pgvector type yet, so they are kept out
    // of this model and cast at query boundaries.
    status: approvalStatus("status").notNull().default("pending"),
    source: petSource("source").notNull().default("submit"),
    ownerId: text("owner_id").notNull(),
    ownerEmail: text("owner_email"),
    creditName: text("credit_name"),
    creditUrl: text("credit_url"),
    creditImage: text("credit_image"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    // Owner-submitted text edits awaiting admin re-approval. Sprites/zip
    // are not editable here — those changes require a fresh /submit so
    // the dedup + virus-scan + dhash pipeline runs again. When all three
    // pendingX fields are null the pet has no edit in flight.
    pendingDisplayName: text("pending_display_name"),
    pendingDescription: text("pending_description"),
    pendingTags: jsonb("pending_tags").$type<string[] | null>(),
    pendingSubmittedAt: timestamp("pending_submitted_at", {
      withTimezone: true,
    }),
    pendingRejectionReason: text("pending_rejection_reason"),
  },
  (table) => ({
    statusIdx: index("submitted_pets_status_idx").on(table.status),
    ownerIdx: index("submitted_pets_owner_idx").on(table.ownerId),
    slugUnique: uniqueIndex("submitted_pets_slug_unique").on(table.slug),
    reviewDhashIdx: index("submitted_pets_review_dhash_idx")
      .on(table.status, table.createdAt.desc())
      .where(
        sql`${table.dhash} IS NOT NULL AND ${table.status} IN ('approved', 'pending')`,
      ),
    statusCreatedAtIdx: index("submitted_pets_status_created_at_idx").on(
      table.status,
      table.createdAt.desc(),
    ),
    statusFeaturedNameIdx: index("submitted_pets_status_featured_name_idx").on(
      table.status,
      table.featured,
      table.displayName,
    ),
    statusKindIdx: index("submitted_pets_status_kind_idx").on(
      table.status,
      table.kind,
    ),
    pendingEditIdx: index("submitted_pets_pending_edit_idx").on(
      table.pendingSubmittedAt,
    ),
    vibesGinIdx: index("submitted_pets_vibes_gin_idx").using(
      "gin",
      table.vibes,
    ),
    tagsGinIdx: index("submitted_pets_tags_gin_idx").using("gin", table.tags),
  }),
);

export const submissionReviews = pgTable(
  "submission_reviews",
  {
    id: text("id").primaryKey(),
    submittedPetId: text("submitted_pet_id").notNull(),
    status: text("status").$type<SubmissionReviewStatus>().notNull(),
    decision: text("decision").$type<SubmissionReviewDecision>().notNull(),
    reasonCode: text("reason_code"),
    summary: text("summary"),
    // Integer percent, 0..100. Keeps the schema simple while the app uses
    // normalized 0..1 confidence internally.
    confidence: integer("confidence"),
    checks: jsonb("checks").$type<ReviewChecks>().notNull(),
    model: text("model"),
    dryRun: boolean("dry_run").notNull().default(false),
    error: text("error"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    submittedPetIdx: index("submission_reviews_pet_idx").on(
      table.submittedPetId,
    ),
    statusIdx: index("submission_reviews_status_idx").on(table.status),
    decisionIdx: index("submission_reviews_decision_idx").on(table.decision),
    createdAtIdx: index("submission_reviews_created_at_idx").on(
      table.createdAt,
    ),
    petCreatedAtIdx: index("submission_reviews_pet_created_at_idx").on(
      table.submittedPetId,
      table.createdAt.desc(),
    ),
  }),
);

export const petLikes = pgTable(
  "pet_likes",
  {
    userId: text("user_id").notNull(),
    petSlug: text("pet_slug").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.petSlug] }),
    slugIdx: index("pet_likes_slug_idx").on(table.petSlug),
  }),
);

export const petMetrics = pgTable("pet_metrics", {
  petSlug: text("pet_slug").primaryKey(),
  installCount: integer("install_count").notNull().default(0),
  zipDownloadCount: integer("zip_download_count").notNull().default(0),
  likeCount: integer("like_count").notNull().default(0),
  lastInstalledAt: timestamp("last_installed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    companyName: text("company_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    imageUrl: text("image_url").notNull(),
    destinationUrl: text("destination_url").notNull(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    packageViews: integer("package_views").notNull(),
    priceCents: integer("price_cents").notNull(),
    viewsServed: integer("views_served").notNull().default(0),
    status: adCampaignStatus("status").notNull().default("pending_payment"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    acceptedTermsAt: timestamp("accepted_terms_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    removalReason: text("removal_reason"),
  },
  (table) => ({
    userIdx: index("ad_campaigns_user_idx").on(table.userId),
    activeIdx: index("ad_campaigns_active_idx").on(
      table.status,
      table.viewsServed,
      table.createdAt,
    ),
    stripeSessionUnique: uniqueIndex("ad_campaigns_stripe_session_unique").on(
      table.stripeCheckoutSessionId,
    ),
  }),
);

export const adImpressions = pgTable(
  "ad_impressions",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    anonymousId: text("anonymous_id"),
    sessionId: text("session_id").notNull(),
    requestId: text("request_id").notNull(),
    visibleMs: integer("visible_ms").notNull(),
    path: text("path").notNull(),
    locale: text("locale").notNull(),
    userAgentHash: text("user_agent_hash"),
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    campaignIdx: index("ad_impressions_campaign_idx").on(
      table.campaignId,
      table.createdAt,
    ),
    dedupeUnique: uniqueIndex("ad_impressions_dedupe_unique").on(
      table.campaignId,
      table.sessionId,
      table.requestId,
    ),
  }),
);

export const adEvents = pgTable(
  "ad_events",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id")
      .notNull()
      .references(() => adCampaigns.id, { onDelete: "cascade" }),
    kind: adEventKind("kind").notNull(),
    userId: text("user_id"),
    anonymousId: text("anonymous_id"),
    sessionId: text("session_id").notNull(),
    requestId: text("request_id").notNull(),
    durationMs: integer("duration_ms"),
    path: text("path").notNull(),
    locale: text("locale").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    campaignKindIdx: index("ad_events_campaign_kind_idx").on(
      table.campaignId,
      table.kind,
      table.createdAt,
    ),
    dedupeUnique: uniqueIndex("ad_events_dedupe_unique").on(
      table.campaignId,
      table.kind,
      table.sessionId,
      table.requestId,
    ),
  }),
);

export const feedbackKind = pgEnum("feedback_kind", [
  "suggestion",
  "bug",
  "praise",
  "other",
]);

export const feedbackStatus = pgEnum("feedback_status", [
  "pending",
  "addressed",
  "archived",
]);

export const feedback = pgTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    kind: feedbackKind("kind").notNull().default("suggestion"),
    status: feedbackStatus("status").notNull().default("pending"),
    message: text("message").notNull(),
    email: text("email"),
    pageUrl: text("page_url"),
    userAgent: text("user_agent"),
    userId: text("user_id"),
    addressedAt: timestamp("addressed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    adminNote: text("admin_note"),
    // True = user opted in to email notifications when admin replies.
    // Defaults to true; user can mute from /my-feedback later.
    notifyEmail: boolean("notify_email").notNull().default(true),
    // Last time the original author saw the thread (used for unread counts).
    userLastReadAt: timestamp("user_last_read_at", { withTimezone: true }),
    // Last time admin saw the thread (so user follow-ups bell on admin side).
    adminLastReadAt: timestamp("admin_last_read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    createdAtIdx: index("feedback_created_at_idx").on(table.createdAt),
    userIdx: index("feedback_user_idx").on(table.userId),
    statusIdx: index("feedback_status_idx").on(table.status),
  }),
);

export const notificationKind = pgEnum("notification_kind", [
  "pet_approved",
  "pet_rejected",
  "edit_approved",
  "edit_rejected",
  "feedback_replied",
  "request_fulfilled",
]);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    // Recipient — Clerk user id of whoever should see this notification
    // in their bell. Always required; we don't surface system-wide
    // notifications today.
    userId: text("user_id").notNull(),
    kind: notificationKind("kind").notNull(),
    // Free-form payload: depends on kind. Examples:
    //   pet_approved  -> { petSlug, petName }
    //   pet_rejected  -> { petSlug, petName, reason? }
    //   edit_approved -> { petSlug, petName }
    //   edit_rejected -> { petSlug, petName, reason? }
    //   feedback_replied -> { feedbackId, excerpt }
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // Click destination. Pre-computed at write time so the bell doesn't
    // need to know the kind->URL mapping.
    href: text("href").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("notifications_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    userUnreadIdx: index("notifications_user_unread_idx").on(
      table.userId,
      table.readAt,
    ),
  }),
);

// Lightweight log of each /api/manifest fetch so we can spot
// abnormal fetch volume in the admin view. We hash the IP because
// raw IPs aren't useful for analytics and shouldn't sit around in
// plaintext.
export const manifestFetches = pgTable(
  "manifest_fetches",
  {
    id: text("id").primaryKey(),
    // sha256(ip + daily-salt) → stable per-day per-IP, can't reverse.
    ipHash: text("ip_hash").notNull(),
    userAgent: text("user_agent"),
    country: text("country"),
    region: text("region"),
    referer: text("referer"),
    // Which manifest variant — 'slim' (public) or 'full' (authed).
    variant: text("variant").notNull().default("slim"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    fetchedAtIdx: index("manifest_fetches_fetched_at_idx").on(table.fetchedAt),
    ipHashIdx: index("manifest_fetches_ip_hash_idx").on(table.ipHash),
  }),
);

export const userProfiles = pgTable(
  "user_profiles",
  {
    // Clerk user id (string). PK because every user has at most one profile.
    userId: text("user_id").primaryKey(),
    displayName: text("display_name"),
    handle: text("handle"),
    bio: text("bio"),
    preferredLocale: text("preferred_locale")
      .$type<"en" | "es" | "zh">()
      .notNull()
      .default("en"),
    // Up to 6 approved pets the user has pinned to the top of their public
    // gallery, in the order they were added. Validated server-side: every
    // slug must belong to the same userId and currently be approved.
    // Kept as jsonb to mirror the rest of the array columns in this schema
    // (vibes, tags, pendingTags) and keep migrations boring.
    featuredPetSlugs: jsonb("featured_pet_slugs")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    handleUnique: uniqueIndex("user_profiles_handle_unique").on(table.handle),
  }),
);

export const petCollections = pgTable(
  "pet_collections",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    ownerId: text("owner_id"),
    externalUrl: text("external_url"),
    coverPetSlug: text("cover_pet_slug"),
    featured: boolean("featured").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex("pet_collections_slug_unique").on(table.slug),
    featuredIdx: index("pet_collections_featured_idx").on(table.featured),
    ownerIdx: index("pet_collections_owner_idx").on(table.ownerId),
  }),
);

export const petCollectionItems = pgTable(
  "pet_collection_items",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => petCollections.id, { onDelete: "cascade" }),
    petSlug: text("pet_slug").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.collectionId, table.petSlug] }),
    slugIdx: index("pet_collection_items_slug_idx").on(table.petSlug),
    positionIdx: index("pet_collection_items_position_idx").on(
      table.collectionId,
      table.position,
    ),
  }),
);

// Owner-submitted "please add my pet to this collection" requests.
// Stays separate from petCollectionItems so we can keep an audit trail
// (who asked, when, who decided) and so an approval cycle can't race
// with the manual seed script.
export const petCollectionRequests = pgTable(
  "pet_collection_requests",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => petCollections.id, { onDelete: "cascade" }),
    petSlug: text("pet_slug").notNull(),
    // The owner who submitted the request — verified at write time and
    // re-checked at admin approval time so an ownership change between
    // submit and approve doesn't smuggle somebody else's pet in.
    requestedBy: text("requested_by").notNull(),
    note: text("note"),
    status: approvalStatus("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    statusIdx: index("pet_collection_requests_status_idx").on(table.status),
    requesterIdx: index("pet_collection_requests_requester_idx").on(
      table.requestedBy,
    ),
    // Prevents the same owner from spamming the same pet/collection pair
    // before admins decide. They can resubmit once a decision is made
    // (the status flips, freeing the unique).
    pendingPair: uniqueIndex("pet_collection_requests_pending_pair").on(
      table.collectionId,
      table.petSlug,
      table.status,
    ),
  }),
);

export const feedbackAuthorKind = pgEnum("feedback_author_kind", [
  "admin",
  "user",
]);

export const feedbackReplies = pgTable(
  "feedback_replies",
  {
    id: text("id").primaryKey(),
    feedbackId: text("feedback_id")
      .notNull()
      .references(() => feedback.id, { onDelete: "cascade" }),
    authorKind: feedbackAuthorKind("author_kind").notNull(),
    authorUserId: text("author_user_id"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    feedbackIdx: index("feedback_replies_feedback_idx").on(table.feedbackId),
    createdAtIdx: index("feedback_replies_created_at_idx").on(table.createdAt),
  }),
);

export const petRequests = pgTable(
  "pet_requests",
  {
    id: text("id").primaryKey(),
    // What the user typed verbatim (preserved for display).
    query: text("query").notNull(),
    // Lowercased + collapsed-whitespace key for dedup look-ups.
    normalized: text("normalized").notNull(),
    // Gemini embedding + embedding_model live in pgvector columns added via raw SQL.
    requestedBy: text("requested_by"),
    upvoteCount: integer("upvote_count").notNull().default(1),
    // open / fulfilled / dismissed
    status: text("status").notNull().default("open"),
    fulfilledPetSlug: text("fulfilled_pet_slug"),
    imageUrl: text("image_url"),
    // none / pending / approved / rejected
    imageReviewStatus: text("image_review_status").notNull().default("none"),
    imageRejectionReason: text("image_rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    normalizedIdx: index("pet_requests_normalized_idx").on(table.normalized),
    upvoteIdx: index("pet_requests_upvote_idx").on(table.upvoteCount),
    statusIdx: index("pet_requests_status_idx").on(table.status),
    imageReviewIdx: index("pet_requests_image_review_idx").on(
      table.imageReviewStatus,
    ),
  }),
);

export const petRequestVotes = pgTable(
  "pet_request_votes",
  {
    requestId: text("request_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.requestId, table.userId] }),
  }),
);

// Candidates linking a submitted pet to a pet request. Two sources:
// - "auto"   created by the background match job after a pet hits
//            status='approved'; similarity holds the cosine score
// - "manual" created when the pet's owner clicks "I have a pet for
//            this" on /requests; similarity is null
// Admin resolves to either approved (request becomes fulfilled) or
// rejected. A single (petId, requestId) pair can only appear once.
export const petRequestCandidates = pgTable(
  "pet_request_candidates",
  {
    petId: text("pet_id").notNull(),
    requestId: text("request_id").notNull(),
    similarity: real("similarity"),
    source: text("source").notNull(),
    status: text("status").notNull().default("pending"),
    rejectionReason: text("rejection_reason"),
    suggestedAt: timestamp("suggested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.petId, table.requestId] }),
    requestStatusIdx: index("pet_request_candidates_request_status_idx").on(
      table.requestId,
      table.status,
    ),
    statusSuggestedIdx: index("pet_request_candidates_status_suggested_idx").on(
      table.status,
      table.suggestedAt.desc(),
    ),
    petIdx: index("pet_request_candidates_pet_idx").on(table.petId),
  }),
);

export type PetRequestCandidate = typeof petRequestCandidates.$inferSelect;
export type NewPetRequestCandidate = typeof petRequestCandidates.$inferInsert;

export type SubmittedPet = typeof submittedPets.$inferSelect;
export type NewSubmittedPet = typeof submittedPets.$inferInsert;
export type SubmissionReview = typeof submissionReviews.$inferSelect;
export type NewSubmissionReview = typeof submissionReviews.$inferInsert;
export type PetLike = typeof petLikes.$inferSelect;
export type PetMetric = typeof petMetrics.$inferSelect;
export type AdCampaign = typeof adCampaigns.$inferSelect;
export type NewAdCampaign = typeof adCampaigns.$inferInsert;
export type AdImpression = typeof adImpressions.$inferSelect;
export type AdEvent = typeof adEvents.$inferSelect;
export type Feedback = typeof feedback.$inferSelect;
export type PetRequest = typeof petRequests.$inferSelect;
