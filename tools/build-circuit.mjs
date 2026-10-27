// 서킷 데이터 생성: Overpass(OSM highway=raceway) + Copernicus DEM → public/<id>.json
// 실행: node tools/build-circuit.mjs
// 지도 데이터 © OpenStreetMap contributors (ODbL)
import { mkdir, writeFile } from 'node:fs/promises';
import { boundsOf, demGrid, facadeOf, heightOf, loadDem, movingAverage, overpass, projection, r1, r2, resample, simplify } from './common.mjs';

const CIRCUIT = {
  id: 'yongin',
  name: '용인 스피드웨이',
  bbox: [37.285, 127.195, 37.305, 127.225], // 남, 서, 북, 동
  mainWay: 671420801, // 메인 루프에 속한 way 하나 (여기서부터 끝점을 이어 닫힌 고리를 만든다)
  pitWay: 450059011, // 피트레인. 그 중간에서 가장 가까운 지점을 출발·결승선으로
};
const OUT = new URL(`../public/${CIRCUIT.id}.json`, import.meta.url);
const STEP = 2;
const WIDTH = 13; // 노면 폭 (m)
const RUNOFF = 9; // 노면 끝 ~ 방호벽 (m)
const BRIDGE_RUNOFF = 1; // 다리 위는 좁게
const CLEARANCE = 7.5; // 입체 교차: 다리 노면이 아래 노면보다 이만큼 높게
const BUILDING_RADIUS = 300;

// ---------- 1. 메인 루프 ----------

console.log('1/4 Overpass 서킷');
const [s, w, n, e] = CIRCUIT.bbox;
const data = await overpass(`[out:json][timeout:60];way[highway=raceway](${s},${w},${n},${e});out tags geom;`);
const ways = data.elements.filter((x) => x.geometry?.length >= 2);
const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
let cur = ways.find((x) => x.id === CIRCUIT.mainWay);
if (!cur) throw new Error('mainWay를 찾지 못함');
const chain = [cur];
// 끝점이 다음 way의 시작점과 같은 것을 이어 붙인다 (일방통행 방향 = 주행 방향)
while (chain.length < 50) {
  const end = key(cur.geometry.at(-1));
  if (end === key(chain[0].geometry[0])) break;
  const next = ways.filter((x) => !chain.includes(x) && x.id !== CIRCUIT.pitWay && key(x.geometry[0]) === end);
  if (!next.length) throw new Error(`way ${cur.id} 다음을 찾지 못함`);
  cur = next.sort((a, b) => b.geometry.length - a.geometry.length)[0];
  chain.push(cur);
}
const first = chain[0].geometry[0];
const { project, unproject } = projection([first.lon, first.lat]);
const pts = [];
for (const wy of chain) {
  const bridge = wy.tags.bridge === 'yes';
  wy.geometry.slice(0, -1).forEach((p) => pts.push({ p: project(p.lon, p.lat), bridge }));
}
console.log(`  way ${chain.map((x) => x.id).join(' → ')}`);

// ---------- 2. 중심선 ----------

console.log('2/4 중심선');
let ring = resample(pts.map((q) => q.p[0]), pts.map((q) => q.p[1]), STEP, true);
const bridgeRaw = ring.seg.map((k) => pts[k].bridge);
// 꺾인 점을 부드럽게 (±6m, 2회, 순환)
const sx = movingAverage(ring.x, 3, 2, true);
const sz = movingAverage(ring.z, 3, 2, true);
ring = resample(Array.from(sx), Array.from(sz), STEP, true);
const step = ring.step;
let N = ring.x.length;
let bridgeFlag = ring.seg.map((k) => bridgeRaw[k]);

// 출발·결승선: 피트레인 중간에서 가장 가까운 지점이 s = 0
const pit = ways.find((x) => x.id === CIRCUIT.pitWay);
const pm = pit.geometry[Math.floor(pit.geometry.length / 2)];
const [px, pz] = project(pm.lon, pm.lat);
let s0 = 0;
for (let i = 0, best = Infinity; i < N; i++) {
  const d = (ring.x[i] - px) ** 2 + (ring.z[i] - pz) ** 2;
  if (d < best) [best, s0] = [d, i];
}
const rot = (arr) => [...arr.slice(s0), ...arr.slice(0, s0)];
const X = rot(ring.x);
const Z = rot(ring.z);
bridgeFlag = rot(bridgeFlag);
const length = N * step;
console.log(`  ${(length / 1000).toFixed(3)} km, 샘플 ${N}개, 간격 ${step.toFixed(4)} m`);

// ---------- 3. 고도 ----------

console.log('3/4 고도 (Copernicus DEM GLO-30)');
const bounds = boundsOf(X, Z, 1400);
// 서킷 주변은 트인 곳이 많아 경로보다 약하게 거른다
const demAt = await loadDem(bounds, unproject, { minRad: 2, meanRad: 2, meanPasses: 2 });
const ground = X.map((x, i) => demAt(x, Z[i]));
const elev = Float64Array.from(ground);
const wrap = (i) => ((i % N) + N) % N;

// 다리 구간: 양 끝 지면을 직선으로 잇고, 아래로 지나가는 노면보다 CLEARANCE만큼 높게
const runs = [];
for (let i = 0; i < N; i++) {
  if (bridgeFlag[i] && !bridgeFlag[wrap(i - 1)]) {
    let j = i;
    while (bridgeFlag[wrap(j)] && j - i < N) j++;
    runs.push([i, j]);
  }
}
const PAD = 8;
for (const [a, b] of runs) {
  const lo = a - PAD;
  const hi = b - 1 + PAD;
  for (let i = lo; i <= hi; i++) elev[wrap(i)] = ground[wrap(lo)] + ((ground[wrap(hi)] - ground[wrap(lo)]) * (i - lo)) / (hi - lo);
}
let y = movingAverage(elev, 10, 2, true);
for (const [a, b] of runs) {
  // 다리 아래(수평 15m 안)를 지나는 다른 구간의 최고 높이
  let under = -Infinity;
  for (let i = a; i < b; i++) {
    for (let j = 0; j < N; j++) {
      const ds = Math.min(Math.abs(j - i), N - Math.abs(j - i));
      if (ds < 60) continue;
      if ((X[i] - X[j]) ** 2 + (Z[i] - Z[j]) ** 2 < 15 ** 2) under = Math.max(under, y[j]);
    }
  }
  if (under === -Infinity) continue;
  let deck = Infinity;
  for (let i = a; i < b; i++) deck = Math.min(deck, y[wrap(i)]);
  const dh = under + CLEARANCE - deck;
  if (dh <= 0) continue;
  // 경사로 6%로 올렸다 내림
  const ramp = Math.round(dh / 0.06 / step);
  for (let i = a - ramp; i < b + ramp; i++) y[wrap(i)] += dh * Math.min(1, (i - (a - ramp)) / ramp, (b + ramp - i) / ramp);
  console.log(`  입체 교차: 다리 ${((b - a) * step).toFixed(0)}m, 아래 노면 ${under.toFixed(1)}m → 다리 +${dh.toFixed(1)}m`);
}
// 최대 경사 10%
for (let pass = 0; pass < 3; pass++) {
  for (let i = 0; i < N; i++) y[i] = Math.min(y[wrap(i - 1)] + 0.1 * step, Math.max(y[wrap(i - 1)] - 0.1 * step, y[i]));
  for (let i = N - 1; i >= 0; i--) y[i] = Math.min(y[wrap(i + 1)] + 0.1 * step, Math.max(y[wrap(i + 1)] - 0.1 * step, y[i]));
}
y = movingAverage(y, 4, 2, true);
let maxGrade = 0;
for (let i = 0; i < N; i++) maxGrade = Math.max(maxGrade, Math.abs(y[wrap(i + 5)] - y[i]) / (5 * step));
console.log(`  고도 ${Math.min(...y).toFixed(1)}~${Math.max(...y).toFixed(1)} m, 최대 경사 ${(maxGrade * 100).toFixed(1)}%`);
const dem = demGrid(demAt, bounds, 50);

// ---------- 4. 건물 ----------

console.log('4/4 Overpass 건물');
const around = simplify(X.map((x, i) => [x, Z[i], ...unproject(x, Z[i])]), 8)
  .map(([, , lon, lat]) => `${lat.toFixed(6)},${lon.toFixed(6)}`)
  .join(',');
const bData = await overpass(`[out:json][timeout:120];way["building"](around:${BUILDING_RADIUS},${around});out tags geom;`);
const clear = WIDTH / 2 + RUNOFF + 4;
function nearest(x, z) {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < N; i++) {
    const d = (X[i] - x) ** 2 + (Z[i] - z) ** 2;
    if (d < bd) [bd, best] = [d, i];
  }
  return [best, Math.sqrt(bd)];
}
const buildings = [];
let dropped = 0;
for (const el of bData.elements) {
  if (!el.geometry || el.geometry.length < 4) continue;
  const p = el.geometry.map(({ lon, lat }) => project(lon, lat));
  p.pop();
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const [ax, az] = p[i];
    const [bx, bz] = p[(i + 1) % p.length];
    area += ax * bz - bx * az;
  }
  area = Math.abs(area / 2);
  if (area < 15) continue;
  if (p.some(([x, z]) => nearest(x, z)[1] < clear)) {
    dropped++;
    continue;
  }
  const mx = p.reduce((a, q) => a + q[0], 0) / p.length;
  const mz = p.reduce((a, q) => a + q[1], 0) / p.length;
  const h = heightOf(el.tags, area);
  buildings.push({ s: r1(nearest(mx, mz)[0] * step), h: r1(h), f: facadeOf(el.tags, h), p: p.flatMap(([x, z]) => [r1(x), r1(z)]) });
}
buildings.sort((a, b) => a.s - b.s);
console.log(`  건물 ${buildings.length}개, 노면과 겹쳐 제외 ${dropped}개`);

// ---------- 저장 ----------

const bridges = runs.map(([a, b]) => [r1(a * step), r1((b - 1) * step)]);
const out = {
  attribution: '© OpenStreetMap contributors; 고도 Copernicus DEM GLO-30 © DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018',
  id: CIRCUIT.id,
  start: CIRCUIT.name,
  end: CIRCUIT.name,
  loop: true,
  origin: { lon: first.lon, lat: first.lat },
  step,
  laneW: WIDTH,
  runoff: RUNOFF,
  bridgeRunoff: BRIDGE_RUNOFF,
  length,
  x: X.map(r2),
  z: Z.map(r2),
  w: new Array(N).fill(WIDTH),
  lanes: new Array(N).fill(1),
  opp: new Array(N).fill(0),
  med: new Array(N).fill(0),
  kind: new Array(N).fill(4),
  y: Array.from(y, r2),
  bridges,
  dem,
  names: [[0, CIRCUIT.name]],
  buildings,
};
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
const json = JSON.stringify(out);
await writeFile(OUT, json);
console.log(`저장: public/${CIRCUIT.id}.json (${(json.length / 1e6).toFixed(2)} MB)`);
