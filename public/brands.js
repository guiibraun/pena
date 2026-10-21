// Official provider logos, from Simple Icons / SVG Logos (both CC0). Drawn with the same CSS-mask
// technique as `ic()`, so they keep the app's icon behavior; the color is the brand's own (white
// where the mark is black, which is how those brands use it on dark surfaces).
const BRANDS = {
  claude: { set: 'simple-icons', icon: 'claude', color: '#d97757' },
  codex: { set: 'simple-icons', icon: 'openai', color: '#ffffff' },
  openai: { set: 'simple-icons', icon: 'openai', color: '#ffffff' },
  opencode: { set: 'simple-icons', icon: 'opencode', color: '#cfcecd' },
  gemini: { set: 'simple-icons', icon: 'googlegemini', color: '#8e75b2' },
  cursor: { set: 'simple-icons', icon: 'cursor', color: '#ffffff' },
  kiro: { set: 'logos', icon: 'kiro', color: '#ffffff' },
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
  i.style.setProperty('--i', `url("https://api.iconify.design/${brand.set}/${brand.icon}.svg")`);
  i.style.backgroundColor = brand.color;
  if (size !== 16) i.style.width = i.style.height = `${size}px`;
  i.setAttribute('aria-hidden', 'true');
  return i;
};
