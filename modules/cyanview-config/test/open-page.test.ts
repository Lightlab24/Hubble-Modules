import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import manifest from '../src/manifest.js';
import { devicePageUrl, pageLaunchers, runOpenPage, type PageLauncher } from '../src/open-page-run.js';
import { fixture } from './helpers.js';
import { pingPolicy } from '../src/ping-batch.js';

// A stand-in for the browser: a short Node program that writes down what it was handed.
const recorder = (file: string, exit = 0): PageLauncher => ({
  file: process.execPath,
  args: url => ['-e', 'require("node:fs").appendFileSync(process.argv[1], process.argv[2] + "\\n"); process.exit(' + exit + ')', file, url],
});

test('a controller’s page opens in Safari on a Mac, and in the computer’s own browser elsewhere', () => {
  const [safari, fallback] = pageLaunchers('darwin');
  assert.equal(safari!.file, '/usr/bin/open');
  assert.deepEqual(safari!.args('http://10.192.46.197/'), ['-a', 'Safari', 'http://10.192.46.197/']);
  assert.deepEqual(fallback!.args('http://10.192.46.197/'), ['http://10.192.46.197/']);
  assert.deepEqual(pageLaunchers('linux').map(launcher => [launcher.file, launcher.args('http://10.192.46.197/')]), [['xdg-open', ['http://10.192.46.197/']]]);
});

test('only a plain http address made from an IPv4 is ever opened', () => {
  assert.equal(devicePageUrl({ address: '10.192.46.197' }), 'http://10.192.46.197/');
  for (const address of ['', '10.192.46', '10.192.46.999', 'example.com', 'file:///etc/hosts', '10.192.46.197/admin', '10.192.46.197 -a Terminal', 'http://10.192.46.197', '-a', '$(id)'])
    assert.throws(() => devicePageUrl({ address }), /valid IPv4/, address);
  assert.throws(() => devicePageUrl(null), /valid IPv4/);
});

test('the helper hands the browser the address, and tries the next browser when the first won’t start', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'cyanview-open-page-'));
  try {
    const first = path.join(folder, 'first'), second = path.join(folder, 'second');
    assert.deepEqual(await runOpenPage({ address: '10.192.46.197' }, AbortSignal.timeout(5000), [recorder(first)]), { opened: 'http://10.192.46.197/' });
    assert.equal(await readFile(first, 'utf8'), 'http://10.192.46.197/\n');
    // The first one fails, as Safari would on a computer without it.
    assert.deepEqual(await runOpenPage({ address: '10.20.101.201' }, AbortSignal.timeout(5000), [recorder(first, 1), recorder(second)]), { opened: 'http://10.20.101.201/' });
    assert.equal(await readFile(second, 'utf8'), 'http://10.20.101.201/\n');
    await assert.rejects(() => runOpenPage({ address: '10.20.101.201' }, AbortSignal.timeout(5000), [recorder(first, 1)]), /could not be opened/);
    await assert.rejects(() => runOpenPage({ address: '10.20.101.201' }, AbortSignal.timeout(5000), [{ file: path.join(folder, 'missing'), args: url => [url] }]), /could not be started/);
    // A bad address starts nothing.
    const untouched = path.join(folder, 'untouched');
    await assert.rejects(() => runOpenPage({ address: '10.20.101.201; open -a Terminal' }, AbortSignal.timeout(5000), [recorder(untouched)]), /valid IPv4/);
    await assert.rejects(() => readFile(untouched, 'utf8'));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the page’s request opens the address it names, and nothing else', async () => {
  const opened: string[] = [];
  const f = fixture({}, { openPage: async address => { opened.push(address); } });
  try {
    await f.instance.start();
    assert.deepEqual(await f.call('open-device-page', { address: '10.192.46.197' }), { opened: '10.192.46.197' });
    assert.deepEqual(opened, ['10.192.46.197']);
    for (const address of ['', 'example.com', '10.192.46.197/x', '10.1.2'])
      await assert.rejects(() => f.call('open-device-page', { address }), /no address to open/, address);
    assert.deepEqual(opened, ['10.192.46.197']);
  } finally { await f.instance.dispose(); }
});

test('a browser that won’t open is reported, and sample devices open nothing', async () => {
  const failing = fixture({}, { openPage: async () => { throw new Error('The browser could not be opened'); } });
  try {
    await failing.instance.start();
    await assert.rejects(() => failing.call('open-device-page', { address: '10.192.46.197' }), /could not be opened/);
  } finally { await failing.instance.dispose(); }
  const opened: string[] = [];
  const sample = fixture({ sampleData: true }, { openPage: async address => { opened.push(address); } });
  try {
    await sample.instance.start();
    await assert.rejects(() => sample.call('open-device-page', { address: '10.192.1.10' }), /Sample devices have no web page/);
    assert.deepEqual(opened, []);
  } finally { await sample.instance.dispose(); }
});

test('the helper that opens pages is declared as a command, since it starts a program', () => {
  const helper = manifest.helpers?.find(item => item.id === 'icmp-probe');
  assert.deepEqual(helper?.methods.find(method => method.id === 'open-page'), { id: 'open-page', readOnly: false, timeoutMs: 10000 });
  // The ping it already ran is unchanged.
  assert.deepEqual(helper?.methods.find(method => method.id === 'batch'), { id: 'batch', readOnly: true, timeoutMs: 10000 });
});

test('a page can be opened while Discover has a ping batch going on every worker', () => {
  const helper = manifest.helpers?.find(item => item.id === 'icmp-probe');
  assert.ok(helper!.maxConcurrent >= pingPolicy.workers + 4, 'Hubble refuses a call past maxConcurrent, so a search would leave no room for a link');
});
