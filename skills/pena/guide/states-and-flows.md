# States and flows

Goal: a design someone can implement without guessing: every interactive thing shows its states, and every
screen says how you get to it and where it leads, through `connection` nodes on the canvas.

## Interactive states (when "Draw states" is on)

- Every interactive element gets its states: default, hover, pressed/active, focused, disabled. Inputs add filled
  and error; anything that waits on the network adds loading. Toggles, tabs, chips and checkboxes add selected.
- Build them once, as components: a frame named "States" (or "Componentes — estados") to the right of the screens,
  with one row per component (`Button / Primary`, `Input / Text`...) and one `reusable: true` variant per state,
  labelled underneath with the state name. Screens use `ref` instances of these components.
- Name each variant `<Component> / <State>`, e.g. `Button / Primary / Disabled`. Same size in every state; only
  color, border, opacity, icon or text change. Disabled: lower contrast (≈40% opacity or muted tokens), never hidden.
- Screen states (empty, loading, error, success, filled form, modal open, item selected) are separate top-level
  screens next to the original, named `<Screen> — <State>`, e.g. `Login — Erro`. Copy the screen (`Copy`) and edit
  the copy; never redraw it.
- A form starts with its submit disabled until the required fields are valid: draw both.

## Flows (when "Link screens" is on)

- Link every trigger to what it opens with a `connection`: source = the element the user acts on (button, link,
  tab, row, icon — inside instances use `instanceId/childId`), target = the top-level screen or state screen it leads to.
- `context` says the interaction in a few words, in the user's language: "toque", "enviar (válido)",
  "enviar (erro)", "voltar", "após 2s". One connection per outcome: a submit that can fail has two.
- Cover the whole path: entry → each step → success, plus the way back (back/close/cancel) and the error branches.
  State screens are reached from the screen they vary, and lead back when the state ends (closing a modal, retrying).
- Anchors: leave from the side of the source that faces the target (`right` when the target is to the right),
  enter the target on the facing side. Lay screens out left → right in the order of the flow, ~100 px apart.
- Do not link decorative or disabled elements. Don't duplicate a link that already exists: check
  `get_app_state` → `connections` first.

## Check before finishing

- `get_app_state` lists every connection as `"Screen" › "trigger" → "target": context` and, under `unlinked`,
  the top-level screens no connection reaches or leaves. Every screen you drew must be linked (except the States
  sheet and the first screen of the flow, which only has outgoing links).
- To see one screen's whole flow with screenshots, call
  `get_node({ link: "pena://node/<screenId>?file=<file from get_app_state>" })`.
- Every state variant you drew is used by some screen or listed in the States sheet.
