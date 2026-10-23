// The agent tools, mirroring pen.dev's MCP surface (execute, get_app_state, read_skill, spawn_agents).
// Implemented once; the server runs them in-process (so parallel agents' edits are serialized) and
// mcp.mjs either proxies to the server or, standalone, runs them directly without the editor-only features.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createApi, execute, load, readSkill } from './doc.mjs';
import { flowOf, indexNodes, isConnection } from './public/pen-core.js';

export const schemas = {
  execute: {
    description:
      'Run a JavaScript snippet that reads or edits the open .pen design (Insert/Update/Copy/Replace/Move/Delete/Get/' +
      'SetVariables/FindEmptySpace/TakeScreenshot/Export...). Atomic: if it throws nothing is saved, and the error gives an ' +
      'editId — fix it with `edits` instead of resending. Call get_app_state first if you do not have the execute documentation.',
    inputSchema: {
      description: z.string().optional().describe('Label shown to the user: 3-8 words, imperative, e.g. "Add pricing section with 3 tiers". Write it first.'),
      input: z.string().optional().describe('The JavaScript snippet. Required unless `edits` is provided.'),
      edits: z.array(z.object({ find: z.string(), replace: z.string(), all: z.boolean().optional() })).optional()
        .describe('Patch the failed snippet: each `find` (exact text) is replaced by `replace`, in order, then it re-runs. Requires editId.'),
      editId: z.string().optional().describe('The id printed in the failure message of the snippet to patch. Only with `edits`.'),
      filePath: z.string().optional().describe('Ignored; Pena edits the open file.'),
    },
  },
  get_app_state: {
    description: 'Current state of the Pena app: open file, user selection, themes, top-level frames, and the execute documentation. Call it before starting a task.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  get_node: {
    description:
      'Read the node a Pena link points to (pena://node/<id>?file=<path>, copied in Pena with ⌘L or "Copiar link para o agente"). ' +
      'Returns its full subtree with component instances expanded and exact path geometry, the components and variables ($name) it uses, ' +
      'plus a screenshot when that file is open in the app. ' +
      'Also follows the prototype flow: screens linked to this node by connections (other states of the same UI: modal open, tab ' +
      'selected, step 2…), with how they are reached and their screenshots. ' +
      'Use it whenever the user pastes a pena:// link. To implement it in code, first read_skill({ path: "guide/code.md" }).',
    inputSchema: { link: z.string().describe('The pena:// link, as pasted.') },
    annotations: { readOnlyHint: true },
  },
  read_skill: {
    description: 'Read the Pena design skill. read_skill() lists all files and returns SKILL.md; read_skill({ path }) returns one file, e.g. "guide/mobile-app.md".',
    inputSchema: { path: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  read_chat: {
    description:
      'Read items of the Pena chat conversation by number: user messages, agent replies, plans and tool calls with their scripts and results. ' +
      'Use it when a context handoff left items out or shortened them, or to recall an earlier turn. Without arguments: the last 20 items.',
    inputSchema: {
      from: z.number().int().optional().describe('First item number (#n in the handoff).'),
      to: z.number().int().optional().describe('Last item number, inclusive.'),
    },
    annotations: { readOnlyHint: true },
  },
  spawn_agents: {
    description:
      'Split a large design task across extra designer agents running in parallel (multiple screens, sections, variations). ' +
      'Create one less agent than parts: you do the last part yourself. Create the container frames first (with placeholder: true), ' +
      'then give each agent its own containerNodes so they never edit the same nodes.',
    inputSchema: {
      config: z.array(z.object({ prompt: z.string(), containerNodes: z.array(z.string()) })).describe('One entry per extra agent.'),
      filePath: z.string().optional(),
    },
  },
};

const text = (t) => ({ type: 'text', text: t });
// Connections in a readable form; dangling ones (an end that no longer exists) are skipped.
function flows(doc, list = doc.children.filter(isConnection)) {
  const api = createApi(doc), index = indexNodes(doc);
  const end = (p) => {
    try { return { id: p, name: (index.get(p)?.node ?? api.Get(p, { depth: 0 })).name ?? p }; } catch { return null; } // instance paths: expanded
  };
  return list.map((c) => ({ id: c.id, from: end(c.source?.path), to: end(c.target?.path), ...(c.context && { context: c.context }) }))
    .filter((c) => c.from && c.to)
    .map((c) => ({ ...c, text: `"${c.from.name}" (${c.from.id}) → "${c.to.name}" (${c.to.id})${c.context ? `: ${c.context}` : ''}` }));
}

// env: { file: string | () => string, render?(req) -> Promise, state?() -> object, spawn?(config) -> string, chat?(range) -> string }
export function createTools(env) {
  const current = () => (typeof env.file === 'function' ? env.file() : env.file);
  // the screenshot, plus why a shader in it is not drawn (load/compile errors), if any
  const png = async (id) => {
    const [shot] = await env.render({ ids: [id], format: 'png', options: { scale: 1 } });
    return [{ type: 'image', data: shot.data.split(',')[1], mimeType: 'image/png' }, ...(shot.warnings?.length ? [text(shot.warnings.join('\n'))] : [])];
  };
  return {
    async execute(args) {
      const file = current();
      const { _agent, _conv, _file, ...input } = args;
      const { text: out, host, touched } = execute(file, input, env.state?.().rects);
      if (touched.length) env.touched?.(_agent, touched);
      const content = [text(out)];
      if (host.screenshots?.length) {
        if (!env.render) content.push(text('TakeScreenshot needs the Pena editor open in a browser.'));
        else
          for (const id of host.screenshots) content.push(...(await png(id)));
      }
      for (const job of host.exports ?? []) {
        if (!env.render) {
          content.push(text(`Export to ${job.outputPath} needs the Pena editor open in a browser.`));
          continue;
        }
        const results = await env.render(job);
        // Same as pen.dev: outputPath is a folder and each node is written as <id>.<ext>.
        const dir = path.resolve(path.dirname(file), job.outputPath);
        const ext = { 'html-css': 'html', 'html-tailwind': 'html' }[job.format] ?? job.format;
        const written = results.map((r) => {
          const target = path.join(dir, `${r.id.replaceAll('/', '_')}.${ext}`);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(target, r.data.startsWith('data:') ? Buffer.from(r.data.split(',')[1], 'base64') : r.data);
          return target;
        });
        content.push(text(`Exported ${job.format}: ${written.join(', ')}`));
      }
      return content;
    },

    async get_app_state() {
      const file = current();
      const doc = load(file);
      const state = env.state?.() ?? {}, rects = state.rects ?? {};
      const frames = doc.children.filter((n) => !isConnection(n)).map((n) => ({ id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height, ...(n.reusable && { reusable: true }), ...(n.placeholder && { placeholder: true }), ...(rects[n.id] && { rendered: { width: rects[n.id].w, height: rects[n.id].h } }) }));
      const summary = {
        file,
        selection: state.selection ?? [],
        themes: doc.themes ?? {},
        variables: Object.keys(doc.variables ?? {}).length,
        topLevel: frames,
        ...(flows(doc).length && { connections: flows(doc).map((c) => c.text) }), // prototype links between layers
      };
      return [text(JSON.stringify(summary, null, 1)), text(`<execute-documentation>\n${readSkill('execute.md')}\n\n${readSkill('schema.md')}\n</execute-documentation>`)];
    },

    // The link names its own file, so it works on any .pen, open or not (screenshots only for the open one).
    async get_node({ link }) {
      const url = URL.parse(link?.trim() ?? '');
      const id = url && decodeURIComponent(url.pathname.slice(1)), file = url?.searchParams.get('file');
      if (url?.protocol !== 'pena:' || url.host !== 'node' || !id || !file) throw new Error('Expected a link like pena://node/<id>?file=/path/to/file.pen');
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const doc = load(file), api = createApi(doc);
      // Variables stay as "$name" (design tokens for the code); their values, per theme, are listed below the tree.
      const node = api.Get(id, { resolveInstances: true, includePathGeometry: true });
      const { variables = {}, themes } = api.GetVariables();
      const used = Object.fromEntries([...new Set(JSON.stringify(node).match(/(?<=")\$[^"]+(?=")/g) ?? [])]
        .map((v) => [v.slice(1), variables[v.slice(1)]]).filter(([, def]) => def));
      // The resolved tree hides component boundaries; list the instances (from the raw tree) so code can reuse them.
      const uses = new Map();
      api.Get(id, (n) => (n.type === 'ref' ? n : undefined)).forEach((n) => uses.set(n.ref, [...(uses.get(n.ref) ?? []), n]));
      const comps = [...uses].map(([ref, insts]) => {
        let name = '?';
        try { name = api.Get(ref).name; } catch {}
        const list = insts.map((i) => `${i.id}${i.descendants ? ` (overrides: ${Object.entries(i.descendants).map(([k, v]) => (v.enabled === false ? `${k} hidden` : k)).join(', ')})` : ''}`);
        return `- "${name}" pena://node/${encodeURIComponent(ref)}?file=${encodeURIComponent(file)}: ${insts.length}× ${list.join('; ')}`;
      });
      const content = [text(`${file}\n${JSON.stringify(node, null, 1)}`)];
      if (Object.keys(used).length) content.push(text(`Variables used (${themes ? `themes: ${JSON.stringify(themes)}` : 'no themes'}):\n${JSON.stringify(used, null, 1)}`));
      if (comps.length) content.push(text(`Component instances in this node (ids match the tree above; read a component with get_node):\n${comps.join('\n')}`));
      const open = env.render && path.resolve(file) === current();
      if (open) content.push(...(await png(id).catch((e) => [text(`No screenshot: ${e.message}`)])));
      const flow = flowOf(doc, id);
      if (flow.connections.length) {
        const link = (nid) => `pena://node/${encodeURIComponent(nid)}?file=${encodeURIComponent(file)}`;
        content.push(text(
          'Prototype flow: the user linked these layers on the canvas (source → target). Implement every link as the interaction it ' +
          'describes: the source triggers the target (a button opens the modal, a tab switches the content, a link goes to the next ' +
          'step). A target that is a variant of the same screen (modal open, item selected, empty/error state) is a state of the same ' +
          'code, not a new page. Read each linked screen with get_node for its exact values.\n' +
          flows(doc, flow.connections).map((c) => `- ${c.text}\n  target: ${link(c.to.id)}`).join('\n')));
        if (open)
          for (const s of flow.screens.filter((s) => s !== id))
            content.push(text(`Screenshot of screen "${api.Get(s).name ?? s}" (${s}) in this flow:`), ...(await png(s).catch((e) => [text(`No screenshot: ${e.message}`)])));
      }
      return content;
    },

    async read_skill({ path: rel }) {
      return [text(readSkill(rel))];
    },

    async read_chat(args) {
      if (!env.chat) return [text('read_chat is only available inside the Pena app.')];
      return [text(env.chat(args, { conv: args?._conv, file: args?._file }))];
    },

    async spawn_agents({ config, _agent, _conv }) {
      if (!env.spawn) return [text('spawn_agents is only available inside the Pena app.')];
      return [text(env.spawn(config, { agent: _agent, conv: _conv }))];
    },
  };
}

// Normalize a tool call to MCP content; errors become isError results the agent can act on.
export async function callTool(tools, name, args) {
  try {
    if (!tools[name]) throw new Error(`Unknown tool ${name}`);
    return { content: await tools[name](args ?? {}) };
  } catch (e) {
    return { content: [text(String(e.message ?? e))], isError: true };
  }
}
