// Single source of truth for "are we in mock mode?". Every shim file imports
// IS_MOCK from here so the rest of the app doesn't need to know which env
// var triggers it. Set PETDEX_MOCK=1 only for targeted mock-backed checks.

export const IS_MOCK = process.env.PETDEX_MOCK === "1";

export const MOCK_USER = {
  userId: "user_mock_contributor",
  email: "contributor@petdex.local",
  username: "contributor",
  firstName: "Test",
  lastName: "Contributor",
  imageUrl: null as string | null,
};
