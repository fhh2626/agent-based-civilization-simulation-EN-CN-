import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const file = path.join(root, 'index.html');
const source = fs.readFileSync(file, 'utf8');
const s = source.replace(/\r\n?/g, '\n');
const errors = [];

function parseString(i) {
  const quote = s[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      if (n === undefined) return null;
      out += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
      j++;
      continue;
    }
    if (c === quote) return { value: out, end: j + 1 };
    out += c;
  }
  return null;
}

function lineAt(i) {
  return s.slice(0, i).split('\n').length;
}

const calls = [];
const re = /\badd\s*\(/g;
let m;
while ((m = re.exec(s))) {
  let i = m.index + m[0].length;
  while (/\s/.test(s[i])) i++;
  const a = parseString(i);
  if (!a) continue;
  i = a.end;
  while (/\s/.test(s[i])) i++;
  if (s[i] !== ',') continue;
  i++;
  while (/\s/.test(s[i])) i++;
  const b = parseString(i);
  if (!b) continue;
  i = b.end;
  while (/\s/.test(s[i])) i++;
  if (s[i] !== ',') continue;
  i++;
  while (/\s/.test(s[i])) i++;
  const c = parseString(i);
  if (!c) continue;
  i = c.end;
  while (/\s/.test(s[i])) i++;
  if (s[i] !== ')') continue;
  calls.push({ line: lineAt(m.index), key: a.value, en: b.value, zh: c.value });
}

const groups = new Map();
for (const call of calls) {
  if (!groups.has(call.key)) groups.set(call.key, []);
  groups.get(call.key).push(call);
}
const duplicateKeys = [...groups.entries()].filter(([, list]) => list.length > 1);
const conflicts = [...groups.entries()].filter(([, list]) => new Set(list.map(x => x.en + '\u0000' + x.zh)).size > 1);

function parseCall(name, argc) {
  const list = [];
  const callRe = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let cm;
  while ((cm = callRe.exec(s))) {
    let i = cm.index + cm[0].length;
    const args = [];
    let ok = true;
    for (let n = 0; n < argc; n++) {
      while (/\s/.test(s[i])) i++;
      const arg = parseString(i);
      if (!arg) { ok = false; break; }
      args.push(arg.value);
      i = arg.end;
      while (/\s/.test(s[i])) i++;
      if (n < argc - 1) {
        if (s[i] !== ',') { ok = false; break; }
        i++;
      }
    }
    if (!ok) continue;
    while (/\s/.test(s[i])) i++;
    if (s[i] !== ')') continue;
    list.push({ line: lineAt(cm.index), args });
  }
  return list;
}

const blockCalls = parseCall('addBlock', 4);
const tourCalls = parseCall('addTour', 6);
const blockGroups = new Map();
for (const call of blockCalls) {
  if (!blockGroups.has(call.args[0])) blockGroups.set(call.args[0], []);
  blockGroups.get(call.args[0]).push(call);
}
const duplicateBlocks = [...blockGroups.entries()].filter(([, list]) => list.length > 1);
const duplicateTourTitles = [...new Set(tourCalls.map(x => x.args[0]))].filter(k => tourCalls.filter(x => x.args[0] === k).length > 1);
const duplicateTourBodies = [...new Set(tourCalls.map(x => x.args[3]))].filter(k => tourCalls.filter(x => x.args[3] === k).length > 1);

if (calls.length < 1000) errors.push(`expected at least 1000 add() entries, found ${calls.length}`);
if (duplicateKeys.length) {
  errors.push(`${duplicateKeys.length} duplicate add() key(s); keep exactly one catalog entry per source`);
  for (const [key, list] of duplicateKeys.slice(0, 12)) {
    errors.push(`  ${JSON.stringify(key)} @ lines ${list.map(x => x.line).join(', ')}`);
  }
}
if (conflicts.length) {
  errors.push(`${conflicts.length} conflicting add() key(s) with different en/zh values`);
}
if (!blockCalls.length) errors.push('expected at least one addBlock() entry');
if (duplicateBlocks.length) {
  errors.push(`${duplicateBlocks.length} duplicate addBlock() key(s); keep exactly one block per key`);
  for (const [key, list] of duplicateBlocks.slice(0, 12)) {
    errors.push(`  ${JSON.stringify(key)} @ lines ${list.map(x => x.line).join(', ')}`);
  }
}
if (!tourCalls.length) errors.push('expected at least one addTour() step');
if (duplicateTourTitles.length) {
  errors.push(`duplicate addTour() title(s): ${duplicateTourTitles.map(k => JSON.stringify(k)).join(', ')}`);
}
if (duplicateTourBodies.length) {
  errors.push(`duplicate addTour() body text: ${duplicateTourBodies.map(k => JSON.stringify(k)).join(', ')}`);
}

function objectKeys(name) {
  const start = s.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = s.indexOf('\n};', start);
  if (end < 0) throw new Error(`unterminated ${name}`);
  const body = s.slice(start, end);
  const out = [];
  const keyRe = /^\s*'((?:[^'\\]|\\.)*)':/gm;
  let km;
  while ((km = keyRe.exec(body))) out.push(km[1]);
  return out;
}

let reasonEn = [], reasonZh = [];
try {
  reasonEn = objectKeys('i18nReasonEn');
  reasonZh = objectKeys('i18nReasonZh');
} catch (e) {
  errors.push(e.message);
}
if (reasonEn.length !== reasonZh.length) errors.push('i18nReasonEn / i18nReasonZh have different key counts');
if (new Set(reasonEn).size !== reasonEn.length) errors.push('i18nReasonEn contains duplicate keys');
if (new Set(reasonZh).size !== reasonZh.length) errors.push('i18nReasonZh contains duplicate keys');
const reasonEnSet = new Set(reasonEn);
for (const key of reasonZh) if (!reasonEnSet.has(key)) errors.push(`dynamic reason key missing from En: ${JSON.stringify(key)}`);
const reasonOverlap = [...reasonEnSet].filter(k => groups.has(k));
if (reasonOverlap.length) {
  errors.push(`dynamic reason keys must not overlap literal add() keys: ${reasonOverlap.map(k => JSON.stringify(k)).join(', ')}`);
}

const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let sm, scripts = 0;
while ((sm = scriptRe.exec(source))) {
  scripts++;
  try {
    new vm.Script(sm[1], { filename: `index.html#script${scripts}` });
  } catch (e) {
    errors.push(`inline script ${scripts} does not parse: ${e.message}`);
  }
}
if (scripts < 2) errors.push(`expected two inline scripts, found ${scripts}`);
if (/\(\?<[=!]/.test(s)) errors.push('lookbehind regex found; target older Safari/Firefox too');

if (errors.length) {
  console.error('i18n check failed:\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`i18n check OK: ${calls.length} add() entries, ${groups.size} unique keys, ${blockCalls.length} blocks, ${tourCalls.length} tour steps, ${reasonEn.length} dynamic reason keys, ${scripts} inline scripts.`);
