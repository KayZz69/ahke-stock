// Runs wrangler against this project's own Cloudflare account, using the token in
// .cloudflare-token (gitignored). Keeps the machine-wide `wrangler login` untouched,
// so other projects keep deploying to their own account.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ACCOUNT_ID = 'e8ff99a9f8c199d4e9da1aed8acc4b6c';
let token;
try { token = fs.readFileSync(new URL('../.cloudflare-token', import.meta.url), 'utf8').trim(); }
catch { console.error('Missing .cloudflare-token — put the Cloudflare API token for this project in it.'); process.exit(1); }

const r = spawnSync('npx', ['wrangler', ...process.argv.slice(2)], {
  stdio: 'inherit', shell: true,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }
});
process.exit(r.status ?? 1);
