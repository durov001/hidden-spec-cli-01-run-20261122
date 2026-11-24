// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves the edits made, as [old path, new path] pairs, for the R lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its line break, its lines, and whether it ends with a break (SPEC.md section 3). */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A line as one tier sees it (SPEC.md section 5). */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

/** Positions where O occurs in the file's lines at one tier; occurrences may overlap. */
function occurrencesAt(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const keys = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(fileLines[i + j]!, tier) !== keys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; strict: 0 only) at which O occurs, with its occurrences. */
function matchTier(fileLines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(fileLines, o, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** A line of N: a context line names its index in O (written as the file's own line). */
interface NLine {
  text: string;
  ctx?: number;
}

/** N as written at a match: context lines from the file, tier-2 re-indentation for the rest. */
function writeN(fileLines: string[], pos: number, tier: number, o: string[], n: NLine[]): string[] {
  const out: string[] = [];
  const f = tier === 2 && o.length > 0 ? leadingWs(fileLines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]!) : '';
  for (const l of n) {
    if (l.ctx !== undefined) {
      out.push(fileLines[pos + l.ctx]!);
      continue;
    }
    let t = l.text;
    if (tier === 2 && o.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/* Unified diffs (SPEC.md section 6). */

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
  /** The hunk has a `+` line, and a `\` line follows its last one. */
  plusNoNL: boolean;
  plusCount: number;
}

interface Section {
  oldPath: string | null; // null: /dev/null
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` / `+++ ` line names: after the four characters, to the first tab, trimmed. */
function gitPath(raw: string): string | null {
  const p = raw.split('\t', 1)[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function diffGitPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (m === null) return null;
  return [m[1]!, m[2]!];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function hunkA(line: string): number | null {
  const m = HUNK_HEAD.exec(line);
  return m === null ? null : Number(m[1]);
}

/** A hunk's body, from the line after its header; empty lines at its end are not part of it. */
function parseHunkBody(lines: string[], i: number, a: number): { hunk: Hunk; next: number } {
  interface Item {
    kind: 'ctx' | 'old' | 'new' | 'bs';
    text: string;
  }
  const items: Item[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') items.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) items.push({ kind: 'new', text: l.slice(1) });
    else if (l.startsWith('\\')) items.push({ kind: 'bs', text: '' });
    else break;
    j += 1;
  }
  while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.text === '') items.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  const bsAfter = new Set<number>();
  let pending: number | null = null;
  let lastCtxPlus = -1;
  let lastPlus = -1;
  let plusCount = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: o.length - 1 });
      pending = n.length - 1;
      lastCtxPlus = n.length - 1;
    } else if (it.kind === 'old') {
      o.push(it.text);
      pending = null;
    } else if (it.kind === 'new') {
      n.push({ text: it.text });
      pending = n.length - 1;
      lastCtxPlus = n.length - 1;
      lastPlus = n.length - 1;
      plusCount += 1;
    } else {
      if (pending !== null) bsAfter.add(pending);
      pending = null;
    }
  }
  return {
    hunk: {
      a,
      o,
      n,
      noNL: lastCtxPlus >= 0 && bsAfter.has(lastCtxPlus),
      plusNoNL: lastPlus >= 0 && bsAfter.has(lastPlus),
      plusCount,
    },
    next: j,
  };
}

/** A section's header and hunks, from line i; returns the next line to read. */
function parseSectionRest(lines: string[], i: number, sec: Section, isDiffGit: (l: string) => boolean, isPair: (j: number) => boolean): number {
  const n = lines.length;
  let hasPair = false;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (isDiffGit(l)) break;
    if (l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      if (hasPair) break; // a second pair starts a new section
      sec.oldPath = gitPath(l.slice(4));
      sec.newPath = gitPath(lines[i + 1]!.slice(4));
      hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      if (!hasPair) sec.oldPath = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (!hasPair) sec.newPath = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.create = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  while (i < n) {
    const l = lines[i]!;
    if (isDiffGit(l)) break;
    if (isPair(i)) break;
    if (l.startsWith('@@')) {
      const a = hunkA(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunkBody(lines, i + 1, a);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    i += 1;
  }
  return i;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const isDiffGit = (l: string): boolean => l === 'diff --git' || l.startsWith('diff --git ');
  const isPair = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGit(l)) {
      const paths = diffGitPaths(l);
      if (paths === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = {
        oldPath: paths[0] === '/dev/null' ? null : paths[0],
        newPath: paths[1] === '/dev/null' ? null : paths[1],
        create: false,
        del: false,
        hunks: [],
      };
      i = parseSectionRest(lines, i + 1, sec, isDiffGit, isPair);
      sections.push(sec);
      continue;
    }
    if (isPair(i)) {
      const sec: Section = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
      i = parseSectionRest(lines, i, sec, isDiffGit, isPair);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** A section's hunks applied in order, each to the result of the ones before it. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, model.lines.length));
      const atEnd = pos === model.lines.length;
      const ins = h.n.map((l) => l.text);
      model.lines.splice(pos, 0, ...ins);
      if (atEnd) model.final = !h.noNL;
      d += h.n.length;
      continue;
    }
    const m = matchTier(model.lines, h.o, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.at[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of m.at) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === model.lines.length;
    const rep = writeN(model.lines, best, m.tier, h.o, h.n);
    model.lines.splice(best, h.o.length, ...rep);
    if (atEnd) model.final = !h.noNL;
    d += h.n.length - h.o.length;
  }
  return joinFile(model);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.create || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlusNoNL = false;
      for (const h of sec.hunks) {
        for (const l of h.n) {
          if (l.ctx === undefined) plus.push(l.text);
        }
        if (h.plusCount > 0) lastPlusNoNL = h.plusNoNL;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (lastPlusNoNL ? '' : '\n'));
      return;
    }
    if (sec.del || newP === null) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      const t = tree.get(oldP);
      if (t === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(t, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    const t = tree.get(oldP);
    if (t === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(t, sec.hunks, strict, oldP));
  };
}

/* SEARCH/REPLACE blocks (SPEC.md section 7). */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const model = splitFile(t);
    const m = matchTier(model.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.at.length > 1) throw new Fail('ambiguous', path);
    const rep = writeN(
      model.lines,
      m.at[0]!,
      m.tier,
      oldLines,
      newLines.map((text) => ({ text })),
    );
    model.lines.splice(m.at[0]!, oldLines.length, ...rep);
    tree.now.set(path, joinFile(model));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* V4A patches (SPEC.md section 8). */

interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

const isVBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');

/** One V4A chunk's body, from line k; ends at an `@@` line, `*** End of File`, or a non-body line. */
function parseVChunk(body: string[], k: number, anchor: string | null): { chunk: VChunk; next: number } {
  const o: string[] = [];
  const n: NLine[] = [];
  let eof = false;
  let j = k;
  while (j < body.length) {
    const l = body[j]!;
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
      j += 1;
      continue;
    }
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
      j += 1;
      continue;
    }
    if (l.startsWith('-')) {
      o.push(l.slice(1));
      j += 1;
      continue;
    }
    if (l.startsWith('+')) {
      n.push({ text: l.slice(1) });
      j += 1;
      continue;
    }
    if (l.startsWith('@@')) break;
    if (l.trim() === '*** End of File') {
      eof = true;
      j += 1;
      break;
    }
    break;
  }
  return { chunk: { anchor, o, n, eof }, next: j };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, body: string[], bodyStart: number, strict: boolean): Edit {
  let k = 0;
  let moveTo: string | null = null;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: VChunk[] = [];
  while (k < body.length) {
    const l = body[k]!;
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      const { chunk, next } = parseVChunk(body, k + 1, anchorText === '' ? null : anchorText);
      chunks.push(chunk);
      k = next;
      continue;
    }
    if (chunks.length === 0 && isVBodyLine(l)) {
      const { chunk, next } = parseVChunk(body, k, null);
      chunks.push(chunk);
      k = next;
      continue;
    }
    if (blank(l)) {
      k += 1;
      continue;
    }
    throw new Exit2(`error: parse ${bodyStart + k + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${bodyStart}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(t);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let found = -1;
        for (const tier of tiers) {
          const key = tierKey(ch.anchor, tier);
          for (let i = cursor; i < model.lines.length; i += 1) {
            if (tierKey(model.lines[i]!, tier) === key) {
              found = i;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? model.lines.length : cursor;
        const ins = ch.n.map((l) => l.text);
        model.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let foundTier = -1;
      let foundPos = -1;
      for (const tier of tiers) {
        const at = occurrencesAt(model.lines, ch.o, tier).filter((p) => p >= cursor);
        if (ch.eof) {
          const ok = at.filter((p) => p + ch.o.length === model.lines.length);
          if (ok.length > 0) {
            foundTier = tier;
            foundPos = ok[0]!;
            break;
          }
        } else if (at.length > 0) {
          foundTier = tier;
          foundPos = at[0]!;
          break;
        }
      }
      if (foundPos < 0) throw new Fail('no-match', path);
      const rep = writeN(model.lines, foundPos, foundTier, ch.o, ch.n);
      model.lines.splice(foundPos, ch.o.length, ...rep);
      cursor = foundPos + rep.length;
    }
    const out = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) {
      if (lines[j]!.trim() === '*** End Patch' || lines[j]!.trim() === '*** Begin Patch') throw new Exit2(`error: parse ${j + 1}`);
      j += 1;
    }
    let end = j;
    while (end > i + 1 && blank(lines[end - 1]!)) end -= 1;
    const body = lines.slice(i + 1, end);
    const bodyStart = i + 1;
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const c = body[k]!;
        if (c.startsWith('+')) fileLines.push(c.slice(1));
        else if (c === '') fileLines.push('');
        else throw new Exit2(`error: parse ${bodyStart + k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      if (body.length > 0) throw new Exit2(`error: parse ${bodyStart + 1}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      const path = l.slice('*** Update File: '.length).trim();
      edits.push(v4aUpdateEdit(path, body, bodyStart, strict));
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths and their rows: a move that took a file from a path that existed before the patch to one
  // that did not is one `R <old> -> <new>` line, replacing that pair's `D` and `A` lines, sorting by `<new>`.
  interface Row {
    sort: string;
    line: string;
  }
  const rows: Row[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const oldWas = tree.original(oldP);
    const oldNow = tree.now.has(oldP) ? tree.now.get(oldP)! : tree.original(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.now.has(newP) ? tree.now.get(newP)! : tree.original(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ sort: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (suppressed.has(p)) continue;
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)) || Buffer.compare(Buffer.from(a.line), Buffer.from(b.line)));
  if (!check) {
    for (const p of changed.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
