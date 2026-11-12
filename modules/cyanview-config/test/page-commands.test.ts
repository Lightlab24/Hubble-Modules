import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../src/manifest.js';

// Hubble passes a module page only the commands its manifest declares. A command the page calls but the
// manifest leaves out is refused in Hubble while it still works in tests that call the worker directly.
test('every command the page calls is declared in the manifest, and the worker answers each declared one', async () => {
  const frontend = await readFile(path.resolve('src/frontend.ts'), 'utf8');
  const calls = [...frontend.matchAll(/client\.call\(([^,)]+)/g)].map(match => match[1]!.trim());
  const computed = calls.filter(call => !/^'[a-z-]+'$/.test(call));
  assert.deepEqual(computed, [], 'Each page command is named as a literal, so this test can see it');
  const called = new Set(calls.map(call => call.slice(1, -1)));
  const section = manifest.pages?.[0]?.sections?.[0] as { commands?: { id: string }[] } | undefined;
  const declared = new Set((section?.commands ?? []).map(command => command.id));
  assert.deepEqual([...called].filter(id => !declared.has(id)), [], 'Called but not declared');
  const worker = await readFile(path.resolve('src/index.ts'), 'utf8');
  const answered = new Set([...worker.matchAll(/case '([a-z-]+)':/g)].map(match => match[1]!));
  assert.deepEqual([...declared].filter(id => !answered.has(id)), [], 'Declared but not answered by the worker');
});
