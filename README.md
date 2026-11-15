# AIatUSC · Campus Access

Campus walking routes and gate-aware driving to surveyed USC parking entrances, deployed with Cloudflare Workers and D1. Node.js 24 LTS is recommended.

Read [UPDATE_EN.md](UPDATE_EN.md) to update an existing deployment (`git pull`, then the new D1 migration). A full setup guide is in [CLOUDFLARE_EN.md](CLOUDFLARE_EN.md).

```bash
npm install
npm run db:local
npm run dev
```

Driving requires a private `ORS_API_KEY` and D1. Walking uses the included graph. Public reports remain unverified until staff approval. Vehicle gate hours do not close pedestrian paths.

The app offers driving/walking selection, parking entrance guidance, an explicit parked-to-walking transition, gate schedules, staff gate/road restrictions, and conservative home-game-date avoidance. Football dates are a checked 2026 snapshot. The official traffic map is linked; the app's precautionary corridors are approximate and do not encode the map's egress arrows. No live traffic, occupancy feed, voice guidance, or photo-based indoor navigation is provided.

```bash
npm run check
npm test
npm run check:parity
```
