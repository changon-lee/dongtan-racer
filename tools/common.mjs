// build-route.mjs·build-circuit.mjs 공용: 캐시된 HTTP, 투영, 폴리라인 처리, 건물 높이, DEM
// 지도 데이터 © OpenStreetMap contributors (ODbL)
// 고도: Copernicus DEM GLO-30 (© DLR e.V. 2010-2014, © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the EU and ESA)
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fromArrayBuffer } from 'geotiff';

export const UA = { 'User-Agent': 'dongtan-racer/0.1 (personal hobby game)' };
const OVERPASS = 'https://overpass-api.de/api/interpreter';

// 같은 요청은 tools/.cache에 저장해 두고 재사용 (공개 서버 부담 줄이기)
export const CACHE = new URL('./.cache/', import.meta.url);
export async function getJSON(url, init = {}, tries = 4) {
  const file = new URL(createHash('sha1').update(url + (init.body ?? '')).digest('hex') + '.json', CACHE);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // 캐시 없음
  }
  for (let i = 1; ; i++) {
    const r = await fetch(url, { ...init, headers: { ...UA, ...init.headers } });
    if (r.ok) {
      const text = await r.text();
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, text);
      return JSON.parse(text);
    }
    if (i >= tries) throw new Error(`${r.status} ${r.statusText} ← ${url}`);
    console.log(`  ${r.status}, ${i * 15}s 후 재시도`);
    await new Promise((res) => setTimeout(res, i * 15000));
  }
}

export const overpass = (q) =>
  getJSON(OVERPASS, {
    method: 'POST',
    body: new URLSearchParams({ data: q }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

// 기준점 기준 등장방형 투영: x = 동쪽(m), z = 남쪽(m) (three.js에서 북쪽이 -z)
const R_EARTH = 6378137;
const D2R = Math.PI / 180;
export function projection([lon0, lat0]) {
  const cosLat0 = Math.cos(lat0 * D2R);
  return {
    project: (lon, lat) => [(lon - lon0) * D2R * R_EARTH * cosLat0, -(lat - lat0) * D2R * R_EARTH],
    unproject: (x, z) => [lon0 + x / (D2R * R_EARTH * cosLat0), lat0 - z / (D2R * R_EARTH)],
  };
}

export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;

// circular: 처음과 끝이 이어진 배열(순환 트랙)
export function movingAverage(arr, half, passes = 1, circular = false) {
  let a = Float64Array.from(arr);
  const n = a.length;
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (circular) {
        let sum = 0;
        for (let j = i - half; j <= i + half; j++) sum += a[((j % n) + n) % n];
        out[i] = sum / (2 * half + 1);
        continue;
      }
      const lo = Math.max(0, i - half);
      const hi = Math.min(n - 1, i + half);
      let sum = 0;
      for (let j = lo; j <= hi; j++) sum += a[j];
      out[i] = sum / (hi - lo + 1);
    }
    a = out;
  }
  return a;
}

// 폴리라인을 균일 간격으로 재샘플. seg[k] = 원래 몇 번째 구간이었는지
// closed: 마지막 점 → 첫 점 구간까지 포함하고, 끝 간격이 step이 되도록 step을 살짝 조정
export function resample(xs, zs, step, closed = false) {
  if (closed) {
    let total = 0;
    for (let i = 0; i < xs.length; i++) {
      const j = (i + 1) % xs.length;
      total += Math.hypot(xs[j] - xs[i], zs[j] - zs[i]);
    }
    step = total / Math.round(total / step);
    xs = [...xs, xs[0]];
    zs = [...zs, zs[0]];
  }
  const outX = [];
  const outZ = [];
  const seg = [];
  let carry = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    const dz = zs[i + 1] - zs[i];
    const len = Math.hypot(dx, dz);
    let t = carry;
    while (t < len - (closed ? 1e-6 : 0)) {
      outX.push(xs[i] + (dx * t) / len);
      outZ.push(zs[i] + (dz * t) / len);
      seg.push(i);
      t += step;
    }
    carry = t - len;
  }
  return { x: outX, z: outZ, seg, step };
}

export function simplify(points, tol) {
  // Douglas-Peucker, points: [[x, z, ...rest]]
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = points[a];
    const [bx, bz] = points[b];
    const len = Math.hypot(bx - ax, bz - az) || 1;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (az - points[i][1]) - (ax - points[i][0]) * (bz - az)) / len;
      if (d > maxD) [maxD, idx] = [d, i];
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function heightOf(t, area) {
  const lv = parseFloat(t['building:levels']);
  if (lv > 0) return lv * 3.1 + 1;
  const h = parseFloat(t.height);
  if (h > 0) return h;
  const b = t.building;
  if (b === 'apartments') return 25 * 2.9;
  if (['house', 'detached', 'garage', 'garages', 'shed', 'hut', 'roof', 'kiosk'].includes(b)) return 5;
  if (b === 'industrial' || b === 'warehouse') return 9;
  if (['commercial', 'retail', 'office'].includes(b)) return area > 2000 ? 30 : 15;
  return area > 1500 ? 24 : area > 300 ? 12 : 7;
}

// 외벽 종류: 0 아파트, 1 상가, 2 유리(오피스·고층), 3 일반
export function facadeOf(t, h) {
  const b = t.building;
  if (b === 'apartments' || (b === 'residential' && h > 30)) return 0;
  if ((b === 'commercial' || b === 'retail') && h <= 20) return 1;
  if (h > 30) return 2;
  return 3;
}

// 점들의 범위 + 여백
export function boundsOf(xs, zs, margin) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
    minZ = Math.min(minZ, zs[i]);
    maxZ = Math.max(maxZ, zs[i]);
  }
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}

// ---------- DEM ----------
// Copernicus GLO-30은 표면 모델(DSM)이라 건물·나무 높이가 섞여 있다.
// 최소값 필터로 지면만 남기고 평활화한다. 반환: demAt(x, z) (투영 좌표, m)

export async function loadDem(bounds, unproject, { minRad = 3, meanRad = 3, meanPasses = 2 } = {}) {
  const [lonW, latS] = unproject(bounds.minX, bounds.maxZ);
  const [lonE, latN] = unproject(bounds.maxX, bounds.minZ);
  const tileLon = Math.floor(lonW);
  const tileLat = Math.floor(latS);
  if (Math.floor(lonE) !== tileLon || Math.floor(latN) !== tileLat) throw new Error('범위가 DEM 타일 1장을 넘어감');
  const name = `N${tileLat}_00_E${String(tileLon).padStart(3, '0')}_00`;
  const url = `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${name}_DEM/Copernicus_DSM_COG_10_${name}_DEM.tif`;
  const file = new URL(`dem-N${tileLat}E${tileLon}.tif`, CACHE);
  let buf;
  try {
    buf = await readFile(file);
  } catch {
    console.log('  DEM 타일 다운로드 (약 50MB)');
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} ← ${url}`);
    buf = Buffer.from(await r.arrayBuffer());
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, buf);
  }
  const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))).getImage();
  const [demLon0, demLat0] = img.getOrigin();
  const [resLon, resLat] = img.getResolution(); // resLat < 0 (북→남)
  const PAD = 8;
  const col0 = Math.max(0, Math.floor((lonW - demLon0) / resLon) - PAD);
  const col1 = Math.min(img.getWidth(), Math.ceil((lonE - demLon0) / resLon) + PAD);
  const row0 = Math.max(0, Math.floor((latN - demLat0) / resLat) - PAD);
  const row1 = Math.min(img.getHeight(), Math.ceil((latS - demLat0) / resLat) + PAD);
  const DW = col1 - col0;
  const DH = row1 - row0;
  const [rawDem] = await img.readRasters({ window: [col0, row0, col1, row1] });

  // 분리형 2D 필터 (가로 → 세로)
  function filter2d(src, rad, op) {
    const pass = (a, horizontal) => {
      const out = new Float32Array(a.length);
      const [n, m] = horizontal ? [DH, DW] : [DW, DH];
      for (let p = 0; p < n; p++) {
        for (let q = 0; q < m; q++) {
          let acc = op === 'min' ? Infinity : 0;
          let cnt = 0;
          for (let k = Math.max(0, q - rad); k <= Math.min(m - 1, q + rad); k++) {
            const v = a[horizontal ? p * DW + k : k * DW + p];
            if (op === 'min') acc = Math.min(acc, v);
            else acc += v;
            cnt++;
          }
          out[horizontal ? p * DW + q : q * DW + p] = op === 'min' ? acc : acc / cnt;
        }
      }
      return out;
    };
    return pass(pass(src, true), false);
  }
  let dem = Float32Array.from(rawDem, (v) => (v < -100 ? 0 : v));
  if (minRad > 0) dem = filter2d(dem, minRad, 'min'); // 주변 최저점 → 건물·숲 제거
  for (let p = 0; p < meanPasses; p++) dem = filter2d(dem, meanRad, 'mean');

  return function demAt(x, z) {
    const [lon, lat] = unproject(x, z);
    const fc = Math.min(DW - 1.001, Math.max(0, (lon - demLon0) / resLon - 0.5 - col0));
    const fr = Math.min(DH - 1.001, Math.max(0, (lat - demLat0) / resLat - 0.5 - row0));
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const u = fc - c;
    const v = fr - r;
    const h = (rr, cc) => dem[rr * DW + cc];
    return (h(r, c) * (1 - u) + h(r, c + 1) * u) * (1 - v) + (h(r + 1, c) * (1 - u) + h(r + 1, c + 1) * u) * v;
  };
}

// 클라이언트 지형용 격자 (dm 정수)
export function demGrid(demAt, bounds, cell) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const nx = Math.ceil((maxX - minX) / cell) + 1;
  const nz = Math.ceil((maxZ - minZ) / cell) + 1;
  const h = new Array(nx * nz);
  for (let r = 0; r < nz; r++) {
    for (let c = 0; c < nx; c++) h[r * nx + c] = Math.round(demAt(minX + c * cell, minZ + r * cell) * 10);
  }
  return { x0: r1(minX), z0: r1(minZ), cell, nx, nz, h };
}
