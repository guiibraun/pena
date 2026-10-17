// Figma import check: builds a small fig-kiwi archive (the subset of Figma's schema the converter reads) and imports it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { compileSchema, encodeBinarySchema, parseSchema } from 'kiwi-schema';
import { deflateSync, zipSync } from 'fflate';
import { importFigma, exportFigma } from './figma.mjs';

const schema = parseSchema(`
enum NodeType { DOCUMENT = 0; CANVAS = 1; FRAME = 2; TEXT = 3; RECTANGLE = 4; VECTOR = 5; SYMBOL = 6; INSTANCE = 7; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; IMAGE = 2; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; }
enum StackAlign { MIN = 0; CENTER = 1; MAX = 2; SPACE_BETWEEN = 3; }
enum StackSize { FIXED = 0; RESIZE_TO_FIT_WITH_IMPLICIT_SIZE = 1; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct ColorStop { Color color; float position; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Image { byte[] hash = 1; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; ColorStop[] stops = 5; Matrix transform = 6; Image image = 7; }
message FontName { string family = 1; string style = 2; }
message TextData { string characters = 1; }
message VectorData { uint vectorNetworkBlob = 1; }
message GUIDPath { GUID[] guids = 1; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; }
message NodeChange {
  GUID guid = 1; ParentIndex parentIndex = 2; NodeType type = 3; string name = 4; bool visible = 5; Vector size = 6; Matrix transform = 7;
  Paint[] fillPaints = 8; Paint[] strokePaints = 9; float strokeWeight = 10; float cornerRadius = 11;
  StackMode stackMode = 12; float stackSpacing = 13; float stackVerticalPadding = 14; float stackHorizontalPadding = 15;
  float stackPaddingRight = 16; float stackPaddingBottom = 17; StackAlign stackCounterAlignItems = 18; StackSize stackPrimarySizing = 19;
  TextData textData = 20; FontName fontName = 21; float fontSize = 22; TextAutoResize textAutoResize = 23;
  VectorData vectorData = 24; SymbolData symbolData = 25; GUIDPath guidPath = 26; bool stackChildPrimaryGrow = 27;
}
message Blob { byte[] bytes = 1; }
message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; }
`);

const id = (localID) => ({ sessionID: 1, localID });
const at = (parent, position) => ({ guid: id(parent), position });
const T = (x, y) => ({ m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y });
const solid = (r, g, b) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, opacity: 1, visible: true });
const text = (n, parent, pos, characters) => ({ guid: id(n), parentIndex: at(parent, pos), type: 'TEXT', name: 'Label', visible: true, size: { x: 40, y: 20 }, transform: T(0, 0),
  fillPaints: [solid(0, 0, 0)], textData: { characters }, fontName: { family: 'Inter', style: 'Semi Bold' }, fontSize: 16, textAutoResize: 'WIDTH_AND_HEIGHT' });

// triangle: 3 vertices, 3 straight segments, one region (winding bit 1 = nonzero)
const net = new DataView(new ArrayBuffer(12 + 3 * 12 + 3 * 28 + 8 + 4 + 12));
[3, 3, 1].forEach((v, i) => net.setUint32(i * 4, v, true));
[[0, 0], [10, 0], [5, 8]].forEach(([x, y], i) => (net.setFloat32(12 + i * 12 + 4, x, true), net.setFloat32(12 + i * 12 + 8, y, true)));
[[0, 1], [1, 2], [2, 0]].forEach(([s, e], i) => (net.setUint32(48 + i * 28 + 4, s, true), net.setUint32(48 + i * 28 + 16, e, true)));
[1, 1, 3, 0, 1, 2].forEach((v, i) => net.setUint32(132 + i * 4, v, true));

const nodeChanges = [
  { guid: { sessionID: 0, localID: 0 }, type: 'DOCUMENT', visible: true },
  { guid: id(1), parentIndex: { guid: { sessionID: 0, localID: 0 }, position: '!' }, type: 'CANVAS', name: 'Page 1', visible: true },
  { guid: id(9), parentIndex: { guid: { sessionID: 0, localID: 0 }, position: '"' }, type: 'CANVAS', name: 'Internal', visible: false },
  // component (a button) and, in the card, an instance of it with its label overridden
  { guid: id(20), parentIndex: at(1, '#'), type: 'SYMBOL', name: 'Button', visible: true, size: { x: 80, y: 32 }, transform: T(500, 0), fillPaints: [solid(0, 0, 1)], cornerRadius: 6,
    stackMode: 'HORIZONTAL', stackHorizontalPadding: 12, stackPaddingRight: 12, stackVerticalPadding: 8, stackPaddingBottom: 8 },
  text(21, 20, '!', 'Button'),
  { guid: id(2), parentIndex: at(1, '!'), type: 'FRAME', name: 'Card', visible: true, size: { x: 200, y: 120 }, transform: T(100, 50), fillPaints: [solid(1, 1, 1)],
    strokePaints: [solid(0.9, 0.9, 0.9)], strokeWeight: 1, cornerRadius: 12, stackMode: 'VERTICAL', stackSpacing: 8, stackVerticalPadding: 16, stackHorizontalPadding: 16,
    stackPaddingRight: 16, stackPaddingBottom: 16, stackCounterAlignItems: 'CENTER', stackPrimarySizing: 'FIXED' },
  text(3, 2, '#', 'Hello'),
  { guid: id(4), parentIndex: at(2, '"'), type: 'RECTANGLE', name: 'Bar', visible: true, size: { x: 168, y: 8 }, transform: T(0, 0), stackChildPrimaryGrow: true,
    fillPaints: [{ type: 'GRADIENT_LINEAR', visible: true, opacity: 1, transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }] }] },
  { guid: id(5), parentIndex: at(2, '!'), type: 'INSTANCE', name: 'Button', visible: true, size: { x: 80, y: 32 }, transform: T(0, 0),
    symbolData: { symbolID: id(20), symbolOverrides: [{ guidPath: { guids: [id(21)] }, textData: { characters: 'Comprar' } }] } },
  { guid: id(6), parentIndex: at(1, '"'), type: 'VECTOR', name: 'Triangle', visible: true, size: { x: 10, y: 8 }, transform: T(0, 300), fillPaints: [solid(0, 1, 0)], vectorData: { vectorNetworkBlob: 0 } },
  { guid: id(7), parentIndex: at(1, '$'), type: 'RECTANGLE', name: 'Photo', visible: true, size: { x: 50, y: 50 }, transform: T(0, 400),
    fillPaints: [{ type: 'IMAGE', visible: true, opacity: 1, image: { hash: new Uint8Array([0xab, 0xcd]) } }] },
  // mirrored in Figma (m00 = -1): the box spans 60..100, so .pen x = 60 with flipX (flipped around its center)
  { guid: id(8), parentIndex: at(1, '%'), type: 'RECTANGLE', name: 'Mirrored', visible: true, size: { x: 40, y: 10 }, transform: { m00: -1, m01: 0, m02: 100, m10: 0, m11: 1, m12: 500 }, fillPaints: [solid(1, 0, 0)] },
];
const message = compileSchema(schema).encodeMessage({ nodeChanges, blobs: [{ bytes: new Uint8Array(net.buffer) }] });
const archive = (chunks) => {
  const parts = [new TextEncoder().encode('fig-kiwi'), new Uint8Array(new Uint32Array([48]).buffer)];
  for (const c of chunks) parts.push(new Uint8Array(new Uint32Array([c.length]).buffer), c);
  return Buffer.concat(parts);
};
const fig = archive([deflateSync(encodeBinarySchema(schema)), deflateSync(message)]);

// bare archive (what the clipboard carries): pages, structure, layout, text, gradient, vector, instance
const { pages } = importFigma(fig);
assert.deepEqual(pages.map((p) => p.name), ['Page 1']); // hidden internal page skipped
const [card, triangle, button, photo, mirrored] = pages[0].nodes; // bottom → top (ascending position)
assert.deepEqual({ x: mirrored.x, y: mirrored.y, flipX: mirrored.flipX, rotation: mirrored.rotation }, { x: 60, y: 500, flipX: true, rotation: undefined });
assert.equal(card.type, 'frame');
assert.deepEqual({ x: card.x, y: card.y, width: card.width, layout: card.layout, gap: card.gap, padding: card.padding, alignItems: card.alignItems, cornerRadius: card.cornerRadius },
  { x: 100, y: 50, width: 200, layout: 'vertical', gap: 8, padding: 16, alignItems: 'center', cornerRadius: 12 });
assert.equal(card.height, 120);
assert.equal(card.fill, '#ffffff');
assert.equal(card.stroke, '#e5e5e5');
assert.deepEqual(card.children.map((c) => c.name), ['Button', 'Bar', 'Label']);
const [instance, bar, label] = card.children;
assert.equal(label.x, undefined); // inside flex: no x/y
assert.deepEqual({ content: label.content, fontWeight: label.fontWeight, fontFamily: label.fontFamily, textGrowth: label.textGrowth }, { content: 'Hello', fontWeight: '600', fontFamily: 'Inter', textGrowth: undefined });
assert.equal(bar.height, 'fill_container');
assert.deepEqual({ ...bar.fill, colors: undefined }, { type: 'gradient', gradientType: 'linear', rotation: 270, size: { height: 1 }, colors: undefined });
assert.deepEqual(bar.fill.colors, [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 1 }]);
assert.equal(instance.type, 'frame'); // instances become plain frames, like pen.dev
assert.equal(instance.children[0].content, 'Comprar');
assert.equal(button.name, 'Button');
assert.equal(triangle.geometry, 'M0 0L10 0L5 8L0 0Z');
assert.deepEqual(triangle.viewBox, [0, 0, 10, 8]);
assert.deepEqual(photo.fill, { type: 'image', mode: 'cover' }); // no image bytes on the clipboard

// .fig zip: canvas.fig + images/<hash>
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), saved = [];
const zip = zipSync({ 'canvas.fig': fig, 'images/abcd': png });
const res = importFigma(zip, (name, bytes) => (saved.push([name, bytes.length]), `./images/${name}`));
assert.deepEqual(saved, [['abcd.png', 7]]);
assert.equal(res.pages[0].nodes.find((n) => n.name === 'Photo').fill.url, './images/abcd.png');

// OUT=file.pen writes the result (with the ids the editor's Insert adds), e.g. to validate it with compat.test.mjs
let seq = 0;
const ids = (n) => ({ id: `n${seq++}`, ...n, ...(n.children && { children: n.children.map(ids) }) });
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ version: '2.21', children: res.pages[0].nodes.map(ids) }, null, 2));
console.log('ok    figma import');

// export: a laid-out tree (as the editor sends it) → .fig → import again
const laid = [{ type: 'frame', name: 'Card', x: 10, y: 20, w: 200, h: 120, width: 200, layout: 'vertical', gap: 8, padding: [16, 12], alignItems: 'center', clip: true,
  fill: '#ffffff80', stroke: '#e5e5e5', strokeWidth: 2, strokeAlignment: 'inner', cornerRadius: [8, 8, 0, 0],
  effect: { type: 'shadow', shadowType: 'outer', offset: { x: 0, y: 4 }, blur: 14, color: '#00000040' },
  children: [
    { type: 'text', name: 'Title', x: 12, y: 16, w: 176, h: 24, width: 'fill_container', textGrowth: 'fixed-width', content: 'Olá', fontFamily: 'Inter', fontWeight: '600', fontSize: 20, lineHeight: 1.2, fill: '#111111' },
    { type: 'rectangle', name: 'Bar', x: 12, y: 48, w: 176, h: 8, width: 'fill_container', height: 8,
      fill: { type: 'gradient', gradientType: 'linear', rotation: 270, size: { height: 1 }, colors: [{ color: '#ff0000', position: 0 }, { color: '#0000ff', position: 1 }] } },
    { type: 'path', name: 'Arrow', x: 12, y: 64, w: 20, h: 10, geometry: 'M0 0 L10 10 L20 0 Z', fill: '#00ff00' },
    { type: 'ellipse', name: 'Dot', x: 40, y: 64, w: 10, h: 10, fill: { type: 'image', url: './images/p.png', mode: 'contain' } },
  ] }];
const fig2 = await exportFigma(laid, { name: 'Teste', readImage: (u) => (u === './images/p.png' ? png : undefined) });
const back = importFigma(fig2, (name) => `./images/${name}`).pages;
assert.deepEqual(back.map((p) => p.name), ['Page 1']);
const [c2] = back[0].nodes;
assert.deepEqual({ x: c2.x, y: c2.y, width: c2.width, layout: c2.layout, gap: c2.gap, padding: c2.padding, alignItems: c2.alignItems, clip: c2.clip, fill: c2.fill, stroke: c2.stroke,
  strokeWidth: c2.strokeWidth, strokeAlignment: c2.strokeAlignment, cornerRadius: c2.cornerRadius },
  { x: 10, y: 20, width: 200, layout: 'vertical', gap: 8, padding: [16, 12], alignItems: 'center', clip: true, fill: '#ffffff80', stroke: '#e5e5e5', strokeWidth: 2, strokeAlignment: 'inner', cornerRadius: [8, 8, 0, 0] });
assert.deepEqual(c2.effect, { type: 'shadow', shadowType: 'outer', color: '#00000040', offset: { x: 0, y: 4 }, blur: 14 });
const [title, bar2, arrow, dot] = c2.children;
assert.deepEqual({ content: title.content, fontWeight: title.fontWeight, fontSize: title.fontSize, lineHeight: title.lineHeight, width: title.width, textGrowth: title.textGrowth },
  { content: 'Olá', fontWeight: '600', fontSize: 20, lineHeight: 1.2, width: 'fill_container', textGrowth: 'fixed-width' });
assert.deepEqual({ rotation: bar2.fill.rotation, size: bar2.fill.size, width: bar2.width }, { rotation: 270, size: { height: 1 }, width: 'fill_container' });
assert.equal(arrow.geometry, 'M0 0L10 10L20 0L0 0Z');
assert.deepEqual(dot.fill, { type: 'image', url: `./images/${createHash('sha1').update(png).digest('hex')}.png`, mode: 'contain' });
console.log('ok    figma export (round trip)');
