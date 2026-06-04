type MessageNode = Record<string, unknown>;

export const CLIENT_MESSAGE_PATHS = [
  "admin.editActions",
  "admin.feedback.filters",
  "admin.feedbackActions",
  "admin.kinds",
  "admin.requestActions",
  "admin.status",
  "admin.tabs",
  "adminReview",
  "advertise.card",
  "advertise.dashboard.edit",
  "advertise.form",
  "buildUpdate",
  "claim",
  "collaborator.tabs",
  "collaboratorWechatQr",
  "collectionActionMenu",
  "collectionEditor",
  "collectionsBrowser",
  "commandLine",
  "common",
  "desktopAnnouncement",
  "feedback",
  "footer",
  "gallery",
  "galleryReorder",
  "githubStar",
  "header",
  "home.surprise",
  "installCommand",
  "installCompact",
  "leaderboard",
  "myFeedback.filters",
  "myPets",
  "myPets.edit",
  "onboarding",
  "openInPetdex",
  "ownerCollections",
  "petActions",
  "petStateViewer",
  "pinnedReorder",
  "profile",
  "profileAnnouncement",
  "profileShare",
  "requests.view",
  "sticker",
  "submit.form",
  "submit.form.copy",
  "submit.form.preview",
  "submit.form.submitButton",
  "submit.form.success",
  "submittedBy",
  "suggestCollection",
  "theme",
  "unsubscribePage.form",
] as const;

export function pickClientMessages<T extends MessageNode>(
  messages: T,
): Partial<T> {
  const picked: MessageNode = {};

  for (const path of CLIENT_MESSAGE_PATHS) {
    copyPath(messages as MessageNode, picked, path.split("."));
  }

  return picked as Partial<T>;
}

function copyPath(source: MessageNode, target: MessageNode, parts: string[]) {
  let sourceCursor: unknown = source;
  let targetCursor = target;

  for (const [index, part] of parts.entries()) {
    if (!isMessageNode(sourceCursor) || !(part in sourceCursor)) return;
    const sourceValue = sourceCursor[part];

    if (index === parts.length - 1) {
      targetCursor[part] = sourceValue;
      return;
    }

    const targetValue = targetCursor[part];
    if (!isMessageNode(targetValue)) {
      targetCursor[part] = {};
    }

    targetCursor = targetCursor[part] as MessageNode;
    sourceCursor = sourceValue;
  }
}

function isMessageNode(value: unknown): value is MessageNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
