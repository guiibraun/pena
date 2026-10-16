// Compatibility check against pen.dev's own JSON Schema (read from your local Pen install; not shipped with Pena).
// Every document Pena writes must validate, so pen.dev can open it.
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { migrate } from './public/pen-core.js';

const SCHEMA = process.env.PEN_SCHEMA ?? '/tmp/pen-extract/app/node_modules/@ha/schema/pen.schema.json';
if (!fs.existsSync(SCHEMA)) {
  console.log(`skip: pen.dev schema not found at ${SCHEMA}`);
  process.exit(0);
}
// pen.dev's schema uses oneOf where a "$var" string matches two branches (their validator is custom-generated);
// anyOf keeps the same constraints without that ambiguity.
const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8').replaceAll('"oneOf"', '"anyOf"'));
// Their generator merges `allOf` parts that each say additionalProperties:false; in plain JSON Schema that rejects
// everything. Equivalent: drop it from the parts, and close the merged type with unevaluatedProperties:false.
const parts = new Set(Object.values(schema.$defs).flatMap((d) => (d.allOf ?? []).map((r) => r.$ref?.split('/').pop())));
for (const [name, d] of Object.entries(schema.$defs)) {
  if (parts.has(name)) delete d.additionalProperties;
  if (d.allOf && d.additionalProperties === false) delete d.additionalProperties, (d.unevaluatedProperties = false);
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema({ ...schema, $id: 'pen' });
const byType = {};
const nodeValidator = (type) => (byType[type] ??= ajv.compile({ $ref: `pen#/$defs/${type}` }));
const docShape = ajv.compile({ ...schema, $id: 'pen-doc', properties: { ...schema.properties, children: { type: 'array' } } });

// Validate the document shell, then every node on its own (children and override subtrees checked separately).
function check(doc) {
  const errors = [];
  if (!docShape(doc)) errors.push(...docShape.errors.map((e) => `(document)${e.instancePath} ${e.message}`));
  const walk = (n, at) => {
    const { children, descendants, ...own } = n;
    const v = nodeValidator(n.type);
    const shell = { ...own, ...(children && { children: [] }), ...(descendants && { descendants: {} }) };
    if (!$defsHas(n.type)) errors.push(`${at} unknown type ${n.type}`);
    else if (!v(shell)) errors.push(...v.errors.filter((e) => e.keyword !== 'anyOf').map((e) => `${at}${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`));
    children?.forEach((c, i) => walk(c, `${at}/${c.name ?? c.id}`));
    for (const [k, o] of Object.entries(descendants ?? {})) if (o.type) walk({ id: k.split('/').pop(), ...o }, `${at}{${k}}`);
  };
  doc.children.forEach((c) => walk(c, `/${c.name ?? c.id}`));
  return [...new Set(errors)];
}
const $defsHas = (t) => !!schema.$defs[t];

const files = [...process.argv.slice(2)];
if (!files.length) {
  const dir = '/tmp/pen-extract/app/out/data';
  if (fs.existsSync(dir)) files.push(...fs.readdirSync(dir).filter((f) => f.endsWith('.pen')).map((f) => `${dir}/${f}`));
  files.push(...fs.readdirSync('examples').filter((f) => f.endsWith('.pen')).map((f) => `examples/${f}`));
}
let failed = 0;
const summary = new Map();
for (const f of files) {
  const errors = check(migrate(JSON.parse(fs.readFileSync(f, 'utf8'))));
  if (!errors.length) { console.log(`ok    ${f}`); continue; }
  if (process.env.SUMMARY) { for (const e of errors) { const m = /(\/[\w]+)? (must .*?) (\{.*\})?$/.exec(e.replace(/^.*?(\/(effect|fill|stroke|strokeWidth|descendants)[^ ]*)? must/, '$1 must')); summary.set(m?.[0] ?? e, (summary.get(m?.[0] ?? e) ?? 0) + 1); } }
  failed++;
  console.log(`FAIL  ${f} (${errors.length})\n${errors.slice(0, 8).map((e) => `      ${e}`).join('\n')}`);
}
if (process.env.SUMMARY) console.log([...summary].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}\t${k}`).join('\n'));
process.exit(failed ? 1 : 0);
