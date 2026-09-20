import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parlay-sourcemap-'));
const watchers = [];
let folderChanged;
class Watcher {
 constructor(pattern) { this.pattern = pattern; watchers.push(this); }
 onDidCreate(fn) { this.create = fn; return { dispose() {} }; }
 onDidDelete(fn) { this.delete = fn; return { dispose() {} }; }
 onDidChange(fn) { this.change = fn; return { dispose() {} }; }
 dispose() { this.disposed = true; }
}
const folder = { uri: { fsPath: root } };
const vscode = { RelativePattern: class { constructor(folder, pattern) { this.folder = folder; this.pattern = pattern; } }, workspace: { workspaceFolders: [folder], createFileSystemWatcher: pattern => new Watcher(pattern), onDidChangeWorkspaceFolders: fn => { folderChanged = fn; return { dispose() {} }; } } };
const module = { exports: {} };
const js = ts.transpileModule(fs.readFileSync(new URL('../src/sourcemap.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
runInNewContext(js, { module, exports: module.exports, require: name => ({ fs, path, vscode })[name], console, setTimeout, clearTimeout });
const ctx = { subscriptions: [] };
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
try {
 module.exports.startSourcemap(ctx);
 assert.equal(watchers.length, 1, 'empty project must be watched');
 assert.equal(fs.existsSync(path.join(root, 'sourcemap.json')), false);
 const file = path.join(root, 'ReplicatedStorage', 'Shared', 'Hello.luau');
 fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'return {}');
 watchers[0].create({ fsPath: file }); await pause();
 const read = () => JSON.parse(fs.readFileSync(path.join(root, 'sourcemap.json'), 'utf8'));
 assert.equal(read().children[0].children[0].children[0].filePaths[0], 'ReplicatedStorage/Shared/Hello.luau');
 const packageFile = path.join(root, 'ReplicatedStorage', 'Packages', 'Fusion.luau');
 fs.mkdirSync(path.dirname(packageFile), { recursive: true }); fs.writeFileSync(packageFile, 'return {}');
 watchers[0].create({ fsPath: packageFile }); await pause();
 assert.ok(JSON.stringify(read()).includes('ReplicatedStorage/Packages/Fusion.luau'), 'synced package modules must resolve');
 fs.unlinkSync(file); watchers[0].delete({ fsPath: file }); await pause();
 assert.ok(!JSON.stringify(read()).includes('Hello.luau'));
 fs.unlinkSync(path.join(root, 'sourcemap.json')); watchers[0].delete({ fsPath: path.join(root, 'sourcemap.json') }); await pause();
 assert.ok(fs.existsSync(path.join(root, 'sourcemap.json')));
 fs.writeFileSync(path.join(root, 'default.project.json'), '{}');
 fs.writeFileSync(path.join(root, 'sourcemap.json'), 'owned by Rojo');
 watchers[0].create({ fsPath: file }); await pause();
 assert.equal(fs.readFileSync(path.join(root, 'sourcemap.json'), 'utf8'), 'owned by Rojo');
 folderChanged({ removed: [folder], added: [] });
 assert.equal(watchers[0].disposed, true);
 console.log('Sourcemap: initially empty project, delayed sync, script deletion, map recovery and Rojo ownership passed');
} finally { for (const disposable of ctx.subscriptions) disposable.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
