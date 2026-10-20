# The `execute` tool

Runs a JavaScript snippet against the document. Atomic: if it throws, NOTHING is saved and the error prints an `editId`.
Then fix it with `edits` (find/replace on the failed snippet) and that `editId` — never resend the whole snippet.
Always pass a short `description` ("Add pricing section with 3 tiers"); the user sees it.

Each call has its own scope (helpers don't persist). A top-level `return value` is printed.

```ts
const document: "document";                                       // root id
Insert(parentId, node): string                                    // new id; nested `children` get ids too
Copy(path, parentId, overrides?): string                          // deep copy, fresh ids; overrides may include `descendants`
Update(path, props): void                                         // shallow merge (inside instances: stored as an override)
Replace(path, node): string                                       // same position
Move(path, parentId | undefined, index?): void                    // undefined parent = reorder in place
Delete(path): void
Get(path?, { depth?, resolveVariables?, resolveInstances?, includePathGeometry? }): Node
Get(path, visit, options?): T[]  /  Get(visit, options?): T[]     // visit(node, ctx) => value | undefined
                                                                  // ctx: { node, parentCtx, depth, index, bounds, skipChildren() }
GetVariables(): { variables, themes }
SetVariables(vars, replace = false): void                          // merge; themed values add their theme axes
FindEmptySpace({ width, height, direction?: "right"|"bottom"|"left"|"top", padding? = 100, nodeId? }): { x, y }
TakeScreenshot(ids): void                                         // images are attached to the result
                                                                  // Export writes <outputDir>/<id>.<ext> (relative to the .pen file)
Export(ids, "png"|"jpeg"|"webp"|"svg"|"pdf"|"html-css", outputDir, { scale?, quality?, includeHtmlScaffold?, includeLayerNames?, includeLayerIds? }): void
Print(...values): void
ListShaders(): { name, label, kind: "effect"|"fill", uniforms }[]  // Pena's shader library
UseShader(name): string                                           // copies it next to the .pen, returns the url
WriteShader(name, glsl): string                                   // your own shader file (overwrites), returns the url
```

`path` is a node id, or `instanceId/childId` for nodes inside component instances.

## Rules

- Set `name` on every node. Never set `id`.
- Use arrays, loops, helpers and spreads for repeated UI. Short snippets, no comments.
- Insert whole subtrees at once with nested `children`.
- Need ids of children you just created? `Get(id, { depth: 2 })`.
- Shared styles: `const body = { type: "text", fontFamily: "Inter", fontSize: 15, fill: "$text" }`.
- Repeated UI that should stay in sync → make a component (`reusable: true`) and insert `ref` instances.
- New screens: `FindEmptySpace({ width, height })` for the position, `placeholder: true` while you work on it, remove it when done.
  Call it in the same snippet as the `Insert` (other agents may be placing frames too). Hug-height screens need a hint,
  `height: "fit_content(900)"`: a bare `fit_content` counts as 0 px until the editor renders it, so frames placed below would overlap.
- After each section: `TakeScreenshot([screenId])` and check the image (clipping, collapsed layout, contrast, alignment). Fix in place with `Update`.

## Examples

```js
SetVariables({ bg: { type: "color", value: [{ value: "#FFFFFF" }, { value: "#0B0B0F", theme: { Mode: "Dark" } }] },
               text: { type: "color", value: [{ value: "#0F172A" }, { value: "#F1F5F9", theme: { Mode: "Dark" } }] } });
const pos = FindEmptySpace({ width: 390, height: 844 });
const screen = Insert(document, { type: "frame", name: "Home", ...pos, width: 390, height: "fit_content(844)",
  layout: "vertical", fill: "$bg", clip: true, padding: [0, 20, 24, 20], gap: 24, placeholder: true });
const row = Insert(document, { type: "frame", name: "List Row", reusable: true, x: pos.x, y: pos.y - 120, width: 350,
  padding: [14, 16], cornerRadius: 12, fill: "#F1F5F9", justifyContent: "space_between", alignItems: "center",
  children: [{ type: "text", name: "Label", content: "Item", fontFamily: "Inter", fontSize: 15, fill: "$text" },
             { type: "icon", name: "Chevron", library: "lucide", icon: "chevron-right", width: 18, height: 18, fill: "#94A3B8" }] });
const label = Get(row).children[0].id;
for (const t of ["Inbox", "Today", "Upcoming"])
  Insert(screen, { type: "ref", ref: row, name: `Row ${t}`, width: "fill_container", descendants: { [label]: { content: t } } });
TakeScreenshot([screen]);
```

Dark variant of an existing screen:

```js
const pos = FindEmptySpace({ width: 390, height: 844, nodeId: "Xk9f2" });
Copy("Xk9f2", document, { name: "Home — Dark", ...pos, theme: { Mode: "Dark" } });
```
