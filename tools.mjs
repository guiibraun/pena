// The agent tools, mirroring pen.dev's MCP surface (execute, get_app_state, read_skill, spawn_agents).
// Implemented once; the server runs them in-process (so parallel agents' edits are serialized) and
// mcp.mjs either proxies to the server or, standalone, runs them directly without the editor-only features.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createApi, execute, load, readSkill } from './doc.mjs';

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
      'Returns its full subtree with variables and component instances resolved, plus a screenshot when that file is open in the app. ' +
      'Use it whenever the user pastes a pena:// link, e.g. to implement that design in code.',
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
      const frames = doc.children.map((n) => ({ id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height, ...(n.reusable && { reusable: true }), ...(n.placeholder && { placeholder: true }), ...(rects[n.id] && { rendered: { width: rects[n.id].w, height: rects[n.id].h } }) }));
      const summary = {
        file,
        selection: state.selection ?? [],
        themes: doc.themes ?? {},
        variables: Object.keys(doc.variables ?? {}).length,
        topLevel: frames,
      };
      return [text(JSON.stringify(summary, null, 1)), text(`<execute-documentation>\n${readSkill('execute.md')}\n\n${readSkill('schema.md')}\n</execute-documentation>`)];
    },

    // The link names its own file, so it works on any .pen, open or not (screenshots only for the open one).
    async get_node({ link }) {
      const url = URL.parse(link?.trim() ?? '');
      const id = url && decodeURIComponent(url.pathname.slice(1)), file = url?.searchParams.get('file');
      if (url?.protocol !== 'pena:' || url.host !== 'node' || !id || !file) throw new Error('Expected a link like pena://node/<id>?file=/path/to/file.pen');
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const node = createApi(load(file)).Get(id, { resolveVariables: true, resolveInstances: true });
      const content = [text(`${file}\n${JSON.stringify(node, null, 1)}`)];
      if (env.render && path.resolve(file) === current()) content.push(...(await png(id).catch((e) => [text(`No screenshot: ${e.message}`)])));
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
