// Static pet data. This repo is a homepage-only slice of Petdex with no
// database — every pet shown anywhere in the app is hardcoded here.
//
// The sprite is a generated placeholder SVG (a colored face + name tag),
// not real artwork. The generator is deterministic (same slug -> same
// accent color), copied as-is from the old mock DB seeder so the visuals
// are unchanged.

export type StaticPet = {
  slug: string;
  displayName: string;
  description: string;
  approvedAt: string;
};

// Same 12 pets the mock DB used to seed, in the same order. Order matters
// for FEATURED_PET_SLUGS below and for the random-pet pool.
export const STATIC_PETS: StaticPet[] = [
  {
    slug: "nukey",
    displayName: "Nukey",
    description: "A tiny friendly microwave companion for snack-fueled builds.",
    approvedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    slug: "boba",
    displayName: "Boba",
    description:
      "A tiny otter sipping bubble tea while keeping you company in Codex.",
    approvedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    slug: "boxcat",
    displayName: "Crafternauta",
    description: "A tiny cat tucked inside a cardboard box for cozy coding sessions.",
    approvedAt: "2026-01-03T00:00:00.000Z",
  },
  {
    slug: "captain-quack",
    displayName: "Kebo",
    description: "A tiny pirate duck companion with a jaunty hat.",
    approvedAt: "2026-01-04T00:00:00.000Z",
  },
  {
    slug: "corsair-cat",
    displayName: "Noir Webling",
    description:
      "A compact chibi cat wearing a pirate hat, ready as a Codex digital pet.",
    approvedAt: "2026-01-05T00:00:00.000Z",
  },
  {
    slug: "ice-cream-cat",
    displayName: "Scoop",
    description: "A cheerful cat carrying an ice cream cone.",
    approvedAt: "2026-01-06T00:00:00.000Z",
  },
  {
    slug: "pelican-pedal",
    displayName: "Pelican Pedal",
    description:
      "A compact Codex digital pet pelican happily riding a tiny bicycle.",
    approvedAt: "2026-01-07T00:00:00.000Z",
  },
  {
    slug: "punchy",
    displayName: "Punchy",
    description: "A scrappy little dog boxer with oversized red gloves.",
    approvedAt: "2026-01-08T00:00:00.000Z",
  },
  {
    slug: "scoop",
    displayName: "Scoop",
    description: "A tiny ice cream cone digital pet with a cheerful face.",
    approvedAt: "2026-01-09T00:00:00.000Z",
  },
  {
    slug: "skipper",
    displayName: "Skipper",
    description: "A tiny sailor cat for breezy workspace days.",
    approvedAt: "2026-01-10T00:00:00.000Z",
  },
  {
    slug: "byte-bunny",
    displayName: "Byte Bunny",
    description:
      "A tiny rabbit holding a little keyboard key like a lucky charm.",
    approvedAt: "2026-01-11T00:00:00.000Z",
  },
  {
    slug: "bugsy",
    displayName: "Bugsy",
    description:
      "A tiny harmless bug with goggles, ready to help inspect tricky diffs.",
    approvedAt: "2026-01-12T00:00:00.000Z",
  },
];

export const STATIC_PETS_BY_SLUG = new Map(
  STATIC_PETS.map((pet) => [pet.slug, pet]),
);

// Exact order the hero currently renders in.
export const FEATURED_PET_SLUGS = [
  "ice-cream-cat",
  "corsair-cat",
  "captain-quack",
  "boxcat",
  "boba",
  "nukey",
];

export const TOTAL_PET_COUNT = STATIC_PETS.length;

function colorFromSlug(slug: string): string {
  let hash = 0;
  for (const char of slug) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 78% 62%)`;
}

export function staticSpriteDataUri(slug: string): string {
  const accent = colorFromSlug(slug);
  const frames = Array.from({ length: 9 }, (_, row) =>
    Array.from({ length: 8 }, (_, col) => {
      const x = col * 192;
      const y = row * 208;
      const bob = col % 2 === 0 ? 0 : -5;
      return `<g transform="translate(${x} ${y})">
        <ellipse cx="96" cy="${157 - bob}" rx="54" ry="12" fill="#d9e2f0"/>
        <circle cx="96" cy="${92 + bob}" r="42" fill="${accent}"/>
        <circle cx="80" cy="${82 + bob}" r="5" fill="#111827"/>
        <circle cx="112" cy="${82 + bob}" r="5" fill="#111827"/>
        <path d="M82 ${104 + bob} Q96 ${118 + bob} 110 ${104 + bob}" fill="none" stroke="#111827" stroke-width="6" stroke-linecap="round"/>
      </g>`;
    }).join(""),
  ).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1872" viewBox="0 0 1536 1872">${frames}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")}`;
}
