// Dashboard search: every word of the query must hit the file name or one of its folders (accents and case ignored).
// A hit on the name outranks one on a folder; a word typed with gaps ("lndg" for "landing") still matches the name.
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const subsequence = (word, text) => { let i = 0; for (const c of text) if (c === word[i]) i++; return i === word.length; };

function wordScore(word, name, folders) {
  if (name === word) return 100;
  if (name.startsWith(word)) return 80;
  if (name.split(/[^a-z0-9]+/).some((p) => p.startsWith(word))) return 60;
  if (name.includes(word)) return 50;
  if (folders.some((f) => f.startsWith(word))) return 30;
  if (folders.some((f) => f.includes(word))) return 20;
  return word.length >= 3 && subsequence(word, name) ? 10 : 0;
}

// `items`: library entries ({ name, path, folder, openedAt }); best match first, then the most recently used.
export function searchFiles(items, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items
    .map((d) => {
      const name = norm(d.name.replace(/\.pen$/i, ''));
      const folders = [...d.path.split(/[\\/]/).slice(0, -1), d.folder].filter(Boolean).map(norm);
      const scores = words.map((w) => wordScore(w, name, folders));
      return { d, score: scores.every(Boolean) ? scores.reduce((a, b) => a + b) : 0 };
    })
    .filter((r) => r.score)
    .sort((a, b) => b.score - a.score || (b.d.openedAt ?? 0) - (a.d.openedAt ?? 0))
    .map((r) => r.d);
}
