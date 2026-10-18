// scanrepo format v1 (format 1.1) in plain JavaScript: git object hashing,
// the .scanrepo master, chunking, QR payloads, and restore/verify.
// Byte-compatible with fitzyracing1/scanrepo-action (scanrepo/core.py).

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
export const utf8 = (s) => enc.encode(s);
export const text = (b) => dec.decode(b);
export const BANNER = '# scanrepo v1';
export const FORMAT = '1.1';
export const PAYLOAD_TAG = 'scanrepo1';
export const REQUIRED_META = ['repo', 'edition', 'branch', 'commit', 'tree', 'parent', 'pages'];
export const REQUIRED_PAGE = ['path', 'mode', 'blob', 'chunk', 'chunk_of'];
export const FILE_MODES = ['100644', '100755', '120000'];
export const OMIT_MODES = [...FILE_MODES, '160000'];
export const DEFAULT_CHUNK = 1800, DEFAULT_MAX_LINES = 72, QR_BUDGET = 2331;

export class ScanrepoError extends Error {}

export function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- SHA-1 (sync, tiny)
export function sha1(bytes) {
  const ml = bytes.length, withPad = ((ml + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(withPad); m.set(bytes); m[ml] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(withPad - 4, (ml * 8) >>> 0); dv.setUint32(withPad - 8, Math.floor(ml / 0x20000000));
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, '0')).join('');
}

export const gitObjectId = (kind, body) => sha1(concat(utf8(`${kind} ${body.length}\0`), body));
export const gitBlob = (data) => gitObjectId('blob', data);
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

export function checkPath(path) {
  if (!path || path.startsWith('/') || path.endsWith('/') || /[\n\0]/.test(path)) throw new ScanrepoError(`unsafe path: ${JSON.stringify(path)}`);
  for (const part of path.split('/')) if (part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git') throw new ScanrepoError(`unsafe path: ${JSON.stringify(path)}`);
}

export function buildTree(entries) {
  const root = new Map();
  for (const [mode, path, sha] of entries) {
    checkPath(path);
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
      if (!(node instanceof Map)) throw new ScanrepoError(`path conflict at ${path}`);
    }
    const leaf = parts[parts.length - 1];
    if (node.has(leaf)) throw new ScanrepoError(`duplicate path ${path}`);
    node.set(leaf, { mode, sha });
  }
  return root;
}

function cmpBytes(a, b) { const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }

export function treeId(node) {
  const items = [...node.entries()].map(([name, v]) => ({ name, v, key: utf8(v instanceof Map ? `${name}/` : name) })).sort((x, y) => cmpBytes(x.key, y.key));
  const parts = [];
  for (const { name, v } of items) {
    const [mode, sha] = v instanceof Map ? ['40000', treeId(v)] : [v.mode, v.sha];
    parts.push(utf8(`${mode} ${name}\0`), hexBytes(sha));
  }
  return gitObjectId('tree', concat(...parts));
}
export const gitTree = (entries) => treeId(buildTree(entries));

// ---------------------------------------------------------------- commit object
const b64 = { enc: (bytes) => btoa(String.fromCharCode(...bytes)), dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) };

export function metaParents(meta) { return meta.parents ? meta.parents.split(/\s+/).filter(Boolean) : meta.parent === 'none' ? [] : [meta.parent]; }

/** Rebuild the raw commit object from cover fields, or null for a 1.0 master. */
export function commitBody(meta) {
  if (meta.commit_object_b64) return b64.dec(meta.commit_object_b64);
  const f = {};
  for (const k of ['author', 'committer']) {
    if (meta[`${k}_b64`]) f[k] = b64.dec(meta[`${k}_b64`]); else if (k in meta) f[k] = utf8(meta[k]); else return null;
  }
  for (const k of ['message', 'commit_extra']) {
    if (meta[`${k}_b64`]) f[k] = b64.dec(meta[`${k}_b64`]);
    else if (k in meta) f[k] = utf8(JSON.parse(meta[k]));
    else if (k === 'message') return null; else f[k] = new Uint8Array();
  }
  let head = `tree ${meta.tree}\n`;
  for (const p of metaParents(meta)) head += `parent ${p}\n`;
  return concat(utf8(head), utf8('author '), f.author, utf8('\ncommitter '), f.committer, utf8('\n'), f.commit_extra, utf8('\n'), f.message);
}

export function signature(name, email, time, tz = '+0000') {
  if (/[<>\n]/.test(name + email)) throw new ScanrepoError('name/email may not contain <, > or newlines');
  if (!/^[+-]\d{4}$/.test(tz)) throw new ScanrepoError('timezone must look like +0000');
  return `${name} <${email}> ${Math.floor(Number(time))} ${tz}`;
}

// ---------------------------------------------------------------- chunking
function lines(data) { const out = []; let s = 0; for (let i = 0; i < data.length; i++) if (data[i] === 10) { out.push(data.subarray(s, i + 1)); s = i + 1; } if (s < data.length) out.push(data.subarray(s)); return out; }

export function chunk(data, limit = DEFAULT_CHUNK, maxLines = DEFAULT_MAX_LINES) {
  if (!data.length) return [new Uint8Array()];
  const chunks = []; let cur = [], curLen = 0, curLines = 0;
  const flush = () => { if (curLen) chunks.push(concat(...cur)); cur = []; curLen = 0; curLines = 0; };
  for (let line of lines(data)) {
    while (line.length > limit) {
      let cut = limit;
      while (cut > 0 && (line[cut] & 0xc0) === 0x80) cut--;
      flush(); chunks.push(line.subarray(0, cut)); line = line.subarray(cut);
    }
    if (curLen && (curLen + line.length > limit || curLines >= maxLines)) flush();
    cur.push(line); curLen += line.length; curLines++;
  }
  flush();
  return chunks;
}

export function isText(bytes) { if (bytes.includes(0)) return false; try { text(bytes); return true; } catch { return false; } }

// ---------------------------------------------------------------- master format
export function serializeCover(meta, omitted = []) {
  const out = [BANNER, '---'];
  for (const [k, v] of Object.entries(meta)) { const s = String(v); if (/[\n\r]/.test(s)) throw new ScanrepoError(`frontmatter value for ${k} has a newline`); out.push(`${k}: ${s}`); }
  out.push('---');
  if (omitted.length) { out.push('## OMITTED'); for (const o of omitted) out.push(`${o.mode} ${o.sha} ${o.reason} ${o.path}`); out.push('## END OMITTED'); }
  return utf8(out.join('\n') + '\n');
}

export function serializePage(n, p) {
  const head = [`## PAGE ${n}`, ...REQUIRED_PAGE.map((k) => `${k}: ${p[k]}`), `size: ${p.bytes.length}`, 'text:'];
  return concat(utf8(head.join('\n') + '\n'), p.bytes, utf8('\n## END PAGE'));
}

export function serializeMaster(meta, omitted, pages) {
  return concat(serializeCover(meta, omitted), ...pages.flatMap((p, i) => [serializePage(i + 1, p), utf8('\n')]));
}

/**
 * Seal an edition: { repo, edition, branch, parent, message, author:{name,email,time,tz}, files:[{path, mode, text}] }
 * Returns { meta, omitted, pages, master (Uint8Array), commit, tree }.
 */
export function seal(ed, { chunkSize = DEFAULT_CHUNK, maxLines = DEFAULT_MAX_LINES } = {}) {
  if (!ed.repo || /\s/.test(ed.repo)) throw new ScanrepoError('repo name is required and has no spaces');
  if (ed.parent && ed.parent !== 'none' && !/^[0-9a-f]{40}$/.test(ed.parent)) throw new ScanrepoError('parent must be a 40-hex commit id or none');
  const files = [...ed.files].filter((f) => f.path).sort((a, b) => cmpBytes(utf8(a.path), utf8(b.path)));
  if (!files.length) throw new ScanrepoError('add at least one file');
  const pages = [], entries = [];
  for (const f of files) {
    checkPath(f.path);
    const mode = f.mode || '100644';
    if (!FILE_MODES.includes(mode)) throw new ScanrepoError(`${f.path}: mode must be 100644, 100755 or 120000`);
    const bytes = utf8(f.text ?? '');
    const sha = gitBlob(bytes);
    entries.push([mode, f.path, sha]);
    const overhead = 64 + serializePage(99999, { path: f.path, mode, blob: sha, chunk: 9999, chunk_of: 9999, bytes: new Uint8Array(5) }).length;
    const parts = chunk(bytes, Math.max(200, Math.min(chunkSize, QR_BUDGET - overhead)), maxLines);
    parts.forEach((b, i) => pages.push({ path: f.path, mode, blob: sha, chunk: i + 1, chunk_of: parts.length, bytes: b }));
  }
  const tree = gitTree(entries);
  const a = ed.author || {};
  const sig = signature(a.name || 'Anonymous', a.email || 'anon@example.com', a.time ?? Math.floor(Date.now() / 1000), a.tz || '+0000');
  const message = (ed.message || 'Edition').replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  const parent = ed.parent && ed.parent !== 'none' ? ed.parent : 'none';
  const meta = { repo: ed.repo, edition: Number(ed.edition) || 1, branch: ed.branch || 'main', commit: '', tree, parent, pages: pages.length, format: FORMAT, author: sig, committer: sig, message: JSON.stringify(message) };
  meta.commit = gitObjectId('commit', commitBody(meta));
  return { meta, omitted: [], pages, tree, commit: meta.commit, master: serializeMaster(meta, [], pages) };
}

class Reader {
  constructor(d) { this.d = d; this.pos = 0; }
  eof() { return this.pos >= this.d.length; }
  line() { let e = this.d.indexOf(10, this.pos); if (e < 0) e = this.d.length; const out = this.d.subarray(this.pos, e); this.pos = e + 1; return out; }
}
const kv = (line, where) => { const s = text(line); const i = s.indexOf(': '); if (i < 0) throw new ScanrepoError(`bad ${where} line: ${s.slice(0, 60)}`); return [s.slice(0, i), s.slice(i + 2)]; };
const END = utf8('## END PAGE');

export function parseMaster(data) {
  if (typeof data === 'string') data = utf8(data);
  const r = new Reader(data);
  if (text(r.line()).replace(/\r$/, '') !== BANNER) throw new ScanrepoError("not a scanrepo v1 file (line 1 must be '# scanrepo v1')");
  if (text(r.line()) !== '---') throw new ScanrepoError('missing frontmatter');
  const meta = {};
  for (;;) { if (r.eof()) throw new ScanrepoError('unterminated frontmatter'); const l = r.line(); if (text(l) === '---') break; const [k, v] = kv(l, 'frontmatter'); meta[k] = v; }
  const missing = REQUIRED_META.filter((k) => !(k in meta));
  if (missing.length) throw new ScanrepoError(`frontmatter missing: ${missing.join(', ')}`);
  const omitted = [], pages = [];
  while (!r.eof()) {
    const l = text(r.line());
    if (l === '## OMITTED') {
      for (;;) { if (r.eof()) throw new ScanrepoError('unterminated OMITTED block'); const o = text(r.line()); if (o === '## END OMITTED') break; const [mode, sha, reason, ...p] = o.split(' '); omitted.push({ mode, sha, reason, path: p.join(' ') }); }
    } else if (l.startsWith('## PAGE ')) {
      const n = parseInt(l.slice(8), 10); const page = { n };
      for (;;) { if (r.eof()) throw new ScanrepoError(`page ${n}: no text: line`); const h = r.line(); if (text(h) === 'text:') break; const [k, v] = kv(h, `page ${n} header`); page[k] = v; }
      const miss = REQUIRED_PAGE.filter((k) => !(k in page));
      if (miss.length) throw new ScanrepoError(`page ${n} missing: ${miss.join(', ')}`);
      if ('size' in page) {
        const size = parseInt(page.size, 10);
        page.bytes = data.subarray(r.pos, r.pos + size); r.pos += size;
        const tail = concat(utf8('\n'), END);
        if (!eq(data.subarray(r.pos, r.pos + tail.length), tail)) throw new ScanrepoError(`page ${n}: size ${size} does not land on '## END PAGE'`);
        r.pos += tail.length + 1;
      } else {
        const start = r.pos; let probe = r.pos, end = null;
        while (probe <= data.length) {
          const nl = data.indexOf(10, probe); const stop = nl < 0 ? data.length : nl;
          if (eq(data.subarray(probe, stop), END)) { end = probe; break; }
          if (nl < 0) break; probe = nl + 1;
        }
        if (end == null) throw new ScanrepoError(`page ${n}: no '## END PAGE'`);
        const raw = data.subarray(start, end);
        page.raw = raw; page.bytes = raw.length && raw[raw.length - 1] === 10 ? raw.subarray(0, -1) : raw;
        r.pos = end + END.length + 1;
      }
      pages.push(page);
    } else if (l.trim() === '') continue;
    else throw new ScanrepoError(`unexpected line: ${l.slice(0, 60)}`);
  }
  const want = parseInt(meta.pages, 10);
  const nums = pages.map((p) => p.n);
  if (nums.length !== want || nums.some((x, i) => x !== i + 1)) throw new ScanrepoError(`pages must be numbered 1..${want} with no gaps; found ${pages.length} page blocks`);
  return { meta, omitted, pages };
}

// ---------------------------------------------------------------- QR payloads
export function coverPayloads(cover, commit, limit = 2200) {
  const segs = []; let pos = 0;
  while (pos < cover.length || !segs.length) {
    let cut = Math.min(pos + limit, cover.length);
    while (cut < cover.length && cut > pos && (cover[cut] & 0xc0) === 0x80) cut--;
    segs.push(cover.subarray(pos, cut)); pos = cut;
  }
  return segs.map((s, i) => concat(utf8(`C|${PAYLOAD_TAG}|${commit}|${i + 1}/${segs.length}\n`), s));
}
export const pagePayload = (n, total, commit, block) => concat(utf8(`P|${PAYLOAD_TAG}|${commit}|${n}/${total}\n`), block);

/** All QR payloads of a sealed edition, in print order (cover first). */
export function payloads({ meta, omitted, pages }) {
  const cover = serializeCover(meta, omitted);
  return [...coverPayloads(cover, meta.commit), ...pages.map((p, i) => pagePayload(i + 1, pages.length, meta.commit, serializePage(i + 1, p)))];
}

const PAYLOAD_RE = /^([CP])\|scanrepo1\|([0-9a-f]{40})\|(\d+)\/(\d+)\n/;
export function parsePayload(data) {
  if (typeof data === 'string') data = utf8(data);
  const nl = data.indexOf(10);
  const head = nl < 0 ? '' : text(data.subarray(0, nl + 1));
  const m = head.match(PAYLOAD_RE);
  if (!m) throw new ScanrepoError(`not a scanrepo payload: ${JSON.stringify(text(data.subarray(0, 40)))}`);
  return { kind: m[1], commit: m[2], i: +m[3], total: +m[4], body: data.subarray(nl + 1) };
}

/** Reassemble from payloads (any order, duplicates ok). Returns { master } or { unread: { coverMissing, pagesMissing, commit } }. */
export function masterFromPayloads(list) {
  const covers = new Map(), pages = new Map(), commits = new Set(); let coverTotal = null, pageTotal = null;
  for (const d of list) { const p = parsePayload(d); commits.add(p.commit); if (p.kind === 'C') { coverTotal = p.total; covers.set(p.i, p.body); } else { pageTotal = p.total; pages.set(p.i, p.body); } }
  if (commits.size > 1) throw new ScanrepoError(`payloads from more than one edition: ${[...commits].join(', ')}`);
  const commit = [...commits][0];
  const coverMissing = coverTotal == null ? ['cover'] : Array.from({ length: coverTotal }, (_, i) => i + 1).filter((i) => !covers.has(i));
  let want = pageTotal || 0;
  if (!coverMissing.length) {
    const cover = concat(...Array.from({ length: coverTotal }, (_, i) => covers.get(i + 1)));
    const m = text(cover).match(/^pages: (\d+)$/m); if (m) want = +m[1];
    const pagesMissing = Array.from({ length: want }, (_, i) => i + 1).filter((i) => !pages.has(i));
    if (!pagesMissing.length) return { master: concat(cover, ...Array.from({ length: want }, (_, i) => concat(pages.get(i + 1), utf8('\n')))), commit };
    return { unread: { coverMissing: [], pagesMissing, commit } };
  }
  return { unread: { coverMissing, pagesMissing: Array.from({ length: want }, (_, i) => i + 1).filter((i) => !pages.has(i)), commit } };
}

/** Split pasted text into payloads. Payloads are separated by a line that is exactly '---'
 *  (a '---' inside a cover is fine: only a '---' line followed by a C|/P| header splits). */
export function splitPasted(s) {
  const raw = []; let cur = null;
  for (const line of s.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[CP]\|scanrepo1\|/.test(line)) { if (cur != null) raw.push(cur); cur = line; }
    else if (cur != null) cur += '\n' + line;
  }
  if (cur != null) raw.push(cur);
  return raw.map((p) => {
    p = p.replace(/\n---\s*$/, '');
    if (p.startsWith('P|')) return p.replace(/\n+$/, '');
    const m = p.match(/^C\|scanrepo1\|[0-9a-f]{40}\|(\d+)\/(\d+)\n/);
    return m && m[1] === m[2] ? p.replace(/\n*$/, '\n') : p; // the cover text always ends with a newline
  });
}

// ---------------------------------------------------------------- verify / report
function rejoin(chunks) {
  chunks = [...chunks].sort((a, b) => a.chunk - b.chunk);
  const want = +chunks[0].chunk_of;
  if (chunks.length !== want || chunks.some((c, i) => +c.chunk !== i + 1)) throw new ScanrepoError(`${chunks[0].path}: chunks ${chunks.map((c) => c.chunk)} of ${want}`);
  for (const c of chunks) if (c.blob !== chunks[0].blob || c.mode !== chunks[0].mode) throw new ScanrepoError(`${c.path}: chunks disagree on blob/mode`);
  const exact = concat(...chunks.map((c) => c.bytes));
  if (chunks.every((c) => !c.raw)) return [exact];
  const raws = chunks.map((c) => c.raw || c.bytes);
  return [exact, concat(...raws), concat(...raws.slice(0, -1), chunks[chunks.length - 1].bytes)];
}

/**
 * Status: Sealed (blobs, tree and commit recomputed) | Held (blobs and tree match, commit not checkable: 1.0 master)
 *       | Rejected (something does not match) | Unread (pages or cover missing).
 */
export function verify({ meta, omitted, pages }) {
  const log = [], files = [];
  try {
    const byPath = new Map();
    for (const p of pages) { if (!byPath.has(p.path)) byPath.set(p.path, []); byPath.get(p.path).push(p); }
    const entries = [];
    for (const [path, chunks] of byPath) {
      checkPath(path);
      const { blob, mode } = chunks[0];
      if (!FILE_MODES.includes(mode)) throw new ScanrepoError(`${path}: unsupported mode ${mode}`);
      const data = rejoin(chunks).find((d) => gitBlob(d) === blob);
      if (!data) throw new ScanrepoError(`blob mismatch for ${path}: got ${gitBlob(rejoin(chunks)[0]).slice(0, 12)} want ${blob.slice(0, 12)}`);
      files.push({ path, mode, blob, bytes: data });
      entries.push([mode, path, blob]);
      log.push({ ok: true, what: 'blob', id: blob, path, note: chunks.length > 1 ? `${chunks.length} pages` : '' });
    }
    for (const o of omitted) { if (!OMIT_MODES.includes(o.mode)) throw new ScanrepoError(`${o.path}: unsupported omitted mode`); entries.push([o.mode, o.path, o.sha]); log.push({ ok: true, what: 'omit', id: o.sha, path: o.path, note: `${o.reason}; id only` }); }
    const tree = gitTree(entries);
    if (tree !== meta.tree) throw new ScanrepoError(`tree mismatch: got ${tree.slice(0, 12)} want ${meta.tree.slice(0, 12)}`);
    log.push({ ok: true, what: 'tree', id: tree });
    const raw = commitBody(meta);
    if (!raw) { log.push({ ok: null, what: 'commit', id: meta.commit, note: 'not verified: this printing has no author, time or message (format 1.0)' }); return { status: 'Held', meta, files, log, omitted }; }
    const cid = gitObjectId('commit', raw);
    if (cid !== meta.commit) throw new ScanrepoError(`commit mismatch: got ${cid.slice(0, 12)} want ${meta.commit.slice(0, 12)}`);
    log.push({ ok: true, what: 'commit', id: cid, note: `parent ${meta.parent}` });
    return { status: 'Sealed', meta, files, log, omitted, commitRaw: raw };
  } catch (e) {
    log.push({ ok: false, what: 'error', note: e.message });
    return { status: 'Rejected', meta, files, log, omitted, error: e.message };
  }
}

/** Restore from pasted input: a whole master, or QR payloads separated by '---' lines. */
export function restore(input) {
  const s = typeof input === 'string' ? input : text(input);
  try {
    if (/^\s*[CP]\|scanrepo1\|/.test(s)) {
      const r = masterFromPayloads(splitPasted(s).map(utf8));
      if (r.unread) return { status: 'Unread', ...r.unread, log: [{ ok: false, what: 'unread', note: `${r.unread.coverMissing.length ? 'cover code missing; ' : ''}${r.unread.pagesMissing.length ? `missing pages ${r.unread.pagesMissing.join(', ')}` : ''}` }] };
      return { ...verify(parseMaster(r.master)), master: r.master };
    }
    const master = utf8(s.replace(/^\uFEFF/, ''));
    return { ...verify(parseMaster(master)), master };
  } catch (e) {
    return { status: 'Rejected', error: e.message, log: [{ ok: false, what: 'error', note: e.message }], files: [] };
  }
}

// ---------------------------------------------------------------- zip (store) for restored checkouts
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const f of files) {
    const name = utf8(f.path), data = f.bytes, crc = crc32(data);
    const exec = f.mode === '100755';
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 0x0314, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(38, ((exec ? 0o100755 : f.mode === '120000' ? 0o120777 : 0o100644) << 16) >>> 0, true); ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), name, data); centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cd = concat(...centrals);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cd.length, true); end.setUint32(16, offset, true);
  return concat(...locals, cd, new Uint8Array(end.buffer));
}
