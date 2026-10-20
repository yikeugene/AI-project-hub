import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import releaseSource from './release-source.cjs';
import { buildGitTools } from './build-git-tools.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.desktop-build', 'app');
const previous = await lstat(stage).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (previous?.isSymbolicLink() || (previous && !previous.isDirectory())) throw new Error('Desktop build output must be an ordinary directory, not a link.');
if (previous) await rm(stage, { recursive: true });
await mkdir(stage, { recursive: true });
await buildGitTools(join(stage, 'git-tools'));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(stage, 'release-source.json'), JSON.stringify(releaseSource.getReleaseSource(), null, 2));
await cp(join(root, 'LICENSE'), join(stage, 'LICENSE-AI-PROJECT-HUB.txt'));
const [mainBuild] = await Promise.all([
  build({ entryPoints: [join(root, 'desktop', 'main.ts')], outfile: join(stage, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:*'], sourcemap: false, metafile: true }),
  build({ entryPoints: [join(root, 'desktop', 'preload.ts')], outfile: join(stage, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], sourcemap: false }),
]);
await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
await writeFile(join(stage, 'package.json'), JSON.stringify({
  name: pkg.name, productName: 'AI Project Hub', version: pkg.version, description: pkg.description,
  author: pkg.author, license: pkg.license, private: true, main: 'main.cjs',
}, null, 2));

const packageDirs = new Set(['react', 'react-dom', 'scheduler', 'lucide-react'].map(name => join(root, 'node_modules', name)));
for (const input of Object.keys(mainBuild.metafile.inputs)) {
  const normalized = input.replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('node_modules/');
  if (marker < 0) continue;
  const segments = normalized.slice(marker + 13).split('/');
  const name = segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  packageDirs.add(resolve(root, normalized.slice(0, marker), 'node_modules', name));
}
const notices = ['AI Project Hub — bundled dependency notices\nElectron/Chromium notices are included separately in LICENSE and LICENSES.chromium.html.\nThese notices apply to the listed dependencies, not to the application source as a whole.'];
for (const directory of [...packageDirs].sort()) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'COPYING']) {
    try { license = await readFile(join(directory, filename), 'utf8'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // This exact upstream package declares MIT but ships no separate license file.
  if (!license && metadata.name === 'lazy-val' && metadata.version === '1.0.5' && metadata.license === 'MIT' && metadata.author === 'Vladimir Krivosheev') {
    license = await readFile(join(root, 'licenses', 'lazy-val-1.0.5.txt'), 'utf8');
  }
  if (!license) throw new Error(`Missing license notice for bundled dependency ${metadata.name}`);
  notices.push(`${metadata.name} ${metadata.version}\n${'='.repeat(72)}\n${license}`);
}
await writeFile(join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n'));

// Original geometric Hub mark; PNG-backed ICO needs no graphics/native addon.
const size = 256;
const pixels = Buffer.alloc(size * size * 4);
function rect(x, y, width, height, color) {
  for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
    const at = (row * size + col) * 4; pixels[at] = color[0]; pixels[at + 1] = color[1]; pixels[at + 2] = color[2]; pixels[at + 3] = 255;
  }
}
rect(28, 48, 108, 92, [79, 70, 200]); rect(132, 28, 96, 96, [188, 181, 234]);
rect(28, 152, 96, 76, [188, 181, 234]); rect(144, 128, 84, 100, [79, 70, 200]);
rect(88, 96, 92, 72, [101, 87, 206]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  let crc = 0xffffffff; for (const byte of Buffer.concat([name, data])) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let row = 0; row < size; row++) pixels.copy(scanlines, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await Promise.all([writeFile(join(stage, 'icon.png'), png), writeFile(join(stage, 'icon.ico'), Buffer.concat([ico, png]))]);
console.log(`Desktop stage ready: ${stage}\nBundled runtime code; no system Node/npm/tsx required by the packaged app.`);
