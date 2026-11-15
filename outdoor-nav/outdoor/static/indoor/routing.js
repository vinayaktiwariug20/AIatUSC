// M3: extracted from indoor_demo/index.html; no DOM or Three.js dependencies.
export function createRouting(NAV) {
if (!NAV || !Number.isInteger(NAV.count) || NAV.count < 1 || !Number.isInteger(NAV.nx) || !Number.isInteger(NAV.nz) || NAV.nx < 1 || NAV.nz < 1 || !Number.isFinite(NAV.cell) || NAV.cell <= 0) throw new Error('Invalid navigation graph.');
const FLOOR_H = NAV.floorH;
// ---- walkable nodes ------------------------------------------------------------------------
// Each node is a 15 cm cell of floor or stair with its own height. Neighbours join when the height step is small,
// so a staircase is a chain of nodes that climbs and the same search covers both floors.
const { nx, nz, cell, count: N } = NAV;
const raw = Uint8Array.from(atob(NAV.nodes), c => c.charCodeAt(0));
if (raw.length !== N * 8) throw new Error('Invalid navigation node data.');
const data = new DataView(raw.buffer);
const packed = Int16Array.from({length:N * 4}, (_,i) => data.getInt16(i * 2, true));
const nodeI = new Int32Array(N), nodeJ = new Int32Array(N), nodeH = new Float64Array(N), nodeD = new Float32Array(N);
const cellStart = new Int32Array(nx * nz + 1);
for (let k = 0; k < N; k++) {
  nodeI[k] = packed[4 * k]; nodeJ[k] = packed[4 * k + 1]; nodeH[k] = packed[4 * k + 2] / 100; nodeD[k] = packed[4 * k + 3] / 4;
  if (nodeI[k] < 0 || nodeI[k] >= nx || nodeJ[k] < 0 || nodeJ[k] >= nz || (k && nodeJ[k]*nx+nodeI[k] < nodeJ[k-1]*nx+nodeI[k-1])) throw new Error('Invalid or unsorted navigation grid.');
  cellStart[nodeJ[k] * nx + nodeI[k] + 1]++;
}
for (let c = 0; c < nx * nz; c++) cellStart[c + 1] += cellStart[c];        // nodes are stored sorted by cell
const worldX = (k) => NAV.x0 + (nodeI[k] + 0.5) * cell, worldZ = (k) => NAV.z0 + (nodeJ[k] + 0.5) * cell;
const MOVES = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];

function nodeAt(i, j, h, tol) {             // the node in cell (i, j) whose height is closest to h, or -1
  if (i < 0 || j < 0 || i >= nx || j >= nz) return -1;
  let best = -1, bestD = tol;
  for (let k = cellStart[j * nx + i]; k < cellStart[j * nx + i + 1]; k++) {
    const d = Math.abs(nodeH[k] - h);
    if (d <= bestD) { bestD = d; best = k; }
  }
  return best;
}

function snap(pos, floor) {
  const level = floor === 2 ? FLOOR_H : 0;
  let best = -1, bestD = Infinity;
  for (let k = 0; k < N; k++) {
    if (Math.abs(nodeH[k] - level) > 0.4 || nodeD[k] < 2) continue;
    const d = (worldX(k) - pos[0]) ** 2 + (worldZ(k) - pos[1]) ** 2;
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

function findNodes(s, t) {
  if (![s,t].every(k => Number.isInteger(k) && k >= 0 && k < N)) throw new Error('Invalid navigation node ID.');
  // A* on the existing NAV edges. Cost and heuristic are both 3D metres.
  // Euclidean h is consistent by the triangle inequality; no clearance penalty.
  const g = new Float64Array(N).fill(Infinity), came = new Int32Array(N).fill(-1);
  const heapK = [], heapV = [];
  const push = (k, v) => {
    let n = heapK.length; heapK.push(k); heapV.push(v);
    while (n > 0) { const p = (n - 1) >> 1; if (heapK[p] <= heapK[n]) break; [heapK[p], heapK[n]] = [heapK[n], heapK[p]]; [heapV[p], heapV[n]] = [heapV[n], heapV[p]]; n = p; }
  };
  const pop = () => {
    const v = heapV[0], lk = heapK.pop(), lv = heapV.pop();
    if (heapK.length) {
      heapK[0] = lk; heapV[0] = lv;
      let n = 0;
      for (;;) {
        const l = 2 * n + 1, r = l + 1; let m = n;
        if (l < heapK.length && heapK[l] < heapK[m]) m = l;
        if (r < heapK.length && heapK[r] < heapK[m]) m = r;
        if (m === n) break;
        [heapK[m], heapK[n]] = [heapK[n], heapK[m]]; [heapV[m], heapV[n]] = [heapV[n], heapV[m]]; n = m;
      }
    }
    return v;
  };
  g[s] = 0; push(distance(s, t), s);
  const done = new Uint8Array(N);
  while (heapK.length) {
    const k = pop();
    if (done[k]) continue;
    done[k] = 1;
    if (k === t) break;
    for (const [di, dj, w] of MOVES) {
      const u = nodeI[k] + di, v = nodeJ[k] + dj;
      if (u < 0 || v < 0 || u >= nx || v >= nz) continue;
      for (let q = cellStart[v * nx + u]; q < cellStart[v * nx + u + 1]; q++) {
        if (Math.abs(nodeH[q] - nodeH[k]) > 0.24 * w) continue;
        const c = g[k] + distance(k, q);
        if (c < g[q]) { g[q] = c; came[q] = k; push(c + distance(q, t), q); }
      }
    }
  }
  if (!Number.isFinite(g[t])) return null;
  const path = [];
  for (let k = t; k !== -1; k = came[k]) path.push(k);
  return path.reverse();
}

function simplify(points, tol) {                       // Douglas-Peucker on [x, y, z] points, measured on the plan
  if (points.length < 3) return points.slice();
  const [a, b] = [points[0], points[points.length - 1]];
  let far = 0, idx = -1;
  const L = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1e-9;
  for (let k = 1; k < points.length - 1; k++) {
    const d = Math.abs((points[k][0] - a[0]) * (b[2] - a[2]) - (points[k][2] - a[2]) * (b[0] - a[0])) / L;
    if (d > far) { far = d; idx = k; }
  }
  if (far <= tol) return [a, b];
  return simplify(points.slice(0, idx + 1), tol).slice(0, -1).concat(simplify(points.slice(idx), tol));
}

const zoneOf = (y) => (y < 0.3 ? 1 : y > FLOOR_H - 0.3 ? 2 : 0);          // floor 1, floor 2, or 0 for the stairs between

function routeBetweenNodes(startNodeId, destinationNodeId) {
  const nodes = findNodes(startNodeId, destinationNodeId);
  if (!nodes) return null;
  // Render the exact shortest graph polyline. Pulling/smoothing would introduce
  // off-graph shortcuts and change the distance being reported to the user.
  const world = nodes.map(point);
  const pts = world.length === 1 ? [world[0], world[0].slice()] : world;
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2]));
  const nearest = (p) => {
    let near = 0, best = Infinity;
    pts.forEach((q, i) => { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 * 4 + (q[2] - p[2]) ** 2; if (d < best) { best = d; near = i; } });
    return cum[near];
  };
  // 3. written directions: split the path into floor runs and stair runs, then name the main bends of each floor run
  const runs = [];
  world.forEach((p) => {
    const zone = zoneOf(p[1]);
    if (runs.length && runs[runs.length - 1].zone === zone) runs[runs.length - 1].pts.push(p);
    else runs.push({ zone, pts: runs.length ? [runs[runs.length - 1].pts.at(-1), p] : [p] });
  });
  const heading = (a, b) => Math.atan2(b[0] - a[0], b[2] - a[2]);
  const wrap = (r) => Math.atan2(Math.sin(r), Math.cos(r));
  const metres = (m) => (m < 1.5 ? 'a few steps' : Math.round(m) + ' m');
  const side = (t) => (t > 0 ? 'left' : 'right');
  const steps = [];
  const first = pts[Math.min(pts.length - 1, 6)];
  let prev = heading(pts[0], first), after = '';
  for (const run of runs) {
    if (run.zone === 0) {
      const up = run.pts.at(-1)[1] > run.pts[0][1];
      steps.push({ text: 'Take the stairs ' + (up ? 'up to floor 2' : 'down to floor 1'), start: nearest(run.pts[0]) });
      const n = run.pts.length;
      prev = heading(run.pts[Math.max(0, n - 3)], run.pts[n - 1]);
      after = up ? 'At the top, ' : 'At the bottom, ';
      continue;
    }
    const bends = simplify(run.pts, 0.7), legs = [];
    for (let k = 0; k < bends.length - 1; k++) {
      const h = heading(bends[k], bends[k + 1]);
      const turn = (wrap(h - prev) * 180) / Math.PI;      // positive = left when y is up
      const len = Math.hypot(bends[k + 1][0] - bends[k][0], bends[k + 1][2] - bends[k][2]);
      if (legs.length && Math.abs(turn) < 30) legs[legs.length - 1].len += len;
      else legs.push({ turn, len, at: bends[k] });
      prev = h;
    }
    legs.forEach((leg, k) => {
      const a = Math.abs(leg.turn);
      let text;
      if (a < 30) text = (steps.length === 0 ? 'head straight for ' : 'keep going for ') + metres(leg.len);
      else if (a < 60) text = 'bear ' + side(leg.turn) + ' and walk ' + metres(leg.len);
      else if (a < 150) text = 'turn ' + side(leg.turn) + ' and walk ' + metres(leg.len);
      else text = 'turn around and walk ' + metres(leg.len);
      text = (k === 0 ? after : '') + text;
      steps.push({ text: text[0].toUpperCase() + text.slice(1), start: nearest(leg.at) });
    });
    after = '';
  }
  steps.push({ text: 'You have arrived', start: Math.max(0, cum[cum.length - 1] - 2.2) });
  return { nodeIds: nodes, nodePoints: nodes.map(point), clearances: nodes.map(k=>nodeD[k]*cell), startNodeId, destinationNodeId, pts, cum, length: cum[cum.length - 1], steps, face: [first[0] - pts[0][0], first[2] - pts[0][2]] };
}


function point(k) { return [worldX(k), nodeH[k], worldZ(k)]; }
function distance(a,b) { return Math.hypot(worldX(b)-worldX(a), nodeH[b]-nodeH[a], worldZ(b)-worldZ(a)); }
function isTraversable(points) {
  for (let i=0;i<points.length;i++) {
    const a=points[i], b=points[Math.min(i+1,points.length-1)];
    const n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2])/(cell/2)));
    for(let j=0;j<=n;j++) { const f=j/n, p=a.map((v,c)=>v+(b[c]-v)*f);
      const u=(p[0]-NAV.x0)/cell,v=(p[2]-NAV.z0)/cell;
      const columns=[Math.floor(u)],rows=[Math.floor(v)];
      // At an exact cell boundary/corner, either touching cell can support the
      // point. This preserves the reference NAV's legal diagonal stair edges.
      if(Math.abs(u-Math.round(u))<1e-9)columns.push(Math.round(u),Math.round(u)-1);
      if(Math.abs(v-Math.round(v))<1e-9)rows.push(Math.round(v),Math.round(v)-1);
      if(!columns.some(i=>rows.some(j=>nodeAt(i,j,p[1],0.3)>=0))) return false;
    }
  }
  return true;
}
return { findRoute: routeBetweenNodes, snap(location) {
  if (!location || ![1,2].includes(location.floor) || !Array.isArray(location.pos) || location.pos.length!==2 || !location.pos.every(Number.isFinite)) throw new Error('Invalid location.');
  const k=snap(location.pos, location.floor);
  if(k<0 || Math.hypot(worldX(k)-location.pos[0],worldZ(k)-location.pos[1])>1) throw new Error('Location is outside the walkable grid.');
  return k;
}, point(k) { if(!Number.isInteger(k)||k<0||k>=N)throw new Error('Invalid navigation node ID.');return point(k); }, isTraversable, count:N };
}
