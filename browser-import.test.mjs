// pen.dev browser extension paste: clipboard decoding and DOM snapshot → .pen nodes.
import assert from 'node:assert/strict';
import { findPayload, importBrowserSnapshot, color } from './browser-import.mjs';

// Chrome's `setData` pickle, as found on the macOS pasteboard
const str16 = (s) => { const b = Buffer.alloc(4 + ((s.length * 2 + 3) & ~3)); b.writeUInt32LE(s.length); b.write(s, 4, 'utf16le'); return b; };
const body = Buffer.concat([Buffer.from([2, 0, 0, 0]), str16('text/x-other'), str16('nope'), str16('web application/vnd.pen.dev.browser-import+json'), str16('{"version":1}')]);
const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
assert.equal(findPayload({ 'org.chromium.web-custom-data': Buffer.concat([head, body]) }), '{"version":1}');
// the async clipboard API's map + per-type entry
assert.equal(findPayload({ 'org.w3.web-custom-format.map': Buffer.from('{"application/vnd.pen.dev.browser-import+json":"org.w3.web-custom-format.type-0"}'), 'org.w3.web-custom-format.type-0': Buffer.from('{"x":1}') }), '{"x":1}');
assert.equal(findPayload({}), null);

assert.equal(color('rgb(255, 0, 0)'), '#ff0000');
assert.equal(color('rgba(0, 0, 0, 0.5)'), '#00000080');
assert.equal(color('rgba(0, 0, 0, 0)'), undefined);
assert.equal(color('oklch(1 0 0)'), '#ffffff');
assert.equal(color('oklch(0.628 0.2577 29.23)'), '#ff0000');

const saved = [];
const style = (o) => ({ display: 'block', ...o });
const { pages } = importBrowserSnapshot({
  version: 1,
  snapshot: {
    url: 'https://example.com/', viewport: { w: 800, h: 600 }, dpr: 2, pageBackground: 'rgb(255, 255, 255)',
    root: { tag: 'DIV', rect: { x: 100, y: 50, w: 300, h: 200 }, style: style({ backgroundColor: 'rgb(240, 240, 240)', borderTopLeftRadius: '8px', borderTopRightRadius: '8px', borderBottomRightRadius: '8px', borderBottomLeftRadius: '8px' }), children: [
      { tag: 'DIV', rect: { x: 110, y: 60, w: 280, h: 40 }, style: style({}), children: [ // wrapper: dropped, children hoisted
        { tag: 'H1', rect: { x: 110, y: 60, w: 280, h: 40 }, text: '  Hello\n  world ', textRect: { x: 110, y: 62, w: 120.4, h: 36 }, isTextLeaf: true, children: [],
          style: style({ color: 'rgb(17, 17, 17)', fontFamily: '"Inter", sans-serif', fontSize: '24px', fontWeight: '700', lineHeight: '36px' }) },
      ] },
      { tag: 'IMG', rect: { x: 110, y: 110, w: 100, h: 50 }, imageSrc: '/a.png', style: style({ objectFit: 'contain' }), children: [] },
      { tag: 'BUTTON', rect: { x: 220, y: 110, w: 80, h: 30 }, style: style({ borderTopStyle: 'solid', borderTopWidth: '1px', borderTopColor: 'rgb(0, 0, 0)', borderRightStyle: 'solid', borderRightWidth: '1px', borderBottomStyle: 'solid', borderBottomWidth: '1px', borderLeftStyle: 'solid', borderLeftWidth: '1px', boxShadow: 'rgba(0, 0, 0, 0.25) 0px 2px 4px 0px' }), children: [] },
      { tag: 'DIV', rect: { x: 0, y: 0, w: 10, h: 10 }, style: style({ display: 'none', backgroundColor: 'red' }), children: [] },
    ] },
  },
  images: [{ url: 'https://example.com/a.png', contentType: 'image/png', base64: Buffer.from('png').toString('base64') }],
  fonts: [],
}, (name, data) => (saved.push([name, data.toString()]), `./images/${name}`));

const [root] = pages[0].nodes;
assert.deepEqual({ ...root, children: undefined }, { type: 'frame', name: 'div', x: 0, y: 0, width: 300, height: 200, layout: 'none', fill: '#f0f0f0', cornerRadius: 8, clip: true, children: undefined });
const [h1, img, button] = root.children;
assert.deepEqual(h1, { type: 'text', content: 'Hello world', x: 10, y: 12, textGrowth: 'fixed-width', width: 121.4, fontFamily: 'Inter', fontSize: 24, fill: '#111111', fontWeight: '700', lineHeight: 1.5 });
assert.deepEqual(img, { type: 'rectangle', name: 'img', x: 10, y: 60, width: 100, height: 50, fill: { type: 'image', url: './images/web-1.png', mode: 'contain' } });
assert.deepEqual(saved, [['web-1.png', 'png']]);
assert.equal(button.stroke, '#000000');
assert.equal(button.strokeWidth, 1);
assert.deepEqual(button.effect, { type: 'shadow', shadowType: 'outer', color: '#00000040', offset: { x: 0, y: 2 }, blur: 4 });
assert.equal(root.children.length, 3);
console.log('browser-import ok');
