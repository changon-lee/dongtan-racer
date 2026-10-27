// 실제 경로 데이터 생성: OSRM(주행 경로) + Overpass(OSM 차선·건물) → public/route.json
// 실행: node tools/build-route.mjs
// 지도 데이터 © OpenStreetMap contributors (ODbL)
// 고도: Copernicus DEM GLO-30 (© DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA)
import { mkdir, writeFile } from 'node:fs/promises';
import { boundsOf, demGrid, facadeOf, getJSON, heightOf, loadDem, movingAverage, overpass, projection, r1, r2, resample, simplify } from './common.mjs';

const START = [127.05779, 37.20652]; // 동탄 숲속마을 모아미래도 1단지 [lon, lat]
const END = [127.10268, 37.51255]; // 잠실 롯데월드타워
const OUT = new URL('../public/route.json', import.meta.url);
const STEP = 2; // 트랙 샘플 간격 (m)
const LANE_W = 3.5;
const BUILDING_RADIUS = 170; // 경로 양옆 건물 수집 반경 (m)

const [lon0, lat0] = START;
const { project, unproject } = projection(START);

// ---------- 1. 경로 ----------

console.log('1/5 OSRM 경로');
const osrm = await getJSON(
  `https://router.project-osrm.org/route/v1/driving/${START.join(',')};${END.join(',')}?overview=full&geometries=geojson&annotations=nodes`,
);
const route = osrm.routes[0];
const coords = route.geometry.coordinates;
console.log(`  ${(route.distance / 1000).toFixed(1)} km, 점 ${coords.length}개`);
const proj = coords.map(([lon, lat]) => project(lon, lat));
// Overpass around 필터용 단순화 경로
const around = simplify(
  coords.map(([lon, lat], i) => [...proj[i], lat, lon]),
  8,
)
  .map(([, , lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`)
  .join(',');

// ---------- 2. 구간별 도로 속성 (차선 수, 분리 여부, 도로 등급, 이름) ----------
// OSRM 서버와 Overpass의 OSM 스냅샷이 달라 노드 ID가 어긋나므로, 위치·방향이 가장 가까운 way를 쓴다.

console.log('2/5 Overpass 도로 속성');
const wayData = await overpass(`[out:json][timeout:180];way[highway](around:25,${around});out tags geom;`);
const wsegs = [];
for (const w of wayData.elements) {
  const pts = w.geometry.map(({ lon, lat }) => project(lon, lat));
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len > 0.1) wsegs.push({ ax, az, bx, bz, ux: (bx - ax) / len, uz: (bz - az) / len, len, tags: w.tags });
  }
}
function matchWay(i) {
  const [ax, az] = proj[i];
  const [bx, bz] = proj[i + 1];
  const len = Math.hypot(bx - ax, bz - az) || 1;
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  let best = null;
  let bestD = 15;
  for (const s of wsegs) {
    const dot = s.ux * ux + s.uz * uz;
    if (Math.abs(dot) < 0.85) continue;
    const t = Math.max(0, Math.min(s.len, (mx - s.ax) * s.ux + (mz - s.az) * s.uz));
    const d = Math.hypot(s.ax + s.ux * t - mx, s.az + s.uz * t - mz);
    if (d < bestD) [bestD, best] = [d, { tags: s.tags, forward: dot > 0 }];
  }
  return best;
}

// 한 방향 기본 차선 수
const DEFAULT_LANES = {
  motorway: 4, trunk: 3, primary: 3, secondary: 2, tertiary: 2,
  residential: 1, unclassified: 1, service: 1, living_street: 1,
};
// kind: 0 고속도로/도시고속, 1 간선 시가지, 2 이면도로, 3 램프
function segAttrs(hit) {
  const t = hit?.tags ?? {};
  const hw = t.highway ?? 'residential';
  const isLink = hw.endsWith('_link');
  const base = hw.replace('_link', '');
  const oneway = ['yes', '1', 'true'].includes(t.oneway) || hw === 'motorway' || hw === 'motorway_link' || t.junction === 'roundabout';
  const lanes = parseInt(t.lanes, 10);
  const fwd = parseInt(t[hit?.forward === false ? 'lanes:backward' : 'lanes:forward'], 10);
  const bwd = parseInt(t[hit?.forward === false ? 'lanes:forward' : 'lanes:backward'], 10);
  const def = isLink ? 1 : DEFAULT_LANES[base] ?? 1;
  let our;
  let opp;
  let divided;
  if (oneway) {
    our = lanes || def;
    divided = !isLink && ['motorway', 'trunk', 'primary', 'secondary'].includes(base);
    opp = divided ? our : 0;
  } else {
    const total = lanes || def * 2;
    our = fwd || Math.max(1, Math.ceil(total / 2));
    opp = bwd || Math.max(0, total - our);
    divided = false;
  }
  const kind = isLink ? 3 : base === 'motorway' || base === 'trunk' ? 0 : ['primary', 'secondary', 'tertiary'].includes(base) ? 1 : 2;
  return {
    our: Math.min(6, Math.max(1, our)),
    opp: Math.min(6, Math.max(0, opp)),
    oneway,
    divided,
    kind,
    med: divided ? (kind === 0 ? 3 : 2) : 0,
    name: t.name ?? (t.ref ? `${t.ref}번 국도` : ''),
    bridge: !!t.bridge && t.bridge !== 'no',
    tunnel: !!t.tunnel && t.tunnel !== 'no',
    layer: parseInt(t.layer, 10) || 0,
  };
}
const segs = [];
let missing = 0;
for (let i = 0; i < coords.length - 1; i++) {
  const hit = matchWay(i);
  if (!hit) missing++;
  segs.push(segAttrs(hit));
}
console.log(`  way ${wayData.elements.length}개, 속성 못 찾은 구간 ${missing}/${segs.length}`);

// ---------- 3. 트랙 중심선: 재샘플 → 스무딩 → 내 진행 방향 차로 중앙으로 오프셋 ----------

console.log('3/5 트랙 생성');
const raw = resample(
  proj.map((p) => p[0]),
  proj.map((p) => p[1]),
  STEP,
);
const attr = raw.seg.map((i) => segs[i]);
// 교차로 직각 꺾임을 달릴 수 있는 곡선으로 (창 ±20m, 3회)
const sx = movingAverage(raw.x, 10, 3);
const sz = movingAverage(raw.z, 10, 3);
// 폭·오프셋도 부드럽게 바뀌도록 (창 ±40m)
const width = movingAverage(attr.map((a) => a.our * LANE_W), 20, 2);
// 양방향 도로는 OSM 선이 도로 중앙이므로 내 차로 중앙(오른쪽 W/2)으로 민다
const offset = movingAverage(attr.map((a, i) => (a.oneway ? 0 : (a.our * LANE_W) / 2)), 20, 2);

const cx = [];
const cz = [];
for (let i = 0; i < sx.length; i++) {
  const a = Math.max(0, i - 1);
  const b = Math.min(sx.length - 1, i + 1);
  const tx = sx[b] - sx[a];
  const tz = sz[b] - sz[a];
  const l = Math.hypot(tx, tz) || 1;
  // 오른쪽 법선 = (-tz, tx)
  cx.push(sx[i] + (-tz / l) * offset[i]);
  cz.push(sz[i] + (tx / l) * offset[i]);
}
// 오프셋 후 간격이 흐트러졌으니 다시 균일 재샘플
const fin = resample(cx, cz, STEP);
const N = fin.x.length;
const at = (k) => attr[Math.min(attr.length - 1, fin.seg[k])];
const W = fin.seg.map((k) => width[Math.min(width.length - 1, k)]);
console.log(`  샘플 ${N}개 = ${((N * STEP) / 1000).toFixed(2)} km`);

// ---------- 4. 건물 ----------

console.log('4/5 Overpass 건물');
const bData = await overpass(`[out:json][timeout:300][maxsize:536870912];way["building"](around:${BUILDING_RADIUS},${around});out tags geom;`);
console.log(`  원본 건물 ${bData.elements.length}개`);

// 최근접 트랙 샘플 검색용 격자
const CELL = 40;
const grid = new Map();
const key = (gx, gz) => `${gx},${gz}`;
for (let i = 0; i < N; i++) {
  const k = key(Math.floor(fin.x[i] / CELL), Math.floor(fin.z[i] / CELL));
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(i);
}
function nearest(x, z) {
  const gx = Math.floor(x / CELL);
  const gz = Math.floor(z / CELL);
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r <= 8 && (best < 0 || r <= 2); r++) {
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
        for (const idx of grid.get(key(gx + i, gz + j)) ?? []) {
          const d = (fin.x[idx] - x) ** 2 + (fin.z[idx] - z) ** 2;
          if (d < bestD) [bestD, best] = [d, idx];
        }
      }
    }
  }
  return best;
}
function normalAt(i) {
  const a = Math.max(0, i - 1);
  const b = Math.min(N - 1, i + 1);
  const tx = fin.x[b] - fin.x[a];
  const tz = fin.z[b] - fin.z[a];
  const l = Math.hypot(tx, tz) || 1;
  return [-tz / l, tx / l];
}

const buildings = [];
let dropped = 0;
for (const e of bData.elements) {
  if (!e.geometry || e.geometry.length < 4) continue;
  const pts = e.geometry.map(({ lon, lat }) => project(lon, lat));
  pts.pop(); // 닫는 점 중복 제거
  let area = 0;
  let mx = 0;
  let mz = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    area += ax * bz - bx * az;
    mx += ax;
    mz += az;
  }
  area = Math.abs(area / 2);
  if (area < 15) continue;
  mx /= pts.length;
  mz /= pts.length;

  // 우리가 그리는 도로 영역(양방향 차로 + 갓길/보도)에 걸치면 제외
  let overlaps = false;
  for (const [x, z] of [...pts, [mx, mz]]) {
    const i = nearest(x, z);
    if (i < 0) continue; // 트랙에서 멀리 떨어진 점
    const [nx, nz] = normalAt(i);
    const d = (x - fin.x[i]) * nx + (z - fin.z[i]) * nz;
    const a = at(i);
    const clear = a.kind === 0 ? 7 : 5;
    const left = -W[i] / 2 - a.med - a.opp * LANE_W - clear;
    const right = W[i] / 2 + clear;
    if (d > left && d < right) {
      overlaps = true;
      break;
    }
  }
  if (overlaps) {
    dropped++;
    continue;
  }
  const near = nearest(mx, mz);
  if (near < 0) continue;
  const h = heightOf(e.tags, area);
  buildings.push({
    s: near * STEP,
    h: r1(h),
    f: facadeOf(e.tags, h),
    p: pts.flatMap(([x, z]) => [r1(x), r1(z)]),
  });
}
buildings.sort((a, b) => a.s - b.s);
console.log(`  사용 ${buildings.length}개, 도로와 겹쳐 제외 ${dropped}개`);

// ---------- 5. 고도 ----------
// Copernicus GLO-30은 표면 모델(DSM)이라 건물·나무 높이가 섞여 있다.
// 최소값 필터로 지면만 남기고 평활화한 뒤, 도로는 다시 한 번 평활화 + 경사 제한.

console.log('5/5 고도 (Copernicus DEM GLO-30)');
// 경로 범위 + 지형 여백 (클라이언트 지형 타일이 차에서 ~1.2km까지 보임)
const TERRAIN_MARGIN = 1400;
const bounds = boundsOf(fin.x, fin.z, TERRAIN_MARGIN);
const demAt = await loadDem(bounds, unproject);

// 도로 종단: 지면 고도에서 시작
const ground = new Float64Array(N);
for (let i = 0; i < N; i++) ground[i] = demAt(fin.x[i], fin.z[i]);
const elev = Float64Array.from(ground);

// 다리·터널: DEM은 그 아래(위)의 지면이므로 양 끝(접속부 포함)을 직선으로 잇는다
const BRIDGE_PAD = 8; // 샘플(16m)
const runs = [];
for (let i = 0; i < N; ) {
  const a = at(i);
  const f = a.bridge ? 1 : a.tunnel ? 2 : 0;
  if (!f) {
    i++;
    continue;
  }
  let j = i;
  while (j < N && (f === 1 ? at(j).bridge : at(j).tunnel)) j++;
  const prev = runs.at(-1);
  if (prev && prev.f === f && i - prev.b < BRIDGE_PAD * 2) prev.b = j; // 가까운 구간은 합침
  else runs.push({ a: i, b: j, f, layer: a.layer, name: a.name });
  i = j;
}
for (const { a, b } of runs) {
  const lo = Math.max(0, a - BRIDGE_PAD);
  const hi = Math.min(N - 1, b - 1 + BRIDGE_PAD);
  for (let i = lo; i <= hi; i++) elev[i] = ground[lo] + ((ground[hi] - ground[lo]) * (i - lo)) / (hi - lo || 1);
}
// 시내 고가(긴 다리)는 접속 경사로를 타고 올라가고, 지하차도(layer<0)는 내려간다.
// 짧은 하천 교량과 layer 0 터널(방음터널)은 지면 높이 그대로.
const VIADUCT_MIN = 200; // m
const VIADUCT_H = 8;
const UNDERPASS_D = 7;
const RAMP_GRADE = 0.05;
function hump(a, b, dh) {
  const ramp = Math.round(Math.abs(dh) / RAMP_GRADE / STEP);
  for (let i = Math.max(0, a - ramp); i < Math.min(N, b + ramp); i++) {
    elev[i] += dh * Math.min(1, (i - (a - ramp)) / ramp, (b + ramp - i) / ramp);
  }
}
for (const r of runs) {
  if (r.f === 1 && r.layer > 0 && (r.b - r.a) * STEP >= VIADUCT_MIN) hump(r.a, r.b, VIADUCT_H);
  if (r.f === 2 && r.layer < 0) hump(r.a, r.b, -UNDERPASS_D);
}
const bridges = runs.filter((r) => r.f === 1);
const tunnels = runs.filter((r) => r.f === 2);
const runLen = (rs) => rs.reduce((sum, r) => sum + (r.b - r.a) * STEP, 0);
console.log(`  다리 ${bridges.length}곳 ${(runLen(bridges) / 1000).toFixed(2)} km, 터널·지하차도 ${tunnels.length}곳 ${(runLen(tunnels) / 1000).toFixed(2)} km`);

// 평활화(±60m) + 도로 등급별 최대 경사
let elevY = movingAverage(elev, 30, 3);
const GRADE_MAX = [0.05, 0.08, 0.09, 0.07]; // 고속, 간선, 이면, 램프
for (let pass = 0; pass < 2; pass++) {
  for (let i = 1; i < N; i++) {
    const g = GRADE_MAX[at(i).kind] * STEP;
    elevY[i] = Math.min(elevY[i - 1] + g, Math.max(elevY[i - 1] - g, elevY[i]));
  }
  for (let i = N - 2; i >= 0; i--) {
    const g = GRADE_MAX[at(i).kind] * STEP;
    elevY[i] = Math.min(elevY[i + 1] + g, Math.max(elevY[i + 1] - g, elevY[i]));
  }
}
elevY = movingAverage(elevY, 10, 2);
let climb = 0;
let maxGrade = 0;
for (let i = 1; i < N; i++) {
  climb += Math.max(0, elevY[i] - elevY[i - 1]);
  if (i >= 5) maxGrade = Math.max(maxGrade, Math.abs(elevY[i] - elevY[i - 5]) / (5 * STEP));
}
console.log(
  `  도로 고도 ${Math.min(...elevY).toFixed(1)}~${Math.max(...elevY).toFixed(1)} m, 누적 상승 ${climb.toFixed(0)} m, 최대 경사 ${(maxGrade * 100).toFixed(1)}%`,
);

// 클라이언트 지형용 격자 (50m 간격, dm 정수)
const DEM_CELL = 50;
const dem = demGrid(demAt, bounds, DEM_CELL);
console.log(`  지형 격자 ${dem.nx}×${dem.nz}`);

// ---------- 저장 ----------

const names = [];
for (let i = 0; i < N; i++) {
  const n = at(i).name;
  if (!names.length || names.at(-1)[1] !== n) names.push([i * STEP, n]);
}
const out = {
  attribution: '© OpenStreetMap contributors; 고도 Copernicus DEM GLO-30 © DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018',
  start: '동탄 숲속마을 모아미래도 1단지',
  end: '잠실 롯데월드타워',
  origin: { lon: lon0, lat: lat0 },
  step: STEP,
  laneW: LANE_W,
  length: (N - 1) * STEP,
  x: fin.x.map(r2),
  z: fin.z.map(r2),
  w: W.map(r2),
  lanes: fin.seg.map((_, i) => at(i).our),
  opp: fin.seg.map((_, i) => at(i).opp),
  med: fin.seg.map((_, i) => at(i).med),
  kind: fin.seg.map((_, i) => at(i).kind),
  y: Array.from(elevY, r2),
  bridges: bridges.map((r) => [r.a * STEP, (r.b - 1) * STEP]),
  dem,
  names,
  buildings,
};
await mkdir(new URL('../public/', import.meta.url), { recursive: true });
const json = JSON.stringify(out);
await writeFile(OUT, json);
console.log(`저장: public/route.json (${(json.length / 1e6).toFixed(1)} MB)`);
