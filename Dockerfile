# Production image for the Petdex web app.
#
# Four stages: `deps` installs from the lockfile, `source` is that tree plus
# the code (what the compose `migrate` service needs), `builder` compiles the
# Next app on top of it, and `runner` carries only what the server reads at
# runtime. The runtime needs a fraction of the install, so copying the whole
# tree into the final image (~928M of `node_modules` here) is the thing to
# avoid.
#
# Bun is the base throughout: the app's server code is plain Node API, but
# `scripts/seed-dev.ts` needs `bun --conditions react-server` to resolve the
# React server entry points, so the image has to carry bun anyway.

# syntax=docker/dockerfile:1

FROM oven/bun@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS deps
WORKDIR /app
# The lockfile is the contract; `--frozen-lockfile` fails the build rather
# than silently resolving a different tree.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Source plus the installed tree, with nothing built. The compose `migrate`
# service targets this stage: `drizzle-kit push` and `scripts/seed-dev.ts` need
# the source and its dependencies, not the Next build output. Pointing it at
# `builder` instead would make BuildKit evaluate the whole builder stage twice
# — once per distinct set of build args — and run `next build` a second time
# for a container that never serves a page.
FROM oven/bun@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS source
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

FROM source AS builder
WORKDIR /app

# `NEXT_PUBLIC_*` values are inlined into the client bundle at build time, so
# they have to be present here — setting them only at runtime leaves the
# browser bundle with empty strings. The defaults are empty; the compose file
# supplies the shared Clerk dev instance through `build.args`. Override with
# `--build-arg` for anything else.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS=""
ARG NEXT_PUBLIC_PETDEX_ADMIN_URL=""
ARG NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED=""
ARG NEXT_PUBLIC_DISCORD_INVITE_URL=""
ARG NEXT_PUBLIC_WECHAT_COMMUNITY_ENABLED=""
# Swaps the Clerk packages for the in-process mocks (see `next.config.ts`).
# This is a build-time alias, not a runtime flag: `next.config.ts` reads it
# while the config loads, so it has to be set while the bundle is compiled. The
# compiled output then contains the mocks themselves — the value never reaches
# the artifact.
ARG PETDEX_MOCK_AUTH=""
# Opts the build into `output: "standalone"` (see `next.config.ts`). The
# setting is off by default so the Vercel build is unchanged; the image needs
# the traced `.next/standalone` tree that the runner stage copies.
ARG PETDEX_STANDALONE="1"

# `next build` imports every route module to collect page data, and two throw
# at module scope when the env is missing: `src/lib/db/client.ts:39` on
# DATABASE_URL, and the rate-limit secret IIFE at
# `src/app/api/telemetry/event/route.ts:109` in production. Both are builder
# stage only — the runner gets the real values from the compose
# `environment:` block, so no placeholder reaches the shipped image.
ARG DATABASE_URL="postgresql://petdex:petdex@127.0.0.1:5432/petdex"
ARG TELEMETRY_RATELIMIT_SECRET="build-time-placeholder-not-a-secret"
# `/[locale]/pets/[slug]` is `force-static` and its `generateStaticParams`
# queries the DB, so page-data collection is a real query — the build fails on
# `connect ECONNREFUSED`, not on a missing variable. A placeholder URL is not
# enough, and pointing at the compose Postgres would mean a build that only
# works after `docker compose up` has run. So the builder stage brings its own:
# a throwaway cluster, pushed to the schema, discarded with the stage. Fresh
# clone plus Docker is the whole requirement.
#
# Split in two because a process cannot outlive its RUN: the install and
# `initdb` depend only on the base image and cache on their own, while the
# start/push/build/stop cycle has to sit in one RUN with `bun run build`.
#
# `initdb -U petdex --auth=trust` makes that role the superuser and writes an
# all-`trust` `pg_hba.conf`, so the `petdex:petdex` password in the URL above is
# never checked — it is there only because the connection string needs the
# shape. The server listens on plain loopback, which nothing outside the build
# container can reach.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql; \
    rm -rf /var/lib/apt/lists/*; \
    PGBIN="$(dirname "$(find /usr/lib/postgresql -name initdb -type f | head -1)")"; \
    echo "$PGBIN" > /usr/local/share/pgbin; \
    mkdir -p /var/lib/pg /run/postgresql; \
    chown -R postgres:postgres /var/lib/pg /run/postgresql; \
    su postgres -c "$PGBIN/initdb -D /var/lib/pg/data -U petdex --auth=trust"

ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS=$NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS \
    NEXT_PUBLIC_PETDEX_ADMIN_URL=$NEXT_PUBLIC_PETDEX_ADMIN_URL \
    NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED=$NEXT_PUBLIC_PETDEX_PET_PREVIEWS_ENABLED \
    NEXT_PUBLIC_DISCORD_INVITE_URL=$NEXT_PUBLIC_DISCORD_INVITE_URL \
    NEXT_PUBLIC_WECHAT_COMMUNITY_ENABLED=$NEXT_PUBLIC_WECHAT_COMMUNITY_ENABLED \
    PETDEX_MOCK_AUTH=$PETDEX_MOCK_AUTH \
    PETDEX_STANDALONE=$PETDEX_STANDALONE \
    DATABASE_URL=$DATABASE_URL \
    TELEMETRY_RATELIMIT_SECRET=$TELEMETRY_RATELIMIT_SECRET \
    NEXT_TELEMETRY_DISABLED=1

# `scripts/write-build-version.ts` shells out to `git rev-parse` and falls
# back to a timestamp when git is missing, which is the case here — `.git` is
# excluded by `.dockerignore`, so the version reads `local-…`. Copying `.git`
# in would add the whole history to the context for one short hash.
#
# The throwaway Postgres from the layer above has to be started in the same RUN
# as the build: each RUN is its own container, so a server left running by an
# earlier one is not there. `-w` blocks until it accepts connections, so
# `createdb` and `drizzle-kit push` cannot race it.
#
# The seed matters as much as the schema. The home page and the locale roots
# are `force-static`, so this build prerenders them — against an empty database
# they bake in "0+ open-source pets" and an empty gallery, and the container
# serves that until the 24h `revalidate` expires. Seeding here with the same
# script the compose `migrate` service runs means the prerendered HTML
# describes the same rows the running app will read.
#
# The seeded rows are not `featured`, so `getStaticPetSlugs` returns nothing
# and no `/[locale]/pets/[slug]` page is prerendered — those render on demand
# (`dynamicParams` is true). The seed is what makes the gallery non-empty, not
# what makes pet pages static.
#
# (`--conditions react-server` is what `bun run seed:dev` uses; the script
# resolves the React server entry points.)
RUN set -eux; \
    PGBIN="$(cat /usr/local/share/pgbin)"; \
    su postgres -c "$PGBIN/pg_ctl -D /var/lib/pg/data -w \
      -o '-p 5432 -k /run/postgresql -c listen_addresses=127.0.0.1' \
      -l /var/lib/pg/log start"; \
    su postgres -c "$PGBIN/createdb -h 127.0.0.1 -p 5432 -U petdex petdex"; \
    bun x drizzle-kit push --force; \
    bun --conditions react-server scripts/seed-dev.ts; \
    bun run build; \
    su postgres -c "$PGBIN/pg_ctl -D /var/lib/pg/data -m immediate stop"

FROM oven/bun@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# `server.js` serves `public/` and `/_next/static` from its own directory, so
# both have to sit beside it. The standalone bundle does not include them.
#
# `--chown` on the COPY rather than a `chown -R` afterwards: rewriting the
# owner of an already-copied tree makes a second full copy of it in a new
# layer — 157MB here, on an image whose entire payload is ~165MB.
COPY --from=builder --chown=bun:bun /app/public ./public
COPY --from=builder --chown=bun:bun /app/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/.next/static ./.next/static

USER bun

EXPOSE 3000

# `server.js` is what `output: "standalone"` emits; it reads PORT and HOSTNAME
# from the environment above.
CMD ["bun", "server.js"]
