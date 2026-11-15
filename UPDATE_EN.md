# Update an existing AIatUSC deployment

This release provides an English interface for driving/walking selection, parking entrance guidance, an explicit parked-to-walking transition, gate status, game-day precautions, and staff vehicle restrictions. Public reporting is enabled.

## Apply the update

Updates arrive through git, not ZIP files. Copying files over a checkout can bring back older versions of other files (that is how two earlier fixes were undone), so there is no file-copy installer.

1. In your existing project folder: `git pull origin main`
2. Apply the new database migration, local and remote:

```bash
npm run db:local
npm run db:remote
```

Migration `0002_mobility.sql` adds vehicle restrictions and request counters. It does not delete existing reports, and already-applied migrations are skipped. Once the GitHub Actions deploy is set up, merging to `main` applies remote migrations and deploys automatically.

## Connect the driving API

Create an account and obtain an API key through [openrouteservice](https://account.heigit.org/). Check the currently available free plan, quotas, and usage conditions in your account. The app does not subscribe to a paid plan or register payment details.

From your existing project folder, run:

```bash
npm run secret:routing
```

Paste the key into the private prompt. Do not put it in chat, GitHub, a URL, or source code. If you already configured `ORS_API_KEY`, skip this step. Your existing `ADMIN_TOKEN` can remain in place.

```bash
npm run check
npm test
npm run deploy
```

No new npm dependency is required for this release. Run `npm install` first only if the existing dependencies are missing.

Open `/api/health` on your deployed site. A fully configured deployment includes:

```json
{
  "database": "connected",
  "walking_routes": true,
  "driving_routes": true,
  "parking_handoff": true,
  "mobility_migration": "ready",
  "public_reports": true,
  "live_traffic": false,
  "turn_by_turn": false
}
```

If `driving_routes` is false, check D1, the new migration, and `ORS_API_KEY`. Walking and gate information remain available without a driving key. The health flag indicates configuration; an actual driving request is still needed to verify that the provider accepts your key.

## Try the app

1. Select **Drive + park**, choose your starting point and destination building, then select a parking structure or leave automatic selection enabled.
2. Select **Find route**. Blue is the driving route; dotted green is the walking continuation. Automatic selection ranks eligible structures using approximate approach and walking distances, then tries at most two candidates. It does not guarantee the fastest route or an available space.
3. After you actually park, select **I have parked · continue walking**. The app keeps your destination and starts walking guidance at the registered pedestrian exit. Select **Use my location** to recalculate from your actual GPS position.
4. Gate statuses distinguish scheduled open, closed, and access requirements. Vehicle hours do not determine pedestrian access. Approximate gate pins are labeled.
5. Anyone can report driving or walking blockages. Public reports are unverified until staff approval; staff reports are approved immediately. Older reports without travel modes are treated as walking reports. The map and review list show up to 20 recent unverified reports.

For local driving tests, copy `outdoor-nav/.dev.vars.example` to `.dev.vars`, configure `ORS_API_KEY` and `ADMIN_TOKEN`, and run `npm run dev`. The original Python server does not implement the new mobility endpoints.

## Football schedule and traffic map

Official references:

- [USC Entrance Hours](https://transnet.usc.edu/index.php/about-us/entrance-hours/)
- [USC Football Schedule](https://usctrojans.com/sports/football/schedule)
- [Game Day Traffic Map](https://gameday.usc.edu/getting-here/post-game-traffic-flow/)
- [Traffic map image linked from the official page](https://bpb-us-w1.wpmucdn.com/sites.usc.edu/dist/0/639/files/2023/08/image.png)
- [USC Transportation game-day parking](https://transnet.usc.edu/index.php/gameday/)

`data/football.json` contains the seven 2026 home-game dates checked on November 14, 2026. Away games do not activate campus precautions. This is a schedule snapshot, not a live feed. Staff must check changes, update the file, and redeploy. Driving is unavailable for years without a registered schedule.

Official guidance describes closures from the **end of the third quarter until approximately 60 minutes after the game**. The app does not infer these times by adding an assumed game duration to kickoff. The official page still contains a 2025 construction note, and the image URL contains 2023; current on-site instructions require verification.

On registered home-game dates, this version conservatively avoids campus-area portions of Exposition, Figueroa, Flower, and MLK **all day**. Amber areas are precautionary detours, not confirmed closures or a precise digitization of the official map. This policy can avoid roads that are actually open. The app does not encode the map's parking-egress arrows, police-directed intersection movements, or HOT-lane access. It previews routes arriving at campus.

Staff can register confirmed restrictions in **Staff / organizer**:

- Choose a temporary vehicle gate closure, select the gate, and enter the actual start and end in Los Angeles time.
- Choose a vehicle road closure area, select **Draw area**, and mark its boundary on the map. Enter confirmed start and end times.
- Use the official red closure lines and same-day staff confirmation. Registered restrictions expire automatically. Vehicle restrictions do not automatically block walking paths.

The model does not guarantee compliance with special event-day one-way or exit-only directions. Exclude those areas conservatively through staff road restrictions and follow on-site instructions. Do not present this version as a complete implementation of every traffic-map rule.

## Accuracy, limits and validation

- Driving uses the openrouteservice vehicle road network. The app sends avoidance polygons and checks returned line segments against restricted areas. It checks the requested gate and parking endpoint; failing routes are discarded.
- Gate access is checked at departure, arrival, and approximate crossing times. There is no live gate sensor feed. Temporary restrictions require staff entry.
- McClintock and Watt gate coordinates, parking entrances, and pedestrian exits come from the supplied field data. Other gate pins approximate the intersections described by USC. All gate positions and vehicle connections have not been verified on site.
- The entrance-hours source does not specify a holiday date calendar. Unregistered holidays may use ordinary weekday hours; staff should register temporary gate restrictions.
- Live congestion, parking occupancy, voice/continuous turn-by-turn navigation, automatic parking detection, long-distance walking outside the campus map, and photo-based indoor navigation are unavailable.
- The app limits upstream driving requests to **10 per minute and 500 per UTC day**, shared across all visitors. A route search can use up to two provider requests. GPS-based driving recalculation waits at least 45 seconds. Provider quotas and conditions apply separately.
- Public reports are limited to **10 per minute and 100 per UTC day** across the app. They do not change routes before approval.
- Cloudflare CPU, D1, and request limits apply separately. Actual Workers CPU use and real provider responses require deployment verification.

Validation: 39 Node API, SQL, and interface-transition tests; 44 full-response comparisons with the original Python walking router. The driving provider and DOM/map are test doubles. Real provider calls, visual browser rendering, and production deployment have not been verified in this environment.
