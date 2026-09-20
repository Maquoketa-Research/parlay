import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as discovery from '../src/studioDiscovery.ts';
const require = createRequire(import.meta.url);
const source = ts.transpileModule(fs.readFileSync(new URL('../src/macStudioSync.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
runInNewContext(source, { exports: module.exports, module, require: name => name === './studioDiscovery' ? discovery : require(name), console });
const { macRecordNames, macEntries, mergeMacEntries, writeMacSync, native, readMacPreferences } = module.exports;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parlay-mac-sync-'));
const record = 'File_Sync_Persistence_Record_V1:123456:abcd-1234';
const existing = { className: 'ReplicatedStorage', filePath: '/existing/game/ReplicatedStorage', scriptId: 'original-id', status: 'Syncing', custom: 'preserve' };
const initial = { [record]: JSON.stringify([existing]), [record + '_lastUsedDir']: '/existing/game', [record + '_timeLastUsed']: 1789891579271, unrelated: 'untouched' };
let prefs, calls, failures;
const io = {
 read: async () => ({ ...prefs }), running: async () => false,
 run: async (_file, args) => {
  calls.push(args);
  if (failures?.(args)) throw new Error('simulated write failure');
  if (args[0] === 'delete') delete prefs[args[2]];
  else prefs[args[2]] = args[3] === '-int' ? Number(args[4]) : args[4];
  return '';
 },
};
const reset = () => { prefs = { ...initial }; calls = []; failures = undefined; };
try {
 assert.equal(macRecordNames(initial, '123456')[0], record);
 assert.equal(macRecordNames(initial, '9').length, 0);
 assert.throws(() => macEntries('not json'));
 assert.throws(() => macEntries('[{"className":"Invalid"}]'));
 const ids = new Map([['ReplicatedStorage', 'new-id'], ['ServerScriptService', 'service-id']]);
 const merged = mergeMacEntries([existing], '/my project', ids);
 assert.equal(merged[0], existing);
 assert.equal(merged[1].filePath, '/my project/ServerScriptService');
 reset();
 const result = await writeMacSync(record, '/my project', ids, root, io);
 assert.equal(prefs.unrelated, 'untouched');
 assert.equal(JSON.parse(prefs[record])[0].custom, 'preserve');
 assert.equal(result.entries.length, 2);
 assert.deepEqual(JSON.parse(fs.readFileSync(result.backup)).before, Object.fromEntries(Object.entries(initial).filter(([key]) => key !== 'unrelated')));
 reset();
 await assert.rejects(writeMacSync(record, '/game', ids, root, { ...io, running: async () => true }), /Quit Roblox/);
 assert.equal(calls.length, 0);
 reset();
 let reads = 0;
 await assert.rejects(writeMacSync(record, '/game', ids, root, { ...io, running: async () => ++reads > 1 }), /reopened/);
 assert.equal(calls.length, 0);
 reset();
 let failed = false;
 failures = args => !failed && args[2].endsWith('_lastUsedDir') ? (failed = true) : false;
 await assert.rejects(writeMacSync(record, '/game', ids, root, io), /simulated/);
 assert.deepEqual(prefs, initial, 'partial writes must roll back');
 reset();
 await assert.rejects(writeMacSync(record.replace('123456', '999'), '/game', ids, root, io), /no longer exists/);
 assert.equal(calls.length, 0);
 reset();
 const project = path.join(root, 'new-project');
 fs.mkdirSync(path.join(project, 'ServerScriptService'), { recursive: true });
 await writeMacSync(record, project, ids, root, io);
 assert.equal(fs.existsSync(path.join(project, 'ServerScriptService')), false, 'empty new service directory must be left for Studio to create');
 reset();
 fs.mkdirSync(path.join(project, 'ServerScriptService'));
 fs.writeFileSync(path.join(project, 'ServerScriptService', 'keep.luau'), 'return 1');
 await writeMacSync(record, project, ids, root, io);
 assert.equal(fs.readFileSync(path.join(project, 'ServerScriptService', 'keep.luau'), 'utf8'), 'return 1');
 console.log('Mac sync: preserves mappings, backup, running/reopen guards, missing records and partial-write rollback passed');
 if (process.env.PARLAY_MAC_SYNC_TEST_NATIVE === '1' && process.platform === 'darwin') {
  const domain = `net.parlay.sync-test-${process.pid}-${Date.now()}`;
  try {
   await native('/usr/bin/defaults', ['write', domain, record, '-string', JSON.stringify([existing])]);
   await native('/usr/bin/defaults', ['write', domain, 'unrelated', '-string', 'keep']);
   const adapter = { running: async () => false, read: () => readMacPreferences(domain), run: (file, args) => native(file, args.map(arg => arg === 'com.roblox.RobloxStudio' ? domain : arg)) };
   await writeMacSync(record, path.join(root, 'project'), ids, root, adapter);
   const actual = await readMacPreferences(domain);
   assert.equal(JSON.parse(actual[record]).length, 2);
   assert.equal(actual.unrelated, 'keep');
   assert.ok(actual[record + '_timeLastUsed'] > 1_000_000_000_000);
   console.log('Mac sync: native CFPreferences read/write/read-back passed in isolated test domain');
  } finally { await native('/usr/bin/defaults', ['delete', domain]); }
 }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
