# Deploy AIatUSC to Cloudflare

For an existing deployment, follow [UPDATE_EN.md](UPDATE_EN.md). You do not need to recreate your database or Secrets.

## First-time setup

Install Node.js 24 LTS and open the project root in VS Code. Run commands from the folder containing `package.json`.

```bash
npm install
npm run check
npm test
npm run dev
```

Open the localhost URL shown by Wrangler. Without D1, the app is a read-only preview.

```bash
npm run cf:login
npm run db:create
```

If Wrangler offers to add a binding automatically, choose No, then use the database UUID it prints:

```bash
npm run db:bind -- YOUR_DATABASE_UUID
npm run db:local
npm run db:remote
npm run secret:admin
npm run secret:routing
npm run deploy
```

`secret:admin` prompts for your private staff token. `secret:routing` prompts for your openrouteservice key. The driving key is optional if you only need walking. Never put real Secrets in chat, GitHub, or source code.

Check `/api/health` on the deployed URL. A fully configured deployment has `database: connected`, `mobility_migration: ready`, `walking_routes: true`, `driving_routes: true`, and `public_reports: true`. Configuration flags do not validate the provider key; test an actual route too. `live_traffic: false` and `turn_by_turn: false` are expected.

Public reports are enabled in the deployment configuration. They do not affect routes before staff approval. Staff tokens are kept in the current browser tab. Old local reports in `data/closures.json` are not automatically imported into D1.

## Later updates

```bash
npm run check
npm test
npm run deploy
```

Run `npm run db:local` and `npm run db:remote` when an update adds a migration. If you change the original walking datasets, building data, surveyed walking data, or `data/gates.json`, rebuild the graph:

```bash
npm run build:graph
npm run check:parity
npm test
npm run deploy
```

Changes only to `data/mobility.json` or `data/football.json` do not require a graph rebuild. Update their verification dates after checking the sources.

The original Python server preserves the old walking API. The new interface, driving endpoints, and staff vehicle restrictions use the Cloudflare JavaScript runtime. Use `npm run dev` for development.

See [UPDATE_EN.md](UPDATE_EN.md) for source accuracy, approximate gate coordinates, game-day precautions, request limits, and validation boundaries.
