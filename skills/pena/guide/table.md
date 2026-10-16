# Tables

Hierarchy is strict: **Table (frame, vertical) → Row (frame, horizontal) → Cell (frame) → content**.

```
Table   layout vertical, width fill_container
├─ Header row   layout horizontal, width fill_container, height 44, fill subtle
│  └─ Cell      width fixed or fill_container, height fill_container, padding [0,16], alignItems center
│     └─ Text   fontWeight 600, fontSize 12–13, muted color
└─ Data row     same structure, height 52, bottom stroke or alternating fill
   └─ Cell → Text / badge / button / avatar
```

- Never put text directly in a row: always wrap it in a cell frame, otherwise columns don't align.
- Every cell in a column shares the same width (same number, or `fill_container` for the flexible column).
- Numbers right-aligned (`justifyContent: "end"` on the cell).
- Generate realistic placeholder data when the user gives none.
- On mobile, turn wide tables into a list of cards.
- Build rows in a loop from an array of data objects.
