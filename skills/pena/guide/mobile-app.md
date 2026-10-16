# Mobile app screens

Goal: modern, calm screens that are easy to scan and comfortable to use with one thumb.

## Structure

- Screen frame: width 390, `layout: "vertical"`, `height: "fit_content(844)"` so it grows with content instead of matching the device height. `clip: true`.
- Build the status bar and (if needed) the tab bar first, then the content between them.
1. **Status bar** — 54–62 px tall, time on the left and signal/battery on the right, vertically centered. Nothing of the app goes behind it.
2. **Content wrapper** — one frame with `width: "fill_container"`, horizontal padding 16–20 set once, `layout: "vertical"`. Space sections with `gap` (24–32 between sections, 12–16 between related items). Never add spacer elements.
3. **Tab bar** (optional, 3–5 destinations) — last child of the screen, never absolutely positioned. A floating capsule ~56 px tall, inset ~16 px from the sides, `cornerRadius` = half its height, translucent fill (`#FFFFFFB3`) with `backgroundBlur` and a soft `shadow`. Items: 22 px icon above a 10–11 px label; the active one uses the accent color on a soft pill.

## Rules

- One primary intent per screen. The first one or two elements tell the user where they are and what they can do.
- Same title size on every screen of the app.
- Primary actions in the lower half; buttons at least 48 px tall.
- Body text 15–17 px, secondary 13 px. Never below 11 px.
- Lists over grids of cards; cards only when an item has several fields.
