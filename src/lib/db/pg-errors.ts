/**
 * Whether a thrown error is a Postgres unique-violation (SQLSTATE 23505).
 *
 * drizzle wraps driver failures in a `DrizzleQueryError` whose `cause` holds
 * the pg fields, while a bare driver error puts `code` on itself — so this
 * unwraps one level, the same shape the other `is*Error` guards in this repo
 * use. Callers convert the violation into the 4xx the route should have
 * answered, instead of letting the 23505 surface as a 500.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : error;
  if (!cause || typeof cause !== "object") return false;
  const code = "code" in cause ? (cause as { code?: unknown }).code : null;
  return code === "23505";
}
