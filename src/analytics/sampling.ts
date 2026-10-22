import { createHash } from "node:crypto";

// A seeded permutation samples standings PAGE CLUSTERS without replacement.
// The seed and population bound are persisted for the whole GW, so resuming
// collection does not change the selected pages. Individual rows within a page
// are correlated; confidence intervals must respect that clustering.
export const samplePages = (
  first: number,
  last: number,
  target: number,
  seed: string,
): number[] => {
  if (
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    first < 1 ||
    last < first
  )
    return [];
  const pages = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
  for (let i = pages.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const value = pages[i]!;
    pages[i] = pages[j]!;
    pages[j] = value;
  }
  return pages.slice(
    0,
    Math.max(0, Math.min(pages.length, Math.floor(target))),
  );
};
