export function hasClerkSessionCookie(cookieHeader: string | null): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => {
    const name = part.trim().split("=", 1)[0];
    return name === "__session" || name.startsWith("__session_");
  });
}
