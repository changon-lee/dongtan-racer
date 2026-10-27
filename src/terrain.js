import * as THREE from 'three';

// 경로 밖 지형: 50m DEM 격자 + 도로 근처는 도로 높이에 맞춰 깎거나 돋운다.
// 차 주변 타일만 메시로 만든다. 타일 정점은 타일 원점 기준 로컬 좌표.

const TILE = 320;
const RES = 16; // 정점 간격 (m)
const SEG = TILE / RES;
const RADIUS = 1300;
const BUILD_BUDGET_MS = 3;
const BLEND_IN = 8; // 도로 바깥 끝에서 이 거리까지는 도로 높이
const BLEND_OUT = 80; // 이 거리부터는 DEM 그대로
const SINK = 0.35; // 지면을 도로면보다 살짝 아래로 (겹침 방지)

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export class Terrain {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;
    this.dem = track.dem;
    this.tiles = new Map();
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    let min = Infinity;
    if (this.dem) for (const v of this.dem.h) min = Math.min(min, v / 10);
    this.minHeight = Number.isFinite(min) ? min : 0;
  }

  // 지면 DEM (도로 영향 없음)
  demAt(x, z) {
    const g = this.dem;
    if (!g) return 0;
    const fc = Math.min(g.nx - 1.001, Math.max(0, (x - g.x0) / g.cell));
    const fr = Math.min(g.nz - 1.001, Math.max(0, (z - g.z0) / g.cell));
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const u = fc - c;
    const v = fr - r;
    const h = (rr, cc) => g.h[rr * g.nx + cc];
    return ((h(r, c) * (1 - u) + h(r, c + 1) * u) * (1 - v) + (h(r + 1, c) * (1 - u) + h(r + 1, c + 1) * u) * v) / 10;
  }

  // 지형 높이: 도로 가까이는 도로 높이(다리 구간은 다리 아래 지면), 멀어지면 DEM
  heightAt(x, z) {
    const dem = this.demAt(x, z);
    const t = this.track;
    const i = t.nearest(x, z, BLEND_OUT + 40);
    if (i < 0) return dem;
    const ry = t.ry[i];
    const d = (x - t.x[i]) * Math.cos(ry) - (z - t.z[i]) * Math.sin(ry);
    const [right, left] = t.extents(i);
    const e = d > 0 ? d - right : -d - left;
    const road = t.bridge[i] ? dem : t.y[i];
    return road + (dem - road) * smoothstep(BLEND_IN, BLEND_OUT, e);
  }

  buildTile(tx, tz) {
    const x0 = tx * TILE;
    const z0 = tz * TILE;
    // 법선을 이웃 타일과 똑같이 계산하려고 테두리 한 칸 바깥까지 높이를 구한다
    const n = SEG + 3;
    const H = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) H[r * n + c] = this.heightAt(x0 + (c - 1) * RES, z0 + (r - 1) * RES) - SINK;
    }
    const m = SEG + 1;
    const pos = new Float32Array(m * m * 3);
    const nor = new Float32Array(m * m * 3);
    const col = new Float32Array(m * m * 3);
    const color = new THREE.Color();
    for (let r = 0; r < m; r++) {
      for (let c = 0; c < m; c++) {
        const k = r * m + c;
        const h = H[(r + 1) * n + c + 1];
        pos.set([c * RES, h, r * RES], k * 3);
        const dx = (H[(r + 1) * n + c + 2] - H[(r + 1) * n + c]) / (2 * RES);
        const dz = (H[(r + 2) * n + c + 1] - H[r * n + c + 1]) / (2 * RES);
        const l = Math.hypot(dx, 1, dz);
        nor.set([-dx / l, 1 / l, -dz / l], k * 3);
        // 잔디색에 저주파 얼룩
        const wx = x0 + c * RES;
        const wz = z0 + r * RES;
        const noise = Math.sin(wx * 0.013 + Math.sin(wz * 0.007) * 2) * Math.sin(wz * 0.011 + Math.sin(wx * 0.005) * 3);
        color.setHSL(0.22 + noise * 0.03, 0.3 + noise * 0.06, 0.27 + noise * 0.03);
        col.set([color.r, color.g, color.b], k * 3);
      }
    }
    const idx = [];
    for (let r = 0; r < SEG; r++) {
      for (let c = 0; c < SEG; c++) {
        const a = r * m + c;
        // 위에서 볼 때 반시계 (법선 +y)
        idx.push(a, a + m, a + 1, a + 1, a + m, a + m + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(x0, 0, z0);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    return mesh;
  }

  wanted(x, z, radius) {
    const out = [];
    const r = Math.ceil(radius / TILE);
    const cx = Math.floor(x / TILE);
    const cz = Math.floor(z / TILE);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const tx = cx + i;
        const tz = cz + j;
        // 타일에서 차까지 가장 가까운 거리
        const dx = Math.max(tx * TILE - x, 0, x - (tx + 1) * TILE);
        const dz = Math.max(tz * TILE - z, 0, z - (tz + 1) * TILE);
        const d = Math.hypot(dx, dz);
        if (d <= radius) out.push([tx, tz, d]);
      }
    }
    return out.sort((a, b) => a[2] - b[2]);
  }

  prime(x, z) {
    for (const [tx, tz] of this.wanted(x, z, RADIUS)) {
      const k = `${tx},${tz}`;
      if (!this.tiles.has(k)) this.tiles.set(k, this.buildTile(tx, tz));
    }
  }

  dispose() {
    for (const mesh of this.tiles.values()) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    this.tiles.clear();
    this.material.dispose();
  }

  update(x, z) {
    const keep = new Set(this.wanted(x, z, RADIUS + TILE).map(([tx, tz]) => `${tx},${tz}`));
    for (const [k, mesh] of this.tiles) {
      if (keep.has(k)) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      this.tiles.delete(k);
    }
    const start = performance.now();
    for (const [tx, tz] of this.wanted(x, z, RADIUS)) {
      const k = `${tx},${tz}`;
      if (this.tiles.has(k)) continue;
      this.tiles.set(k, this.buildTile(tx, tz));
      if (performance.now() - start > BUILD_BUDGET_MS) break;
    }
  }
}
