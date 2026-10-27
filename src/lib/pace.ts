/**
 * At most `limit` requests started in any `windowMs`. The API limits route checks and quotes per
 * visitor (60 a minute each); a wallet on many chains asked faster than that, and each refusal read
 * as "unknown", which asked again (2026-10-27: 35 of 95 route checks refused for one address).
 */
export function pacer(limit: number, windowMs: number): () => Promise<void> {
  const starts: number[] = [];
  return async function slot() {
    for (;;) {
      const now = Date.now();
      while (starts.length > 0 && now - starts[0]! >= windowMs) starts.shift();
      if (starts.length < limit) {
        starts.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, starts[0]! + windowMs - now));
    }
  };
}

/**
 * One request per key at a time, its answer reused for `keepMs` when `keep` accepts it (an
 * "unknown" is asked again). A failed request is never reused.
 */
export function reuse<T>(keepMs: number, keep: (answer: T) => boolean = () => true): (key: string, ask: () => Promise<T>) => Promise<T> {
  const answers = new Map<string, { answer: Promise<T>; until?: number }>();
  return (key, ask) => {
    const known = answers.get(key);
    if (known && (known.until === undefined || Date.now() < known.until)) return known.answer;
    const entry: { answer: Promise<T>; until?: number } = { answer: ask() };
    answers.set(key, entry);
    const drop = () => { if (answers.get(key) === entry) answers.delete(key); };
    entry.answer.then((a) => { if (keep(a)) entry.until = Date.now() + keepMs; else drop(); }, drop);
    return entry.answer;
  };
}
