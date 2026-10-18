import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as S from '../src/scanrepo.js';

const sample = readFileSync(new URL('../samples/paper-git-ed1.scanrepo', import.meta.url), 'utf8');
const has = (c) => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const edition = (over = {}) => ({
  repo: 'paper-git', edition: 2, branch: 'main', parent: '5b611a07beceee1ea8e148de714fb71c7d5e549e', message: 'Second printing\n\nAdds tests.',
  author: { name: 'Joshua Almeida', email: 'fitzyracing1@users.noreply.github.com', time: 1760659200, tz: '-0400' },
  files: [{ path: 'README.md', text: '# paper git\n' }, { path: 'src/hello.py', mode: '100755', text: '#!/usr/bin/env python3\nprint("hi ✓")\n' }, { path: 'docs/long.txt', text: Array.from({ length: 200 }, (_, i) => `line ${i} ${'·'.repeat(20)}`).join('\n') + '\n' }],
  ...over,
});

test('sha1 matches node crypto', () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'héllo ✓'.repeat(300)]) assert.equal(S.sha1(S.utf8(s)), createHash('sha1').update(s).digest('hex'));
});

test('paper-git edition 1 is Held: blobs and tree match, commit not checkable', () => {
  const r = S.restore(sample);
  assert.equal(r.status, 'Held');
  assert.equal(r.meta.tree, '1c7284bce3bfab13b70206fd7ac78213ffe9b8f2');
  assert.deepEqual(r.files.map((f) => f.path), ['README.md', 'hello.py']);
});

test('sealed edition round-trips as Sealed via master and via QR payloads (any order, duplicates)', () => {
  const ed = S.seal(edition());
  assert.equal(S.restore(S.text(ed.master)).status, 'Sealed');
  const pls = S.payloads(ed).map(S.text);
  assert.ok(pls[0].startsWith(`C|scanrepo1|${ed.commit}|1/1\n# scanrepo v1`));
  assert.ok(pls[1].startsWith(`P|scanrepo1|${ed.commit}|1/${ed.pages.length}\n## PAGE 1`));
  const shuffled = [...pls.slice(1).reverse(), pls[0], pls[2]];
  const r = S.restore(shuffled.join('\n---\n'));
  assert.equal(r.status, 'Sealed', r.error);
  assert.deepEqual(r.master, ed.master, 'payloads rebuild the master byte for byte');
  for (const p of S.payloads(ed)) assert.ok(p.length <= S.QR_BUDGET, 'every payload fits one QR code');
});

test('missing pages are Unread, tampering is Rejected, mixed editions are Rejected', () => {
  const ed = S.seal(edition());
  const pls = S.payloads(ed).map(S.text);
  const u = S.restore([pls[0], pls[1]].join('\n---\n'));
  assert.equal(u.status, 'Unread'); assert.ok(u.pagesMissing.length === ed.pages.length - 1);
  assert.equal(S.restore(pls.slice(1).join('\n---\n')).status, 'Unread');
  assert.equal(S.restore(S.text(ed.master).replace('# paper git', '# paper gif')).status, 'Rejected');
  const other = S.payloads(S.seal(edition({ message: 'other' }))).map(S.text);
  const mix = S.restore([pls[0], other[1]].join('\n---\n'));
  assert.equal(mix.status, 'Rejected'); assert.match(mix.error, /more than one edition/);
  assert.equal(S.restore('hello').status, 'Rejected');
});

test('chunking: ≤ 1800 bytes and ≤ 72 lines a page, split at line ends, UTF-8 safe', () => {
  const data = S.utf8(Array.from({ length: 300 }, (_, i) => `${i}: ${'é'.repeat(i % 50)}`).join('\n'));
  const parts = S.chunk(data);
  assert.deepEqual(S.concat(...parts), data);
  for (const p of parts) { assert.ok(p.length <= 1800); assert.ok(S.text(p).split('\n').filter(Boolean).length <= 72); }
  const longLine = S.utf8('✓'.repeat(1000));
  const lp = S.chunk(longLine, 1800);
  assert.ok(lp.every((p) => S.isText(p)), 'never splits inside a character');
  assert.deepEqual(S.chunk(new Uint8Array()), [new Uint8Array()]);
});

test('paths and inputs are validated', () => {
  assert.throws(() => S.seal(edition({ files: [{ path: '../x', text: '' }] })), /unsafe path/);
  assert.throws(() => S.seal(edition({ files: [{ path: '.git/config', text: '' }] })), /unsafe path/);
  assert.throws(() => S.seal(edition({ parent: 'abc' })), /parent/);
  assert.throws(() => S.seal(edition({ files: [] })), /at least one file/);
});

test('commit ids match real git', { skip: !has('git') }, () => {
  const ed = edition({ parent: 'none' });
  const dir = mkdtempSync(join(tmpdir(), 'scanrepo-'));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: ed.author.name, GIT_AUTHOR_EMAIL: ed.author.email, GIT_COMMITTER_NAME: ed.author.name, GIT_COMMITTER_EMAIL: ed.author.email, GIT_AUTHOR_DATE: `${ed.author.time} ${ed.author.tz}`, GIT_COMMITTER_DATE: `${ed.author.time} ${ed.author.tz}` } }).toString().trim();
  g('init', '-q', '-b', 'main'); g('config', 'core.fileMode', 'true'); g('config', 'commit.gpgsign', 'false');
  for (const f of ed.files) { const p = join(dir, f.path); execFileSync('mkdir', ['-p', join(p, '..')]); writeFileSync(p, f.text); if (f.mode === '100755') chmodSync(p, 0o755); }
  g('add', '-A'); g('commit', '-q', '--cleanup=verbatim', '-m', ed.message.replace(/\n*$/, '\n'));
  const sealed = S.seal(ed);
  assert.equal(sealed.tree, g('rev-parse', 'HEAD^{tree}'));
  assert.equal(sealed.commit, g('rev-parse', 'HEAD'));
});

test('zip of the restored checkout is valid', { skip: !has('python3') }, () => {
  const r = S.restore(S.text(S.seal(edition()).master));
  const dir = mkdtempSync(join(tmpdir(), 'scanrepo-'));
  writeFileSync(join(dir, 'c.zip'), S.zip(r.files));
  const out = execFileSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(",".join(sorted(z.namelist())));print(z.read("src/hello.py").decode())', join(dir, 'c.zip')]).toString();
  assert.match(out, /README.md,docs\/long.txt,src\/hello.py/);
  assert.match(out, /print\("hi ✓"\)/);
});

test('legacy pages without size still parse (format 1.0 rule)', () => {
  const p = S.parseMaster(sample);
  assert.equal(p.pages.length, 2); assert.ok(p.pages[0].raw);
});
