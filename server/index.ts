import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHubRuntime } from './runtime.js';
import { validLocalRequest } from './app.js';
import { APP_VERSION } from '../shared/types.js';
import { appError } from './validation.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production');
const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const port = Number(arg('--port') || process.env.PORT || 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw appError(400, 'runtime.webPort');
const runtime = await createHubRuntime({
  dataDir: arg('--data-dir'), assetDirectory: join(root, 'dist'), port, mode: 'web',
  configureDevelopment: production ? undefined : async (app, server) => {
    const { createServer } = await import('vite');
    const vite = await createServer({ root, server: {
      middlewareMode: true, hmr: { server }, allowedHosts: ['127.0.0.1', 'localhost'],
      fs: { strict: true, allow: [root], deny: ['**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**', '**/.local/**', '**/.desktop-build/**', '**/release/**', '**/*.sqlite*', '**/*.db*'] },
    }, appType: 'spa' });
    app.use(vite.middlewares);
    server.prependListener('upgrade', (req, socket) => { if (!validLocalRequest(req)) socket.destroy(); });
    return () => vite.close();
  },
});
console.log(`\n  AI Project Hub v${APP_VERSION}\n  ${runtime.origin}\n  Data: ${runtime.dataDir}\n  Mode: ${production ? 'production web' : 'development web'}\n  Local only. No telemetry.\n`);
process.on('SIGINT', () => { void runtime.stop().then(() => process.exit()); });
process.on('SIGTERM', () => { void runtime.stop().then(() => process.exit()); });
