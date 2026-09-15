// Bundles the extension the way the other built-ins are bundled (extensions/esbuild-extension-common.mts):
// typecheck, then one dist/extension.js. The build packages dist/, media/, skills/ and themes/.
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';

const srcDir = path.join(import.meta.dirname, 'src');
const outDir = path.join(import.meta.dirname, 'dist');

run({
	platform: 'node',
	entryPoints: {
		'extension': path.join(srcDir, 'extension.ts'),
	},
	srcDir,
	outdir: outDir,
}, process.argv);
