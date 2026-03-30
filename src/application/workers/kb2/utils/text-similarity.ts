export function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[._@]/g, " ")
      .replace(/[^a-z0-9\s\-]/g, "")
      .split(/[\s\-]+/)
      .filter((t) => t.length > 1),
  );
}

export function tokenSimilarity(a: string, b: string): number {
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) {
    if (tokB.has(t)) overlap++;
  }
  return overlap / Math.max(tokA.size, tokB.size);
}
