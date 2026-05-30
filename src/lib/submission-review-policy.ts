export type ReviewPolicyCategory = {
  id: string;
  label: string;
  description: string;
  holdAboveConfidence: number;
};

export const REVIEW_POLICY_CATEGORIES = [
  {
    id: "sexual_content",
    label: "Sexual content",
    description:
      "Nudity, explicit sexual content, sexualized imagery, or fetish content.",
    holdAboveConfidence: 0.35,
  },
  {
    id: "sexual_minors",
    label: "Sexual content involving minors",
    description:
      "Any sexualized depiction or language involving minors or childlike characters.",
    holdAboveConfidence: 0.2,
  },
  {
    id: "hate_harassment",
    label: "Hate or harassment",
    description:
      "Slurs, hateful symbols, dehumanization, targeted abuse, or harassment.",
    holdAboveConfidence: 0.35,
  },
  {
    id: "graphic_violence_gore",
    label: "Graphic violence or gore",
    description: "Graphic injury, gore, torture, mutilation, or shock imagery.",
    holdAboveConfidence: 0.35,
  },
  {
    id: "self_harm",
    label: "Self-harm",
    description:
      "Self-harm encouragement, suicide references, or self-injury imagery.",
    holdAboveConfidence: 0.35,
  },
  {
    id: "illegal_activity_drugs",
    label: "Illegal activity or drugs",
    description:
      "Drug dealing, instructions for wrongdoing, weapons misuse, or illegal activity.",
    holdAboveConfidence: 0.45,
  },
  {
    id: "personal_data",
    label: "Personal data",
    description:
      "Private addresses, phone numbers, credentials, or doxxing content.",
    holdAboveConfidence: 0.35,
  },
  {
    id: "spam_scam",
    label: "Spam or scam",
    description:
      "Promotional spam, scams, phishing, impersonation, or deceptive links.",
    holdAboveConfidence: 0.45,
  },
  {
    id: "malware_script_abuse",
    label: "Malware or script abuse",
    description:
      "Payloads, command injection attempts, suspicious scripts, or install abuse.",
    holdAboveConfidence: 0.3,
  },
  {
    id: "adult_language",
    label: "Adult language",
    description:
      "Explicit profanity, adult themes, or language that may not fit a public gallery.",
    holdAboveConfidence: 0.55,
  },
  {
    id: "copyright_trademark_risk",
    label: "Copyright or trademark risk",
    description:
      "Obvious branded, celebrity, or franchise character references that need human review.",
    holdAboveConfidence: 0.6,
  },
  {
    id: "portrait_likeness_rights",
    label: "Portrait or likeness rights",
    description:
      "Recognizable real-person likenesses, celebrity portraits, influencers, actors, athletes, or identity features that may imply unauthorized portrait/publicity rights use.",
    holdAboveConfidence: 0.45,
  },
  {
    id: "political_public_figure",
    label: "Political or contemporary public figure",
    description:
      "Parodies, caricatures, or recognizable depictions of current heads of state, sitting politicians, candidates for office, royalty, or contemporary news personalities. Historical figures (centuries-old religious, philosophical, or historical leaders) do not qualify.",
    holdAboveConfidence: 0.4,
  },
  {
    id: "historical_religious_figure",
    label: "Historical or religious figure",
    description:
      "Recognizable depictions, names, slogans, symbols, or titles tied to historical, philosophical, religious, or culturally revered figures that may need sensitivity review.",
    holdAboveConfidence: 0.45,
  },
  {
    id: "embedded_text_sensitive_symbol",
    label: "Embedded text or sensitive symbol",
    description:
      "Visible text, slogans, logos, uniforms, flags, gestures, symbols, or signs embedded in the image that may create legal, cultural, religious, political, or reputational risk.",
    holdAboveConfidence: 0.4,
  },
] as const satisfies ReviewPolicyCategory[];

export const REVIEW_POLICY_CATEGORY_IDS = new Set(
  REVIEW_POLICY_CATEGORIES.map((category) => category.id),
);

export type BuildPolicyPromptOptions = {
  imageReview?: boolean;
};

export function buildPolicyPrompt(
  options: BuildPolicyPromptOptions = {},
): string {
  const imageReview = options.imageReview ?? true;
  const categories = REVIEW_POLICY_CATEGORIES.map(
    (category) =>
      `- ${category.id}: ${category.label}. ${category.description}`,
  ).join("\n");

  const instructions = [
    "You moderate user-submitted animated pixel pets for a public gallery.",
    "Return strict JSON only. Do not include markdown or prose outside JSON.",
    imageReview
      ? "Flag only content visible to the public or present in the pet pack metadata."
      : "Flag only content present in the submitted text diff or metadata.",
    ...(imageReview
      ? [
          "The image may be a contact sheet of sampled animation frames. Inspect every cell.",
          "Perform OCR on visible text in the image, including tiny labels, slogans, symbols, uniforms, logos, and signs. Transcribe visible text when possible.",
          "Pixel art can be ambiguous. If unsure, mark hold with a concise evidence string.",
        ]
      : [
          "No image is attached. Do not infer visual risk unless the text itself names or describes the risky element.",
          "If unsure from text alone, mark hold with a concise evidence string.",
        ]),
    "Policy categories:",
    categories,
    "Output schema:",
    '{"decision":"pass"|"hold","confidence":0..1,"summary":"short explanation","visualText":["OCR text or empty"],"visualSignals":["short visual signal or empty"],"flags":[{"category":"category_id","severity":"low"|"medium"|"high","confidence":0..1,"evidence":"short evidence"}]}',
  ];
  return instructions.join("\n");
}
