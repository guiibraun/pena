# Tailwind (design to code)

Read `guide/code.md` first. This adds the Tailwind specifics. Check the installed version: v4 configures in CSS
(`@import "tailwindcss"`, `@theme`), v3 in `tailwind.config.*` (`@tailwind base/components/utilities`).

## Rules

- Classes only. No `style={{…}}`, except values that are truly dynamic at runtime.
- No exact utility for a design value → arbitrary value: `w-[372px]`, `gap-[18px]`, `rounded-[14px]`,
  `text-[15px]`, `leading-[1.4]`, `tracking-[-0.2px]`, `shadow-[0_4px_12px_#0000001a]` (spaces become `_`).
- Use the scale class only when it is the same value (`gap-4` = 16 px with the default spacing scale).
- Don't add a CSS reset: Preflight already does it.

## Variables

- Each `$name` the design uses → a CSS custom property, same name (spaces and slashes → `-`).
- v4, no themes: colors in `@theme { --color-<name>: …; }` give `bg-<name>` / `text-<name>` / `border-<name>` / `fill-<name>`.
- v4, themed: values in `:root { --<name>: … }` and the project's theme selector (`.dark`, `[data-theme="dark"]`), then
  `@theme inline { --color-<name>: var(--<name>); }`. A class-based dark mode needs
  `@custom-variant dark (&:where(.dark, .dark *));` if the project doesn't have it yet.
- v3: `:root` / `.dark` variables plus `theme.extend.colors` entries `'<name>': 'var(--<name>)'`.
- Already-existing tokens with the same value: reuse them instead of adding duplicates.

## Fonts

- Load fonts the project's way (`next/font`, `@fontsource/*`, `<link>`). With `next/font`, use the variable it gives
  (`--font-inter`) directly; don't copy it into another variable.
- v4: `--font-<name>: "Inter", sans-serif` in `@theme` gives `font-<name>`. v3: `theme.extend.fontFamily`.
- Weights: `font-[450]` when not a named weight.

## Layout

| .pen | Tailwind |
| --- | --- |
| `layout: "horizontal"` / `"vertical"` | `flex` / `flex flex-col` |
| `layout: "none"` | `relative`, children `absolute left-[x] top-[y]` |
| `fill_container` (main axis) | `flex-1 min-w-0` (row) / `flex-1 min-h-0` (column) |
| `fill_container` (cross axis) | `self-stretch` (or `w-full` / `h-full`) |
| `fit_content` | nothing (or `w-fit`) |
| `justifyContent` | `justify-start/center/end/between/around` |
| `alignItems` | `items-start/center/end` |
| `clip: true` | `overflow-hidden` |
| `cornerRadius: [a, b, c, d]` | `rounded-tl-[a] rounded-tr-[b] rounded-br-[c] rounded-bl-[d]` |
| `padding: [t, r, b, l]` | `pt-[t] pr-[r] pb-[b] pl-[l]` |
| `textGrowth: "auto"` | `whitespace-nowrap` |
| `background_blur` | `backdrop-blur-[r]` |

## SVG

`<svg viewBox="0 0 w h" className="size-[w]">` with `<path d={geometry} className="fill-<name>" />`; strokes:
`stroke-<name> stroke-[width]`, `fill-none` when the path has no fill. Use `currentColor` when the icon color comes
from the parent's text color.
