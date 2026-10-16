# Web apps (dashboards, admin, SaaS)

Functional product UI — never a marketing page.

## Layout
- Frame 1440 × 900 (`height: "fit_content(900)"` if it grows). Typical shell: sidebar 240–264 wide (`layout: "vertical"`) + main area `fill_container` with a top bar (56–64 tall) and a content column.
- Content uses an 8 px spacing scale: 8 / 12 / 16 / 24 / 32.

## Principles
1. **One purpose per screen**: it answers one main question and has one primary action (top-right of the content header).
2. **One dominant region**: the main chart/table/editor is visibly larger; secondary panels are subordinate. Avoid equal-weight grids of cards.
3. **Self-explanatory**: clear text labels, icons never replace essential words, system state (loading, empty, error, selected) is visible.
4. **Progressive disclosure**: show essentials first; advanced controls appear in context (row actions, side panel).
5. **Recognition over recall**: consistent placement of navigation and actions across screens; current location highlighted in the sidebar.
6. **Density with calm**: 13–14 px UI text, 12 px secondary, tabular numbers right-aligned. Use separators or subtle row fills instead of boxes around everything.
7. **Real data**: plausible names, amounts, dates and statuses — never "Lorem ipsum" or "Item 1".

## Charts
- Prefer bar charts built with flex layout (a horizontal frame of vertical bars aligned `end`, labels below in the same column frame) so labels line up automatically.
- Don't overlay absolutely positioned labels on charts. Line charts are hard to build — use bars or sparkline-like paths with a `viewBox`.
