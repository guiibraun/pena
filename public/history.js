// Undo/redo stacks are bounded by count and by bytes: an entry holds the JSON of every touched root, and one root
// can be ~135 KB, so 300 entries alone could pin ~40 MB of strings.
export const HISTORY_MAX = 300;
export const HISTORY_BUDGET = 16e6; // string chars kept across a stack (JavaScriptCore stores a string with any non-Latin-1 char at 2 bytes each)
export const HISTORY_KEEP = 20; // the newest entries survive even if they alone exceed the budget

export const entrySize = (e) => {
  let n = e.meta?.length ?? 0;
  for (const json of e.roots.values()) n += json?.length ?? 0;
  return n;
};

// Push `entry`, then drop the oldest entries while over the count cap or the byte budget.
export function pushBounded(stack, entry, { max = HISTORY_MAX, budget = HISTORY_BUDGET, keep = HISTORY_KEEP } = {}) {
  entry.size ??= entrySize(entry);
  stack.push(entry);
  let total = 0;
  for (const e of stack) total += e.size;
  let drop = 0;
  while (stack.length - drop > max || (total > budget && stack.length - drop > keep)) total -= stack[drop++].size;
  if (drop) stack.splice(0, drop);
}
