// generate_image guards (no Codex call): the path must stay inside the .pen folder, be a new .png, and references must exist.
import assert from 'node:assert/strict';
import { createTools, callTool } from './tools.mjs';
const tools = createTools({ file: '/tmp/pena-guard/a.pen' });
const err = async (args) => (await callTool(tools, 'generate_image', { prompt: 'x', ...args })).content[0].text;
assert.match(await err({ path: '../out.png' }), /outside the \.pen folder/);
assert.match(await err({ path: 'a.jpg' }), /must end in \.png/);
assert.match(await err({ path: 'a.png', references: ['nope.png'] }), /Reference not found/);
console.log('generate-image ok');
