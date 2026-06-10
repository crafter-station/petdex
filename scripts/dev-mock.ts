console.error(
  [
    "[dev:mock] deprecated and disabled.",
    "",
    "Use one of these instead:",
    "  bun run dev:docker  # local Postgres, Redis, and shared Clerk dev app",
    "  bun dev             # maintainers with complete .env.local credentials",
  ].join("\n"),
);

process.exit(1);
