# AIatUSC: event wayfinding

Scan an event's QR code, get walked to the building, then guided to the room inside.

| folder | what |
|---|---|
| [`outdoor-nav/`](outdoor-nav/) | far from the venue: campus walking routes around live closures, gate hours, incident reports; hands off at the building door |

Paths and buildings are from OpenStreetMap (ODbL), see `outdoor-nav/README.md`.

## Cloudflare deployment / VS Code

See [CLOUDFLARE_KO.md](CLOUDFLARE_KO.md) for Korean setup instructions.
The root package.json runs the new Cloudflare JavaScript adapter. The original Python server remains available.

```bash
npm install
npm run dev
```

Deploy from this repository root with `npm run cf:login` and `npm run deploy`.
Without D1, the deployment is explicitly read-only. Vehicle gate schedules exist,
but driving routes and a driving/walking selector are not implemented yet.
The current route engine is walking-only.
