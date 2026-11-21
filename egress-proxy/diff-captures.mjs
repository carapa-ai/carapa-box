#!/usr/bin/env node
// diff-captures.mjs — compare two RAW llama-debug-proxy capture bodies and
// pinpoint the byte offset where prefix drift starts. Operates on the raw
// .body files written by llama-debug-proxy.mjs (NOT the .json metadata) so
// the diff sees exactly the bytes that hit the wire.
//
// Usage:
//   node diff-captures.mjs                            # auto: two newest .body in ./captures/
//   node diff-captures.mjs <old.body> <new.body>
//   node diff-captures.mjs <old.json> <new.json>      # auto-swapped to .body
//   node diff-captures.mjs <dir>                      # two newest in <dir>

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function pickNewest(dir) {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.body'))
    .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t)
    .map(x => join(dir, x.f));
  if (files.length < 2) throw new Error(`need ≥2 .body files in ${dir}, found ${files.length}`);
  return files.slice(-2);
}

const resolveBody = p => p.endsWith('.json') ? p.replace(/\.json$/, '.body') : p;

let [, , arg1, arg2] = process.argv;
let aPath, bPath;
try {
  if (!arg1) {
    [aPath, bPath] = pickNewest('./captures');
  } else if (!arg2 && statSync(arg1).isDirectory()) {
    [aPath, bPath] = pickNewest(arg1);
  } else if (arg1 && arg2) {
    aPath = resolveBody(arg1);
    bPath = resolveBody(arg2);
  } else {
    throw new Error('bad args');
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  console.error('usage: diff-captures.mjs [<old.body> <new.body> | <dir>]');
  process.exit(2);
}

const A = readFileSync(aPath);
const B = readFileSync(bPath);

console.log(`A (older):  ${aPath}  (${A.length}B)`);
console.log(`B (newer):  ${bPath}  (${B.length}B)\n`);

// ── byte-level LCP on RAW buffers — this is the ground truth ──
function bufLCP(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
  return len;
}

const lcp = bufLCP(A, B);
console.log('── byte-level prefix match (raw bytes, what the wire saw) ──');
console.log(`  LCP: ${lcp} bytes  (${(lcp / Math.min(A.length, B.length) * 100).toFixed(2)}% of shorter file)`);
console.log(`  divergence at byte ${lcp} of ${A.length}/${B.length}`);
console.log(`  ≈ token offset: ${Math.round(lcp / 3.5)}  (chars/3.5 rough; check vs llama.cpp's n_past)\n`);

// ── context window around divergence ──
function showContext(buf, at, w = 200) {
  const start = Math.max(0, at - w);
  const end = Math.min(buf.length, at + w);
  const before = buf.slice(start, at).toString('utf8');
  const after = buf.slice(at, end).toString('utf8');
  const safe = s => s.replace(/[\x00-\x1f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  return `${safe(before)}⟦HERE⟧${safe(after)}`;
}

console.log('── context around divergence (±200B) ──');
console.log(`  A:  …${showContext(A, lcp)}…`);
console.log(`  B:  …${showContext(B, lcp)}…\n`);

// ── structural hint: if both bodies parse as JSON, identify which top-level field & message diverges ──
let jA, jB;
try { jA = JSON.parse(A.toString('utf8')); } catch {}
try { jB = JSON.parse(B.toString('utf8')); } catch {}

if (jA && jB) {
  console.log('── structural hint (parsed JSON — secondary view) ──');
  const keys = new Set([...Object.keys(jA), ...Object.keys(jB)]);
  const stable = [];
  const drifted = [];
  for (const k of keys) {
    const va = JSON.stringify(jA[k]);
    const vb = JSON.stringify(jB[k]);
    (va === vb ? stable : drifted).push(k);
  }
  console.log(`  stable keys:   ${stable.join(', ') || '(none)'}`);
  console.log(`  drifted keys:  ${drifted.join(', ') || '(none)'}`);
  if (drifted.includes('messages')) {
    const ma = jA.messages ?? [], mb = jB.messages ?? [];
    console.log(`\n  messages: A=${ma.length}  B=${mb.length}`);
    const maxI = Math.max(ma.length, mb.length);
    for (let i = 0; i < maxI; i++) {
      const a = ma[i], b = mb[i];
      if (!a) { console.log(`    [${i}] only in B (role=${b.role})`); continue; }
      if (!b) { console.log(`    [${i}] only in A (role=${a.role})`); continue; }
      const sa = JSON.stringify(a), sb = JSON.stringify(b);
      if (sa === sb) {
        console.log(`    [${i}] ${a.role}: identical (${sa.length}B serialized)`);
      } else {
        let common = 0;
        const m = Math.min(sa.length, sb.length);
        while (common < m && sa[common] === sb[common]) common++;
        console.log(`    [${i}] ${a.role}: DIFFERS at char ${common} (A=${sa.length}B  B=${sb.length}B)`);
      }
    }
  }
  for (const k of drifted) {
    if (k === 'messages') continue;
    const la = JSON.stringify(jA[k] ?? null).length;
    const lb = JSON.stringify(jB[k] ?? null).length;
    console.log(`\n  ${k}: A=${la}B  B=${lb}B`);
  }
}
