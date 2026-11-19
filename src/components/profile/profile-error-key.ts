// Maps the internal error codes `PATCH /api/profile` puts on the wire to the
// keys under the `profileEditor.errors` message namespace.
//
// The route answers with a code (`handle_taken`, `pin_cap_reached`), never a
// sentence, so a panel that renders the code directly — or through
// `error.replace(/_/g, " ")`, which yields "HANDLE TAKEN" — shows a
// non-sentence in every language. Both profile editors (the inline one on
// /u/[handle] and the dashboard card on /my-pets) hit the same route with the
// same body, so the mapping lives here rather than once per panel.
//
// `validateProfileHandle` sends `handle_${validation}` for too_short, too_long,
// invalid_format and reserved, so both the composed and the raw spellings map.
// An unrecognised code returns null; the caller renders `errors.failed` with
// the code rather than dropping the message.
export function profileErrorKey(error: string | null): string | null {
  if (!error) return null;
  switch (error) {
    case "unauthorized":
      return "unauthorized";
    case "rate_limited":
      return "rateLimited";
    case "invalid_display_name":
      return "invalidDisplayName";
    case "invalid_handle":
    case "handle_invalid_format":
      return "invalidHandle";
    case "handle_too_short":
      return "handleTooShort";
    case "handle_too_long":
      return "handleTooLong";
    case "handle_reserved":
      return "handleReserved";
    case "handle_taken":
      return "handleTaken";
    case "invalid_bio":
      return "invalidBio";
    case "invalid_featured":
      return "invalidFeatured";
    case "pin_cap_reached":
      return "pinCapReached";
    case "pet_not_owned_or_not_approved":
      return "petNotOwned";
    case "nothing_to_update":
      return "nothingToUpdate";
    default:
      return null;
  }
}
