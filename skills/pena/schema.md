# .pen schema (pen.dev-compatible, version 2.21)

```ts
type Var = `$${string}`;                       // "$name" binds to document.variables["name"]
type Num = number | Var;
type Color = string | Var;                       // "#RGB" | "#RRGGBB" | "#RRGGBBAA"
type Size = Num | "fill_container" | "fit_content" | `fill_container(${number})` | `fit_content(${number})`; // (n) = fallback

type Fill =
  | Color
  | { type: "color"; color: Color; enabled?: boolean }
  | { type: "gradient"; gradientType?: "linear" | "radial" | "angular"; rotation?: number; // degrees CCW, 0 = up, 180 = down
      center?: { x: number; y: number };              // 0..1, default 0.5/0.5
      colors: { color: Color; position: number }[]; enabled?: boolean }
  | { type: "image"; url: string; mode?: "cover" | "contain" | "stretch"; enabled?: boolean } // url relative to the .pen file or https
  | { type: "shader"; url: string; uniforms?: Uniforms; opacity?: Num; enabled?: boolean }; // GLSL fill, see Shaders
type Fills = Fill | Fill[];                           // arrays paint bottom → top

type Effect =
  | { type: "shadow"; shadowType?: "outer" | "inner"; offset?: { x: Num; y: Num }; blur?: Num; spread?: Num; color?: Color }
  | { type: "blur"; radius: Num }
  | { type: "background_blur"; radius: Num }           // frosted glass
  | { type: "shader"; url: string; uniforms?: Uniforms; enabled?: boolean }; // post-processes the node, see Shaders
type Uniforms = Record<string, number | boolean | string | number[]>; // by uniform name: numbers, "#hex" colors, vectors, image urls

interface Entity {
  id: string;                    // generated, never set it
  name?: string;                 // always set
  x?: number; y?: number;        // relative to parent; ignored inside flex layout
  rotation?: Num;                // degrees CCW around the top-left corner
  opacity?: Num; enabled?: boolean;  // enabled:false hides the node
  flipX?: boolean; flipY?: boolean;
  layoutPosition?: "auto" | "absolute"; // absolute = leave the parent's flex flow, use x/y
  reusable?: boolean;            // makes this node a component (instantiate with `ref`)
  theme?: Record<string, string>;// e.g. { Mode: "Dark" } — applies to this subtree
  effect?: Effect | Effect[];
}
interface Graphics { fill?: Fills; stroke?: Fills; strokeWidth?: Num | { top?: Num; right?: Num; bottom?: Num; left?: Num };
  strokeAlignment?: "inner" | "center" | "outer"; strokeLinecap?: "butt" | "round" | "square"; strokeLinejoin?: "miter" | "round" | "bevel" }
type Radius = Num | [Num, Num, Num, Num];             // topLeft, topRight, bottomRight, bottomLeft

interface Frame extends Entity, Graphics {
  type: "frame"; children?: Node[]; width?: Size; height?: Size; cornerRadius?: Radius;
  layout?: "horizontal" | "vertical" | "none";       // default "horizontal"
  gap?: Num; padding?: Num | [Num, Num] | [Num, Num, Num, Num];
  justifyContent?: "start" | "center" | "end" | "space_between" | "space_around";
  alignItems?: "start" | "center" | "end";
  clip?: boolean; placeholder?: boolean;              // placeholder: work in progress
}                                                      // defaults: width/height fit_content
interface Group extends Entity { type: "group"; children?: Node[] }          // no layout, no size
interface Rectangle extends Entity, Graphics { type: "rectangle"; width?: Size; height?: Size; cornerRadius?: Radius }
interface Ellipse extends Entity, Graphics { type: "ellipse"; width?: Size; height?: Size;
  innerRadius?: Num; startAngle?: Num; sweepAngle?: Num } // ring 0..1; arcs in degrees CCW from the right
interface Polygon extends Entity, Graphics { type: "polygon"; width?: Size; height?: Size; polygonCount?: Num }
interface Path extends Entity, Graphics { type: "path"; width?: Size; height?: Size; geometry: string; // SVG path data
  viewBox?: [number, number, number, number]; fillRule?: "nonzero" | "evenodd" }
interface Line extends Entity, Graphics { type: "line"; width?: Size; height?: Size } // height 0 = horizontal rule
interface Text extends Entity, Graphics {
  type: "text"; content: string | Var; width?: Size; height?: Size;
  textGrowth?: "auto" | "fixed-width" | "fixed-width-height";
  fontFamily?: string; fontSize?: Num; fontWeight?: string; fontStyle?: "normal" | "italic";
  lineHeight?: Num; letterSpacing?: Num; textAlign?: "left" | "center" | "right" | "justify";
  textAlignVertical?: "top" | "middle" | "bottom"; underline?: boolean; strikethrough?: boolean; href?: string;
}                                                      // text color = fill
interface Icon extends Entity { type: "icon"; library?: "lucide" | "feather" | "phosphor" | "Material Symbols Outlined" | "Material Symbols Rounded" | "Material Symbols Sharp";
  icon: string; width?: Size; height?: Size; fill?: Fills }  // icon name in that library, e.g. "arrow-right"
interface Note extends Entity { type: "note" | "context"; content: string; width?: Size; height?: Size } // sticky notes
interface Browser extends Entity { type: "browser"; url: string; width?: Size; height?: Size; zoom?: number } // live page
interface Ref extends Entity {                         // component instance
  type: "ref"; ref: string;                            // id of a reusable node
  descendants?: Record<string, object>;                // key: descendant id (or `nestedInstanceId/childId`, or a unique name)
  [prop: string]: unknown;                             // value: props to override, or a full node (with `type`) to replace it
}
type Node = Frame | Group | Rectangle | Ellipse | Polygon | Path | Line | Text | Icon | Note | Browser | Ref;

interface Document {
  version: "2.21";
  children: Node[];
  themes?: Record<string, string[]>;                   // axis → values, first is the default. e.g. { Mode: ["Light", "Dark"] }
  variables?: Record<string, { type: "color" | "number" | "string" | "boolean";
    value: unknown | { value: unknown; theme?: Record<string, string> }[] }>; // themed values
}
```

## Layout

- Prefer flex (`horizontal` / `vertical`); use `layout: "none"` only for free compositions.
- `x`/`y` are ignored inside a flex parent unless `layoutPosition: "absolute"`.
- `layout`, `padding` and `gap` exist only on frames. Text has no padding: wrap it in a frame.
- Flex is single-axis, no wrapping: build grids from row frames.
- `fill_container` takes the remaining space along the parent's axis and stretches across it; the parent needs a size.
  A `fit_content` parent whose only children are `fill_container` collapses.
- No percentages, margins, `calc()`, baseline/stretch alignment.

## Text sizing

- Sized by content (labels, buttons, badges): default `textGrowth: "auto"`, no width/height; never wraps.
- Sized by the parent (titles, paragraphs): `textGrowth: "fixed-width"` + `width: "fill_container"` inside a frame that has a width.
- A width without `textGrowth: "fixed-width"` does nothing.

## Components

- A node with `reusable: true` is a component. Instances are `{ type: "ref", ref: componentId }` plus any own props (x, y, width, name...).
- Customize an instance's inner nodes with `descendants: { [childId]: { content: "Buy" } }`, or later with
  `Update(instanceId + "/" + childId, {...})`. Inside instances, ids are paths `instanceId/childId` (nested: `a/b/c`).
- Instance descendants can't be deleted: hide them with `{ enabled: false }`. To swap one, give a full node with `type`.
- Edit the component itself to change every instance.

## Variables & themes

- Colors/numbers used more than twice belong in variables; bind with `"$name"`.
- Themed variables: `value: [{ value: "#fff" }, { value: "#000", theme: { Mode: "Dark" } }]`. The best match for the
  node's theme wins; entries without `theme` are the default.
- Set `theme: { Mode: "Dark" }` on a frame to render its subtree in that theme (e.g. a dark copy of a screen).

## Shaders

A shader fill paints the shape with a GLSL ES fragment shader; a shader effect redraws the whole node (children
included) through one: warp, pixelate, color-grade, distort a card or a hero. Several shader effects chain in order.
`url` is a `.glsl` file next to the .pen: get one with `UseShader("pixelate")` (see `ListShaders()`; effects: pixelate,
wave, color-grade, duotone, chromatic, halftone, dither, crt, glitch, grain, bevel; fills: glass, ripple, aurora,
grainy-gradient) or write your own with `WriteShader(name, glsl)`. Set only the uniforms you change:
`effect: { type: "shader", url: UseShader("wave"), uniforms: { u_amplitude: 16 } }`.

Writing one (WebGL 1 / GLSL ES 1.00, `gl_FragColor`; `#define NAME value` only). `gl_FragCoord` is in px from the
bottom-left of the shaded area; texture coordinates are 0..1 with v up. Uniforms are bound by their annotations:

```glsl
precision highp float;
/** @resolution */ uniform vec2 u_resolution;   // size of the shaded area in px
/** @time */ uniform float u_time;              // seconds; animates on the canvas, 0 in exports
/** @content */ uniform sampler2D u_content;    // effects: the node itself, premultiplied
/** @backdrop */ uniform sampler2D u_backdrop;  // what is behind the node (glass, water)
/** @sdf */ uniform sampler2D u_sdf;            // r = px to the edge (positive inside), gb = inward normal
/** @label Amount @default 0.5 @range 0, 1 */ uniform float u_amount;   // a slider in the panel
/** @label Tint @color @default #FF7A59 */ uniform vec3 u_tint;           // a color picker
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec4 c = texture2D(u_content, uv);
  gl_FragColor = vec4(mix(c.rgb, u_tint * c.a, u_amount), c.a);
}
```

TakeScreenshot reports a shader that fails to compile (with the line); the node is drawn without it meanwhile.
