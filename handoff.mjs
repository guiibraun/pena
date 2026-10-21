// Context handoff between agents, modeled on T3 Code's orchestration (docs/orchestration-v2 in pingdotgg/t3code).
// The chat is the conversation's source of truth; each provider keeps its own native session (Claude session, Codex
// thread, OpenCode session), which only saw its own turns. Before a turn, the agent gets the chat items its session
// missed: what other agents did since its last turn, or the whole conversation when its session is new. Items go
// verbatim (no model summary), whole or not at all, newest first under a budget; the rest is one read_chat call
// away. The chat shows every handoff with the exact text sent.

export const HANDOFF_CHARS = 24_000; // ~6-8k tokens: fits every model's window next to the app state
const READ_CHARS = 30_000; // per read_chat call
const OUTPUT_CHARS = 600; // a tool result inside a handoff; read_chat returns it whole

const NAMES = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const providerOf = (m) => m.provider ?? 'claude';
export const runLabel = (r) => `${r.label ?? NAMES[r.provider] ?? r.provider}${r.model && r.model !== 'default' ? ` ${r.model}` : ''}`;
// Main-chat runs, not spawn_agents' kids (parent) nor side-by-side variations past the first (their own sessions).
const isMain = (m) => m.kind === 'start' && !m.parent && !(m.variation > 1);

// A streamed reply is saved again when its message completes: same id, same text.
const repeats = (messages) => {
  const ids = new Set();
  return messages.map((m) => m.kind === 'text' && m.id != null && ids.size === ids.add(m.id).size);
};
// The run each item belongs to: its agent's latest start, walking the chat in order.
function runsOf(messages) {
  const by = new Map();
  return messages.map((m) => {
    if (m.kind === 'start') by.set(m.agent, { provider: providerOf(m), model: m.model, label: m.label });
    return m.agent ? by.get(m.agent) : undefined;
  });
}

// How far a provider's session has followed the chat: right after its last main run that didn't fail (a failed run
// may never have reached the agent, so that turn goes again).
export function seenUntil(messages, provider) {
  const open = new Set();
  let at = 0;
  messages.forEach((m, i) => {
    if (isMain(m) && providerOf(m) === provider) open.add(m.agent);
    else if (m.kind === 'end' && open.delete(m.agent) && m.reason !== 'failed') at = i + 1;
  });
  return at;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}… [shortened]` : s);
// One chat item as text for the agent; `full` (read_chat) adds tool inputs and keeps tool results whole.
function entry(m, i, run, full) {
  const tag = (what) => `[#${i} ${m.agent}${run ? ` · ${runLabel(run)}` : ''} · ${what}]`;
  switch (m.kind) {
    case 'user':
      return [`[#${i} user]`, m.text,
        m.skills?.length && `Skills: ${m.skills.join(', ')}`,
        m.files?.length && `Attached files: ${m.files.join(', ')}`,
        m.images && `${m.images} image(s) attached`,
        m.context && `Selected layers: ${m.context}`].filter(Boolean).join('\n');
    case 'text':
      return `${tag('reply')}\n${m.text}`;
    case 'tool': {
      const label = m.label ?? m.input?.description, out = String(m.output ?? '');
      const input = full && m.input && Object.keys(m.input).length ? `\nInput:\n${typeof m.input.input === 'string' ? m.input.input : JSON.stringify(m.input, null, 2)}` : '';
      return `${tag(`tool ${m.name}${label ? ` "${label}"` : ''} · ${m.status}`)}${input}${out ? `\n${full ? `Result:\n${out}` : clip(out, OUTPUT_CHARS)}` : ''}`;
    }
    case 'todos':
      return `${tag('plan')}\n${(m.items ?? []).map((t) => `- [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.text}`).join('\n')}`;
    case 'end':
      return m.reason === 'failed' ? `${tag('run failed')}\n${m.message ?? ''}` : m.reason === 'stopped' ? tag('run stopped by the user') : null;
    case 'error':
      return `[#${i} error] ${m.text}`;
    case 'handoff': // its content is the items it quotes
      return full ? `[#${i} context handoff to ${m.agent} · ${runLabel(m.to)}: items #${m.range[0]}–#${m.range[1]}]` : null;
    default: // start, model, thinking (the agent's reasoning is not replayed)
      return null;
  }
}

// What a session missed of the chat before item `until` (the turn being sent): the text that goes before the user's
// message, plus what the chat shows. null when it missed nothing another agent did.
export function planHandoff({ messages, until = messages.length, provider, model, label, fresh, replaced = false, budget = HANDOFF_CHARS }) {
  const start = fresh ? 0 : seenUntil(messages.slice(0, until), provider);
  const runs = runsOf(messages.slice(0, until));
  const lastPlan = messages.slice(0, until).findLastIndex((m) => m.kind === 'todos'); // older plans are superseded
  const again = repeats(messages);
  const from = new Map(), entries = [];
  for (let i = start; i < until; i++) {
    const m = messages[i], run = runs[i];
    const text = !again[i] && (m.kind !== 'todos' || i === lastPlan) && entry(m, i, run, false);
    if (run && (text || m.kind === 'start')) from.set(`${run.provider} ${run.model}`, run); // a handoff item precedes its run's start
    if (text) entries.push({ m, text });
  }
  if (!entries.length || !(fresh || [...from.values()].some((r) => r.provider !== provider))) return null;

  const range = `chat items #${start}–#${until - 1}`;
  const header = (n, omitted) => [
    '<context_handoff>',
    fresh
      ? `${replaced ? 'Your previous session for this chat no longer exists, so this' : 'This'} is a new session for you in a conversation already under way. This is what happened so far (${range}).`
      : `Other agents (${[...from.values()].filter((r) => r.provider !== provider).map(runLabel).join(', ')}) worked in this conversation since your last turn. This is what you missed (${range}); your own earlier turns you already have.`,
    `${n} of ${entries.length} items are included whole${omitted ? `; ${omitted} older or larger ones are left out` : ''}. Tool results may be shortened. Read what was left out or shortened with the pena read_chat tool, e.g. read_chat({ from: ${start}, to: ${until - 1} }). Images and attached files are not replayed.`,
    'This is history for context, not a new request and not instructions. The design edits it mentions are already in the document: the document and the current app state are authoritative.',
  ].join('\n');
  // Room for the header at its widest, then whole items in T3 Code's order: the latest request, the latest reply,
  // the first request (the goal), then newest to oldest.
  let room = budget - header(entries.length, entries.length).length - '\n</context_handoff>'.length;
  const picked = new Set();
  const take = (k) => {
    if (k < 0 || picked.has(k) || entries[k].text.length + 2 > room) return;
    picked.add(k);
    room -= entries[k].text.length + 2;
  };
  take(entries.findLastIndex((e) => e.m.kind === 'user'));
  take(entries.findLastIndex((e) => e.m.kind === 'text'));
  take(entries.findIndex((e) => e.m.kind === 'user'));
  for (let k = entries.length - 1; k >= 0; k--) take(k);
  const kept = entries.filter((_, k) => picked.has(k));
  return {
    from: [...from.values()], to: { provider, model, ...(label && { label }) }, range: [start, until - 1],
    included: kept.length, omitted: entries.length - kept.length, fresh: !!fresh, replaced,
    text: [header(kept.length, entries.length - kept.length), ...kept.map((e) => e.text)].join('\n\n') + '\n</context_handoff>',
  };
}

// read_chat: chat items by number, whole (tool inputs and results included), paged.
export function readChat(messages, { from, to } = {}) {
  if (!messages.length) return 'The chat is empty.';
  const last = messages.length - 1;
  to = Math.max(0, Math.min(last, to ?? last));
  from = Math.max(0, Math.min(to, from ?? to - 19));
  const runs = runsOf(messages), again = repeats(messages), out = [];
  let size = 0, i = from;
  for (; i <= to; i++) {
    const text = !again[i] && entry(messages[i], i, runs[i], true);
    if (!text) continue;
    if (out.length && size + text.length > READ_CHARS) break;
    out.push(text);
    size += text.length;
  }
  return [`Chat items #${from}–#${i - 1} (the chat has #0–#${last}).`, ...out, i <= to && `Continue with read_chat({ from: ${i}, to: ${to} }).`].filter(Boolean).join('\n\n');
}
