import * as S from './scanrepo.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let current = null;   // { meta, omitted, pages, master }
let files = [];       // compose state

// ---------- tabs
function tab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('on', s.id === name));
  history.replaceState(null, '', `#${name}`);
}
document.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) tab(b.dataset.tab); };
document.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => tab(b.dataset.go)));

// ---------- QR
const binStr = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };
function qrImg(bytes) {
  for (const ec of ['M', 'L']) {
    try { const q = window.qrcode(0, ec); q.addData(binStr(bytes), 'Byte'); q.make(); return q.createDataURL(4, 4); } catch (e) { if (ec === 'L') throw new Error(`payload of ${bytes.length} bytes does not fit one QR code`); }
  }
}

// ---------- compose
const toLocal = (unix) => { const d = new Date(unix * 1000); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 19); };
const tzNow = () => { const m = -new Date().getTimezoneOffset(); return `${m >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}${String(Math.abs(m) % 60).padStart(2, '0')}`; };
function setForm(ed) {
  $('repo').value = ed.repo; $('edition').value = ed.edition; $('branch').value = ed.branch; $('parent').value = ed.parent || 'none';
  $('message').value = ed.message || ''; $('aname').value = ed.author?.name || ''; $('aemail').value = ed.author?.email || '';
  $('atime').value = toLocal(ed.author?.time ?? Math.floor(Date.now() / 1000)); $('atz').value = ed.author?.tz || tzNow();
  files = ed.files.map((f) => ({ ...f })); renderFiles();
}
function readForm() {
  const t = $('atime').value ? Math.floor(new Date($('atime').value).getTime() / 1000) : Math.floor(Date.now() / 1000);
  return { repo: $('repo').value.trim(), edition: +$('edition').value || 1, branch: $('branch').value.trim() || 'main', parent: $('parent').value.trim() || 'none', message: $('message').value,
    author: { name: $('aname').value.trim(), email: $('aemail').value.trim(), time: t, tz: $('atz').value.trim() || '+0000' }, files };
}
function renderFiles() {
  $('files').innerHTML = '';
  files.forEach((f, i) => {
    const d = document.createElement('div'); d.className = 'file';
    d.innerHTML = `<div class="row"><input class="path" value="${esc(f.path)}" placeholder="path/to/file.txt" aria-label="Path"><select aria-label="Mode"><option value="100644">100644 file</option><option value="100755">100755 executable</option><option value="120000">120000 symlink</option></select><button class="btn ghost" title="Remove">✕</button></div><textarea spellcheck="false" rows="6"></textarea><small class="muted"></small>`;
    const [p, m, x, ta, info] = [d.querySelector('.path'), d.querySelector('select'), d.querySelector('button'), d.querySelector('textarea'), d.querySelector('small')];
    m.value = f.mode || '100644'; ta.value = f.text;
    const upd = () => { const b = S.utf8(f.text); const pages = S.chunk(b).length; info.textContent = `${b.length} bytes · ${f.text.split('\n').length} lines · ${pages} page${pages === 1 ? '' : 's'}${f.text.split('\n').some((l) => l.length > 100) ? ' · has overlong lines' : ''}`; };
    p.oninput = () => (f.path = p.value.trim()); m.onchange = () => (f.mode = m.value); ta.oninput = () => { f.text = ta.value; upd(); };
    x.onclick = () => { files.splice(i, 1); renderFiles(); };
    upd(); $('files').append(d);
  });
}
$('addFile').onclick = () => { files.push({ path: `file${files.length + 1}.txt`, mode: '100644', text: '' }); renderFiles(); };
$('upload').onchange = async (e) => {
  for (const f of e.target.files) {
    const b = new Uint8Array(await f.arrayBuffer());
    if (!S.isText(b)) { $('composeErr').textContent = `${f.name} is binary and stays off the page.`; continue; }
    files.push({ path: f.webkitRelativePath || f.name, mode: '100644', text: S.text(b) });
  }
  renderFiles(); e.target.value = '';
};
$('seal').onclick = () => {
  $('composeErr').textContent = '';
  try { const ed = S.seal(readForm()); current = ed; renderBooklet(); tab('booklet'); }
  catch (e) { $('composeErr').textContent = e.message; }
};
$('newEd').onclick = () => {
  if (!current) { $('composeErr').textContent = 'Seal or load an edition first; the new edition takes it as parent.'; return; }
  const ed = readForm(); ed.edition = (+current.meta.edition || 1) + 1; ed.parent = current.meta.commit; ed.author.time = Math.floor(Date.now() / 1000); ed.message = '';
  setForm(ed); $('message').focus();
};

function editionFromParsed({ meta, pages }) {
  const byPath = new Map();
  for (const p of pages) { if (!byPath.has(p.path)) byPath.set(p.path, { path: p.path, mode: p.mode, parts: [] }); byPath.get(p.path).parts.push(p); }
  const fl = [...byPath.values()].map((f) => ({ path: f.path, mode: f.mode, text: S.text(S.concat(...f.parts.sort((a, b) => a.chunk - b.chunk).map((c) => c.bytes))) }));
  const m = (meta.author || '').match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  return { repo: meta.repo, edition: +meta.edition, branch: meta.branch, parent: meta.parent, message: meta.message ? JSON.parse(meta.message) : '', author: m ? { name: m[1], email: m[2], time: +m[3], tz: m[4] } : { name: '', email: '' }, files: fl };
}

async function loadSample() {
  const txt = await (await fetch('samples/paper-git-ed1.scanrepo')).text();
  const parsed = S.parseMaster(txt);
  current = { ...parsed, master: S.utf8(txt) };
  setForm({ ...editionFromParsed(parsed), author: { name: 'Joshua Almeida', email: 'fitzyracing1@users.noreply.github.com' } });
  renderBooklet();
}
$('loadSample').onclick = () => loadSample().then(() => tab('booklet'));

// ---------- booklet
function renderBooklet() {
  if (!current) return;
  const { meta, omitted, pages } = current;
  const pls = S.payloads(current);
  const covers = pls.filter((p) => p[0] === 67);
  const files = new Set(pages.map((p) => p.path)).size;
  $('bookInfo').textContent = `${meta.repo} · edition ${meta.edition} · ${pages.length} page${pages.length === 1 ? '' : 's'} + cover · ${files} file${files === 1 ? '' : 's'} · commit ${meta.commit.slice(0, 12)}`;
  let msg = ''; try { msg = meta.message ? JSON.parse(meta.message) : ''; } catch {}
  const cover = `<article class="page cover"><header><b>scanrepo</b><span>format ${esc(meta.format || '1.0')}</span></header>
    <h2>${esc(meta.repo)}</h2><div class="ed">Edition ${esc(meta.edition)} · ${esc(meta.branch)}</div>
    <dl><dt>commit</dt><dd>${esc(meta.commit)}</dd><dt>tree</dt><dd>${esc(meta.tree)}</dd><dt>parent</dt><dd>${esc(meta.parent)}</dd>
    ${meta.author ? `<dt>author</dt><dd>${esc(meta.author)}</dd>` : ''}${msg ? `<dt>message</dt><dd>${esc(msg)}</dd>` : ''}<dt>pages</dt><dd>${esc(meta.pages)}</dd>
    ${omitted.length ? `<dt>omitted</dt><dd>${omitted.map((o) => esc(`${o.path} (${o.reason})`)).join('<br>')}</dd>` : ''}</dl>
    <p style="font-size:12px;color:#666">Scan every code, cover first or last, any order. Rehash the blobs the git way, rebuild the tree and the commit, compare with this cover.</p>
    <div class="codes">${covers.map((c, i) => `<div class="code"><img alt="cover code ${i + 1}" src="${qrImg(c)}">C ${i + 1}/${covers.length}</div>`).join('')}</div></article>`;
  const body = pages.map((p, i) => `<article class="page"><header><b>${esc(p.path)}</b><span>${esc(p.mode)} · ${p.chunk_of > 1 ? `part ${p.chunk}/${p.chunk_of} · ` : ''}page ${i + 1}/${pages.length} · blob ${esc(p.blob.slice(0, 12))}</span></header>
    <pre>${esc(S.text(p.bytes))}</pre><div class="code"><img alt="page code ${i + 1}" src="${qrImg(pls[covers.length + i])}">P ${i + 1}/${pages.length}</div></article>`).join('');
  $('pages').innerHTML = cover + body;
  $('testOut').textContent = '';
}

$('print').onclick = () => { tab('booklet'); setTimeout(() => print(), 50); };
$('master').onclick = () => { if (!current) return; download(new Blob([current.master], { type: 'application/x-scanrepo' }), `${current.meta.repo}-ed${current.meta.edition}-${current.meta.commit.slice(0, 7)}.scanrepo`); };
$('keep').onclick = () => {
  if (!current) return;
  const shelf = getShelf().filter((s) => s.commit !== current.meta.commit);
  shelf.unshift({ repo: current.meta.repo, edition: current.meta.edition, commit: current.meta.commit, kept: Date.now(), master: S.text(current.master) });
  setShelf(shelf); $('keep').textContent = 'Kept ✓'; setTimeout(() => ($('keep').textContent = 'Keep'), 1500);
};
$('testCodes').onclick = async () => {
  const imgs = [...document.querySelectorAll('#pages .code img')];
  const out = [];
  for (const img of imgs) { await img.decode(); const r = decodeImage(img); if (r) out.push(...r); }
  const rep = S.restore(out.map((b) => S.text(b)).join('\n---\n'));
  $('testOut').innerHTML = `Decoded ${out.length} of ${imgs.length} codes on screen → <span class="badge ${rep.status}" style="font-size:13px">${rep.status}</span> ${esc(rep.error || '')}`;
};

// ---------- restore
function decodeImage(img) {
  const c = document.createElement('canvas');
  const scale = Math.min(1, 2000 / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  c.width = Math.round((img.naturalWidth || img.width) * scale); c.height = Math.round((img.naturalHeight || img.height) * scale);
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingEnabled = false; g.drawImage(img, 0, 0, c.width, c.height);
  const r = window.jsQR(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
  return r ? [Uint8Array.from(r.binaryData)] : null;
}
async function decodeFile(file) {
  if ('BarcodeDetector' in window) {
    try { const det = new window.BarcodeDetector({ formats: ['qr_code'] }); const codes = await det.detect(await createImageBitmap(file)); if (codes.length) return codes.map((c) => S.utf8(c.rawValue)); } catch {}
  }
  const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
  return decodeImage(img) || [];
}
$('photos').onchange = async (e) => {
  let n = 0, miss = 0;
  for (const f of e.target.files) { const got = await decodeFile(f); if (got.length) { n += got.length; for (const b of got) appendPayload(S.text(b)); } else miss++; }
  $('decoded').textContent = `${n} code${n === 1 ? '' : 's'} read${miss ? `, ${miss} photo${miss === 1 ? '' : 's'} had no readable code (reshoot flat and sharp)` : ''}.`;
  e.target.value = ''; check();
};
function appendPayload(p) { const t = $('paste').value.trim(); $('paste').value = t ? `${t}\n---\n${p}` : p; }
$('openMaster').onchange = async (e) => { const f = e.target.files[0]; if (f) { $('paste').value = await f.text(); check(); } e.target.value = ''; };
$('clearPaste').onclick = () => { $('paste').value = ''; $('report').innerHTML = 'Nothing checked yet.'; $('decoded').textContent = ''; };
$('check').onclick = () => check();

const EXPLAIN = {
  Sealed: 'Every blob, the tree and the commit were recomputed from the pages and match the cover.',
  Held: 'Blobs and tree match, but this printing has no author, time or message, so the press cannot recompute that exact commit id.',
  Rejected: 'Something does not match the cover. Nothing was restored.',
  Unread: 'Not every code has been read yet. Scan the missing ones and check again.',
};
let lastReport = null;
function check() {
  const r = (lastReport = S.restore($('paste').value));
  const icon = (l) => (l.ok === true ? '<span class="ok">ok  </span>' : l.ok === null ? '<span class="warn">warn</span>' : '<span class="no">no  </span>');
  $('report').innerHTML = `<span class="badge ${r.status}">${r.status}</span><p>${EXPLAIN[r.status]}</p>
    ${r.meta ? `<p><b>${esc(r.meta.repo)}</b> edition ${esc(r.meta.edition)} · ${esc(r.meta.branch)} · commit <code>${esc(r.meta.commit.slice(0, 12))}</code></p>` : ''}
    <ul class="log">${r.log.map((l) => `<li>${icon(l)} ${esc(l.what)} ${esc((l.id || '').slice(0, 12))} ${esc(l.path || '')} ${l.note ? `<span class="muted">(${esc(l.note)})</span>` : ''}</li>`).join('')}</ul>
    ${r.files?.length && (r.status === 'Sealed' || r.status === 'Held') ? '<div class="row"><button id="dlZip" class="btn primary">Download checkout (.zip)</button><button id="toCompose" class="btn ghost">Open in Compose</button><button id="toBook" class="btn ghost">Show booklet</button></div>' : ''}`;
  if ($('dlZip')) {
    $('dlZip').onclick = () => download(new Blob([S.zip(r.files)], { type: 'application/zip' }), `${r.meta.repo}-ed${r.meta.edition}.zip`);
    const parsed = S.parseMaster(r.master);
    $('toCompose').onclick = () => { current = { ...parsed, master: r.master }; setForm(editionFromParsed(parsed)); renderBooklet(); tab('compose'); };
    $('toBook').onclick = () => { current = { ...parsed, master: r.master }; renderBooklet(); tab('booklet'); };
  }
}

// ---------- shelf
const getShelf = () => JSON.parse(localStorage.getItem('scanrepo.shelf') || '[]');
function setShelf(s) { localStorage.setItem('scanrepo.shelf', JSON.stringify(s)); renderShelf(); }
function renderShelf() {
  const s = getShelf(); $('nshelf').textContent = s.length || '';
  $('shelfList').innerHTML = s.length ? s.map((x, i) => `<div class="shelfrow"><div><b>${esc(x.repo)}</b> edition ${esc(x.edition)}<br><small>${esc(x.commit)} · kept ${new Date(x.kept).toLocaleString()}</small></div>
    <div class="row" style="margin:0"><button class="btn ghost" data-open="${i}">Open</button><button class="btn ghost" data-dl="${i}">Master</button><button class="btn ghost" data-del="${i}">✕</button></div></div>`).join('') : '<p class="muted">Nothing kept yet. Seal an edition and press Keep.</p>';
}
$('shelfList').onclick = (e) => {
  const s = getShelf(), t = e.target;
  if (t.dataset.open) { const p = S.parseMaster(s[t.dataset.open].master); current = { ...p, master: S.utf8(s[t.dataset.open].master) }; setForm(editionFromParsed(p)); renderBooklet(); tab('booklet'); }
  if (t.dataset.dl) { const x = s[t.dataset.dl]; download(new Blob([x.master]), `${x.repo}-ed${x.edition}-${x.commit.slice(0, 7)}.scanrepo`); }
  if (t.dataset.del) { s.splice(+t.dataset.del, 1); setShelf(s); }
};

function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

renderShelf();
await loadSample();
const start = location.hash.slice(1);
if (['directions', 'compose', 'booklet', 'restore', 'shelf'].includes(start)) tab(start);
if (new URLSearchParams(location.search).has('demo')) {
  // demo: seal a second edition, then restore it from its own on-screen codes
  const ed = readForm(); ed.edition = 2; ed.parent = current.meta.commit; ed.message = 'Second printing: add a greeting test'; ed.author.time = 1760659200; ed.author.tz = '-0400';
  ed.files.push({ path: 'test_hello.py', mode: '100644', text: 'from hello import greet\n\n\ndef test_greet():\n    assert greet("paper") == "hello from paper"\n' });
  setForm(ed); $('seal').click();
  await $('testCodes').onclick();
  $('paste').value = S.payloads(current).map((b) => S.text(b)).join('\n---\n'); check();
}
