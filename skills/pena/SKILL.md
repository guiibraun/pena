---
name: pena
description: Design websites, app screens, dashboards, slides and marketing graphics on the Pena canvas. Use for any visual design work in a .pen document.
---

# Pena

Pena is an infinite canvas design tool. A document is a tree of nodes (`frame`, `text`, `rectangle`, `ellipse`, `path`) stored as JSON in a `.pen` file and rendered live while you work.

## Files

| File | When | How |
| --- | --- | --- |
| `SKILL.md` | Always (already loaded) | — |
| `schema.md` | Always (already loaded) | — |
| `execute.md` | Always (already loaded) | — |
| `guide/mobile-app.md` | Mobile app screens | `read_skill({ path: "guide/mobile-app.md" })` |
| `guide/web-app.md` | Dashboards, admin panels, SaaS UI | `read_skill({ path: "guide/web-app.md" })` |
| `guide/landing-page.md` | Landing pages, marketing sites | `read_skill({ path: "guide/landing-page.md" })` |
| `guide/slides.md` | Presentations | `read_skill({ path: "guide/slides.md" })` |
| `guide/table.md` | Tables, data grids | `read_skill({ path: "guide/table.md" })` |

Read the matching guide BEFORE starting a design of that kind. `read_skill()` with no path lists every available file, including ones the user added.

## Working rules

- Start with `get_app_state`: it shows the open file, the user's selection and the top-level frames. A selected node is usually what "this" refers to.
- Big tasks (several screens, sections or variations): create the container frames first with `placeholder: true`, then
  `spawn_agents` with one container per extra agent and do the last part yourself.

- Do only what was asked. Technical requests (move, delete, rename, recolor) get exactly that change, nothing more.
- The user (and other agents) can edit the canvas while you work. If a node is missing or changed, re-read it with `Get` instead of recreating it, and never undo others' edits.
- Show progress early: build the skeleton of a screen in the first `execute`, then refine. Order changes the way a designer would.
- Each screen is a top-level frame directly under `document` with `clip: true`. Only screens and large containers live at the root — never loose text, buttons or shapes.
- Place new screens to the right of existing ones (leave ~100 px between them). Read the document first to find free space.
- When you add content to a frame, make sure it has the right layout or is big enough. There is no scrolling: everything must be visible.
- Fix designs in place with `Update`. Never delete a screen to redo it.
- Prefer copying an existing element (`Copy`) and editing the copy over rebuilding similar UI. Reuse existing components (`reusable: true`) through `ref` instances.
- Mark new screens `placeholder: true` while working on them and remove it as soon as each one is done.

## Verify every section

After finishing each section (not only at the end), call `TakeScreenshot([frameId])` inside `execute`, look at the image and check:
- No collapsed layout (a `fill_container` child inside a `fit_content` parent collapses to 0).
- Nothing clipped; container frames are large enough or use `fit_content`.
- Text has enough contrast against its background.
- Elements are aligned and spacing is consistent (use `gap`, not ad-hoc offsets).

## Style

- Avoid generic AI look: not every element needs a card, a border, a shadow or a gradient. Use containers only when they have a structural purpose.
- Break repetitive grids with at least one distinctive element per screen (a bold heading, an asymmetric split, a large number).
- Pick one accent color and reserve it for primary actions and key highlights.
- Any Google Font can be used by name in `fontFamily`. Pair at most two families.
- Do not hand-draw logos, mascots or illustrations with paths — they look bad. Use a simple wordmark (styled text), a monogram in a shape, or an image fill.
- For photos use image fills with real URLs, e.g. `https://images.unsplash.com/photo-<id>?w=1200` when you know a valid id, or `https://picsum.photos/seed/<word>/1200/800`.
- Icons: use `icon` nodes (`library: "lucide"` by default, any Lucide icon name). One library and one size per context.

## Objects

- Coordinates are relative to the parent's top-left corner; x grows right, y grows down.
- Only `frame` nodes have children.
- Properties never inherit from parents: set `fontFamily`, `fill`, etc. on every text node.
- Omit properties that equal their default.
- Never use CSS units or percentages (`"100%"`, `"50vh"`, `calc()`): only numbers, `fill_container` and `fit_content`.
