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

Every link is a `connection` that the implementer reads later (in code, through `get_node`), so it must say
exactly what happens, not just that two things are related.

### What to link

- source = the exact element the user acts on (button, link, tab, row, icon, input), never the whole screen. Inside
  component instances use `instanceId/childId`. target = the top-level screen or state screen it leads to.
- Don't link decorative or disabled elements. Check `get_app_state` → `connections` first; never duplicate a link.
- Lists, grids and tables: link one representative item and add "(qualquer item)" to its `context`.
- Cover the whole path: entry → each step → success, plus the way back (back/close/cancel) and every error branch.

### How to write `context`

Format: `<gatilho> [condição] → <tipo>` in the user's language, one connection per outcome.

- **gatilho**: toque, duplo toque, pressionar e segurar, arrastar, deslizar, enviar, digitar, foco, tecla (Enter,
  Esc), carregou, após 2s, erro de rede.
- **condição** (optional, only when the outcome depends on something): `[campos válidos]`, `[campos inválidos]`,
  `[sem resultados]`, `[usuário logado]`, `[primeira vez]`.
- **tipo** (always one of these four; it decides how the target is built in code):
  - `navegar`: a new page/route replaces the current screen (next step, detail page, a different section).
  - `overlay`: opens on top of the current screen, which stays alive underneath (modal, sheet, menu, popover, toast).
    The target must be drawn as the base screen plus the overlay, and needs its own link back (`fechar → voltar`).
  - `estado`: the same screen changes in place (tab switched, item selected, filter applied, empty/error/loading
    state, field validation). No new route.
  - `voltar`: returns to where the user came from (back, close, cancel, dismiss).

Examples: `toque → navegar`, `enviar [campos válidos] → navegar`, `enviar [campos inválidos] → estado`,
`toque no ícone de filtro → overlay`, `fechar → voltar`, `carregou [sem resultados] → estado`,
`após 2s → navegar`, `toque (qualquer item) → navegar`.

### Layout of the flow

- Anchors: leave from the side of the source that faces the target (`right` when the target is to the right),
  enter the target on the facing side. Lay screens out left → right in flow order, ~100 px apart; state screens
  right below the screen they vary, overlay screens right below their base screen.
- State and overlay screens are reached from the screen they vary and lead back when it ends (retry, close).

## Check before finishing

- `get_app_state` lists every connection as `"Screen" › "trigger" → "target": context` and, under `unlinked`,
  the top-level screens no connection reaches or leaves. Every screen you drew must be linked (except the States
  sheet and the first screen of the flow, which only has outgoing links).
- To see one screen's whole flow with screenshots, call
  `get_node({ link: "pena://node/<screenId>?file=<file from get_app_state>" })`.
- Every state variant you drew is used by some screen or listed in the States sheet.
- Every `context` follows `<gatilho> [condição] → <tipo>` with a valid tipo; every `overlay` has a way back; every
  branching action (submit, search, login) has one connection per outcome.
