// Official provider logos, from Simple Icons / SVG Logos (both CC0). Drawn with the same CSS-mask
// technique as `ic()`, so they keep the app's icon behavior; the color is the brand's own (white
// where the mark is black, which is how those brands use it on dark surfaces).
const BRANDS = {
  claude: { icon: 'claude', color: '#d97757' },
  codex: { icon: 'openai', color: '#ffffff' },
  openai: { icon: 'openai', color: '#ffffff' },
  opencode: { icon: 'opencode', color: '#cfcecd' },
  gemini: { icon: 'googlegemini', color: '#8e75b2' },
  cursor: { icon: 'cursor', color: '#ffffff' },
  kiro: { icon: 'kiro', color: '#ffffff' },
};
// The same brand behind a different surface name (CLI vs desktop app, SDK vs product).
BRANDS.claudeDesktop = BRANDS.claude;
BRANDS['claude-cli'] = BRANDS.claude;
BRANDS['claude-code'] = BRANDS.claude;

export const brandIcon = (id, size = 16) => {
  const brand = BRANDS[id];
  if (!brand) return null;
  const i = document.createElement('i');
  i.className = 'ic brand';
  i.style.setProperty('--i', `url("/brand-${brand.icon}.svg")`);
  i.style.backgroundColor = brand.color;
  if (size !== 16) i.style.width = i.style.height = `${size}px`;
  i.setAttribute('aria-hidden', 'true');
  return i;
};
