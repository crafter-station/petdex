export function applyPinChangeToPinnedSlugs(
  currentSlugs: string[],
  slug: string,
  nextPinned: boolean,
  maxPins: number,
): string[] {
  const normalizedSlug = slug.toLowerCase();
  const withoutSlug = currentSlugs.filter((item) => item !== normalizedSlug);
  if (!nextPinned) return withoutSlug;
  if (withoutSlug.length >= maxPins) return currentSlugs;
  return [...withoutSlug, normalizedSlug];
}

export function applyPinnedOrderChange(
  currentSlugs: string[],
  orderedSlugs: string[],
): string[] {
  const currentSet = new Set(currentSlugs);
  const orderedCurrentSlugs = orderedSlugs.filter((slug) =>
    currentSet.has(slug),
  );
  const orderedSet = new Set(orderedCurrentSlugs);
  const remainingSlugs = currentSlugs.filter((slug) => !orderedSet.has(slug));
  return [...orderedCurrentSlugs, ...remainingSlugs];
}

export function hasSamePinnedOrder(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((slug, i) => slug === right[i])
  );
}

export function refreshPinnedOrderItems<T extends { slug: string }>(
  currentOrder: T[],
  latestItems: T[],
): T[] {
  const latestBySlug = new Map(latestItems.map((item) => [item.slug, item]));
  const nextOrder = currentOrder
    .map((item) => latestBySlug.get(item.slug))
    .filter((item): item is T => Boolean(item));
  const nextSlugs = new Set(nextOrder.map((item) => item.slug));
  const appendedItems = latestItems.filter((item) => !nextSlugs.has(item.slug));
  return [...nextOrder, ...appendedItems];
}

export function shouldResetPinnedOrderFromProps({
  previousPropSlugs,
  nextPropSlugs,
  currentOrderSlugs,
}: {
  previousPropSlugs: string[];
  nextPropSlugs: string[];
  currentOrderSlugs: string[];
}): boolean {
  if (hasSamePinnedOrder(previousPropSlugs, nextPropSlugs)) return false;
  return !hasSamePinnedOrder(currentOrderSlugs, nextPropSlugs);
}
