# Design to code

Turning a Pena design into code in the user's project. The design is the spec: same texts, icons, sizes, spacing,
radii, colors and fonts.

## 1. Know the project before writing

- Find the framework (React, Vue, Svelte, plain HTML…), the styling approach (Tailwind, CSS Modules, styled-components…)
  and their installed versions (`package.json`, lockfile). Write code for those versions only. Tailwind → also read
  `guide/tailwind.md`.
- Look for components that already exist (buttons, cards, inputs, layout shells). Reuse or update them; don't create a
  second `Button`. When changing an existing component, keep its current behavior and props working.
- Follow the project's conventions: folders, file naming, exports, how tokens/themes are defined.
- Only write code. No summary or documentation files.

## 2. Read the design

- `get_node(link)` with the pena:// link the user pasted. No link: `get_app_state` for the selection, then `execute`
  with `Get(id, { resolveInstances: true, includePathGeometry: true })`, `GetVariables()` and `TakeScreenshot([id])`.
- `get_node` returns: the expanded tree, the variables it uses (`$name`, with values per theme), the component instances
  inside it (component name, link, instance ids, overrides) and a screenshot when the file is open. The screenshot is
  the reference to match; the tree has the exact numbers.
- Read each listed component with its own `get_node` link before using it in code.
- Prototype flow: when the node is linked to other screens (`connection`s drawn by the user), `get_node` lists the
  links (`"source" → "target"`, with the interaction when described) and shows each linked screen. They are the
  same UI in other states or the next steps: implement them together, each link as its interaction (the source
  button/tab/link opens the modal, switches the tab, goes to the step), and each variant as a state of the same
  component/page, not as a separate page. Read every linked screen with `get_node` for exact values.

## 3. Components first, one at a time

For each component in the list:
1. Read it (`get_node` on its link) and check every instance's overrides.
2. Props: whatever the instances override (text `content`, icon, fill…) becomes a prop. A child some instance hides
   (`hidden` in the list, i.e. `enabled: false`) is optional/conditional; a child no instance hides always renders.
   A child replaced by a whole node (override with `type`) is a slot → `children`/render prop.
3. Write it, render it, compare with the screenshot. Fix before moving to the next component.

Then build the screen/section: the tree minus component internals, with the components placed and their props set
from each instance's overrides.

## 4. Mapping .pen → CSS

| .pen | CSS |
| --- | --- |
| frame `layout` (default `horizontal`) | `display: flex`; `vertical` → `flex-direction: column` |
| `layout: "none"` | `position: relative`; children `position: absolute; left: x; top: y` |
| `layoutPosition: "absolute"` | `position: absolute; left: x; top: y` (parent `relative`) |
| `gap`, `padding` | same; `[v, h]` or `[top, right, bottom, left]` |
| `justifyContent` / `alignItems` | `flex-start`, `center`, `flex-end`, `space-between`, `space-around` |
| size number | fixed px |
| `fill_container` | main axis: `flex: 1 1 0; min-width/min-height: 0`; cross axis: `align-self: stretch` |
| `fit_content` / no size | auto (hug content); `fit_content(n)` is only an editor fallback, ignore `n` |
| `clip: true` | `overflow: hidden` |
| `cornerRadius` `[a, b, c, d]` | `border-radius: a b c d` (top-left, top-right, bottom-right, bottom-left) |
| fill color / text fill | `background` / `color` |
| linear gradient `rotation` r | `linear-gradient(((360 - r) % 360)deg, …)` (.pen: counter-clockwise from up) |
| image fill `mode` | `object-fit`/`background-size`: `cover`, `contain`, `stretch` → `100% 100%` |
| `stroke` + `strokeWidth` | `border` (inner/center), `outline` (outer); per-side widths → per-side borders |
| shadow effect | `box-shadow: x y blur spread color` (`inner` → `inset`) |
| `blur` / `background_blur` | `filter: blur()` / `backdrop-filter: blur()` |
| `opacity`, `rotation` r | `opacity`; `transform: rotate(-rdeg)` with `transform-origin: top left` |
| `enabled: false` | not rendered |
| text `lineHeight` | multiplier of `fontSize` (unitless `line-height`) |
| text `letterSpacing` | px |
| `textGrowth: "auto"` / `"fixed-width"` | `white-space: nowrap` / wraps inside its width |
| `href` | `<a>` |

- Icons: `library` + `icon` name → the project's icon package (`lucide` → `lucide-react`, `ArrowRight` for
  `arrow-right`; Phosphor, Feather, Material Symbols likewise). Install it only if the project has none.
- Paths/logos: inline `<svg viewBox="0 0 w h">` (or the node's `viewBox`) with `d` = `geometry`, exactly as given.
  Never redraw or simplify.
- Images: `url` is relative to the .pen file; copy the asset into the project's public/assets folder.
- Variables: one CSS custom property (or theme token) per `$name`, same name. Themed values → the project's theme
  mechanism (e.g. `.dark` / `[data-theme]` overrides). No hardcoded colors where the design uses a variable.
- Fonts: load the exact `fontFamily`/`fontWeight` the way the project loads fonts.

Exact reference: when the file is open in Pena, `Export([id], "html-css", "export")` in `execute` writes the node as
HTML + CSS, the same CSS Pena renders with. Use it to check a hard value (gradients, shadows, strokes); write the real
code in the project's own style, not by pasting that file.

## 5. Check

- Run the project (dev server, Storybook…) and compare with the screenshot: spacing, alignment, colors, typography,
  wrapping, icons.
- Resize: `fill_container` parts must grow, nothing overflows horizontally, long content scrolls where it should.
- No console errors; interactive elements (links, buttons, inputs) work.
- Count: every instance and text in the design is in the code.
- Flow: every connection works (clicking the source reaches the target state) and every linked state renders like its screen.
