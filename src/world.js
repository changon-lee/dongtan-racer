import * as THREE from 'three';
import * as TX from './textures.js';
import { CURB_W, KIND } from './track.js';

// 트랙을 200m 청크로 나눠 차 주변만 메시로 만든다.
// 각 청크의 정점은 청크 시작점 기준 로컬 좌표 → 수십 km 떨어져도 float 정밀도 문제 없음.

const CHUNK = 200;
const AHEAD = 1100;
const BEHIND = 200;
const BUILD_BUDGET_MS = 6; // 프레임당 청크 생성 시간 한도

const LINE_W = 0.15;
const DASH = 8; // 점선: 8m 칠하고
const DASH_PERIOD = 20; // 12m 띄움
const SIDEWALK = 4;
const NOISE_WALL_H = 4.5;
const RAIL_H = 0.8;
const GIRDER = 1.8; // 다리 상판 두께
const PIER_EVERY = 36; // 교각 간격 (m)
const SKIRT = 0.8; // 도로 가장자리 아래로 내린 옆면 (지면과의 틈 가림)

const FACADE = { APT: 0, SHOP: 1, GLASS: 2, PLAIN: 3 };
const APT_TINTS = [0xffffff, 0xf3ead8, 0xe4edf2, 0xf1e2da, 0xe8ecdf, 0xf6efe4];
const PLAIN_TINTS = [0xd9d4ca, 0xc9c4ba, 0xe2ddd3, 0xbfc3c6, 0xd6cbb8, 0xcfd3d6];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function leafColor(r, out) {
  const p = r();
  if (p < 0.4) return out.setHSL(0.25 + r() * 0.07, 0.45 + r() * 0.15, 0.24 + r() * 0.1);
  if (p < 0.75) return out.setHSL(0.12 + r() * 0.03, 0.8, 0.48 + r() * 0.08);
  return out.setHSL(0.02 + r() * 0.05, 0.75, 0.4 + r() * 0.08);
}

// 비인덱스 삼각형 누적기. tri()는 원하는 법선 방향(want)에 맞게 와인딩을 자동 보정한다.
class Geo {
  constructor(colors = false) {
    this.p = [];
    this.n = [];
    this.u = [];
    this.c = colors ? [] : null;
  }

  tri(a, b, c, want, ua = [0, 0], ub = [0, 0], uc = [0, 0], col = null) {
    const e1x = b[0] - a[0];
    const e1y = b[1] - a[1];
    const e1z = b[2] - a[2];
    const e2x = c[0] - a[0];
    const e2y = c[1] - a[1];
    const e2z = c[2] - a[2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
      [b, c] = [c, b];
      [ub, uc] = [uc, ub];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    this.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.n.push(nx / len, ny / len, nz / len);
    this.u.push(...ua, ...ub, ...uc);
    if (this.c) for (let i = 0; i < 3; i++) this.c.push(col.r, col.g, col.b);
  }

  quad(a, b, c, d, want, ua, ub, uc, ud, col) {
    this.tri(a, b, c, want, ua, ub, uc, col);
    this.tri(a, c, d, want, ua, uc, ud, col);
  }

  build() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    if (this.c) g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    return g;
  }
}

const UP = [0, 1, 0];
const DOWN = [0, -1, 0];
const geo4 = (geo, a, b, c, d) => geo.quad(a, b, c, d, DOWN, [0, 0], [1, 0], [1, 1], [0, 1]);

class Assets {
  constructor() {
    const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
    const lineMat = (color) => lam(color, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mat = {
      road: lam(0xffffff, { map: TX.asphaltTexture() }),
      white: lineMat(0xeeeeea),
      yellow: lineMat(0xe8b923),
      checker: lam(0xffffff, { map: TX.checkerTexture(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      walk: lam(0xffffff, { map: TX.sidewalkTexture() }),
      curb: lam(0xc9c6bf),
      barrier: lam(0xb5b1a8),
      medianGreen: lam(0x5e7a3f),
      noiseWall: lam(0xffffff, { map: TX.noiseWallTexture(), side: THREE.DoubleSide }),
      rail: lam(0xc3c7cb, { side: THREE.DoubleSide }),
      roof: lam(0x9a9a98, { vertexColors: true }),
      trunk: lam(0x5b4633),
      crown: lam(0xffffff, { flatShading: true }),
      pole: lam(0x8a9097),
      head: lam(0xffffff, { emissive: 0xfff3d0, emissiveIntensity: 0.6 }),
      kerb: lam(0xffffff, { map: TX.stripeTexture(true), polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
      tyreWall: lam(0xffffff, { map: TX.stripeTexture(false), side: THREE.DoubleSide }),
      gravel: lam(0xc6b48c),
      runoffGrass: lam(0x557539),
    };
    const facadeTex = [0, 1, 2].map((v) => TX.facadeTexture(v));
    const shopTex = [0, 1, 2, 3, 4, 5].map((v) => TX.shopTexture(v));
    this.facadeMats = facadeTex.map((map) => lam(0xffffff, { map, vertexColors: true }));
    this.shopMats = shopTex.map((map) => lam(0xffffff, { map, vertexColors: true }));
    this.glassMat = new THREE.MeshPhongMaterial({ map: TX.glassTexture(), vertexColors: true, shininess: 60, specular: 0x8899aa });
    this.plainMat = lam(0xffffff, { vertexColors: true });
    this.geo = {
      trunk: new THREE.CylinderGeometry(0.14, 0.2, 2.4, 6).translate(0, 1.2, 0),
      crown: new THREE.IcosahedronGeometry(1.7, 1),
      pole: new THREE.CylinderGeometry(0.1, 0.15, 9, 8).translate(0, 4.5, 0),
      arm: new THREE.BoxGeometry(2.6, 0.12, 0.12),
      head: new THREE.BoxGeometry(0.9, 0.16, 0.38),
    };
  }
}

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();

class Chunk {
  constructor(world, idx) {
    this.idx = idx;
    const { track } = world;
    this.track = track;
    this.a = world.assets;
    this.terrain = world.terrain;
    this.s0 = idx * CHUNK;
    this.i0 = Math.round(this.s0 / track.step);
    // 순환 트랙의 마지막 청크는 고스트 샘플(= 처음 샘플)까지
    this.i1 = Math.min(track.loop ? track.n : track.n - 1, Math.round((this.s0 + CHUNK) / track.step));
    this.ox = track.x[this.i0];
    this.oz = track.z[this.i0];
    this.group = new THREE.Group();
    this.group.position.set(this.ox, 0, this.oz);
    this.r = mulberry32(idx * 7919 + 13);
    this.trees = [];
    this.lamps = [];
    this.build();
    world.scene.add(this.group);
  }

  // 샘플 i에서 횡 d, 도로면 기준 높이 y인 로컬 좌표
  pt(i, d, y = 0) {
    const t = this.track;
    const ry = t.ry[i];
    return [t.x[i] + Math.cos(ry) * d - this.ox, t.y[i] + y, t.z[i] - Math.sin(ry) * d - this.oz];
  }

  // 로컬 (x, z)의 지형 높이
  groundAt(x, z) {
    return this.terrain.heightAt(x + this.ox, z + this.oz);
  }

  // 다리 교각: 샘플 i~i+1 사이, 횡 d0~d1, 절대 높이 yBot~yTop인 기둥
  pier(geo, i, d0, d1, yBot, yTop) {
    const t = this.track;
    const P = (k, d, yAbs) => this.pt(k, d, yAbs - t.y[k]);
    const n = this.normal(i);
    const f = [-Math.sin(t.ry[i]), 0, -Math.cos(t.ry[i])];
    const faces = [
      [[i, d1], [i + 1, d1], n],
      [[i + 1, d0], [i, d0], [-n[0], 0, -n[2]]],
      [[i + 1, d1], [i + 1, d0], f],
      [[i, d0], [i, d1], [-f[0], 0, -f[2]]],
    ];
    for (const [[ka, da], [kb, db], want] of faces) {
      geo.quad(P(ka, da, yBot), P(kb, db, yBot), P(kb, db, yTop), P(ka, da, yTop), want, [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }

  normal(i) {
    const ry = this.track.ry[i];
    return [Math.cos(ry), 0, -Math.sin(ry)];
  }

  // i→i+1 구간에 d0~d1 띠 (위를 향함)
  strip(geo, i, d0a, d1a, d0b, d1b, y, uScale, vScale) {
    const t = this.track;
    const va = (i * t.step - this.s0) / vScale;
    const vb = ((i + 1) * t.step - this.s0) / vScale;
    geo.quad(
      this.pt(i, d0a, y), this.pt(i, d1a, y), this.pt(i + 1, d1b, y), this.pt(i + 1, d0b, y), UP,
      [d0a / uScale, va], [d1a / uScale, va], [d1b / uScale, vb], [d0b / uScale, vb],
    );
  }

  // i→i+1 구간에 횡 위치 d의 세로 벽
  wall(geo, i, da, db, y0, y1, want, uScale = 4, vScale = 4.5) {
    const t = this.track;
    const ua = (i * t.step - this.s0) / uScale;
    const ub = ((i + 1) * t.step - this.s0) / uScale;
    const h = (y1 - y0) / vScale;
    geo.quad(this.pt(i, da, y0), this.pt(i + 1, db, y0), this.pt(i + 1, db, y1), this.pt(i, da, y1), want, [ua, 0], [ub, 0], [ub, h], [ua, h]);
  }

  // 단면이 사각형인 띠 (분리대·연석): 윗면 + 양 옆면
  box(geo, i, dCa, dCb, halfW, h) {
    this.strip(geo, i, dCa - halfW, dCa + halfW, dCb - halfW, dCb + halfW, h, 4, 4);
    const n = this.normal(i);
    this.wall(geo, i, dCa + halfW, dCb + halfW, 0, h, n);
    this.wall(geo, i, dCa - halfW, dCb - halfW, 0, h, [-n[0], 0, -n[2]]);
  }

  // 샘플별 단면 정보
  section(i) {
    const t = this.track;
    const half = t.w[i] / 2;
    const kind = t.kind[i];
    const med = t.medW[i];
    const oppW = t.oppW[i];
    const shoulder = t.shoulder(i);
    return {
      half, kind, med, oppW, shoulder,
      lanes: t.lanes[i],
      opp: t.opp[i],
      right: half + shoulder, // 오른쪽 포장 끝
      left: -half - med - oppW - shoulder, // 왼쪽 포장 끝
      oppEdge: -half - med - oppW, // 반대 차로 바깥 차선 끝
    };
  }

  build() {
    const t = this.track;
    const road = new Geo();
    const white = new Geo();
    const yellow = new Geo();
    const walk = new Geo();
    const curb = new Geo();
    const barrier = new Geo();
    const green = new Geo();
    const noise = new Geo();
    const rail = new Geo();
    const checker = new Geo();
    const concrete = new Geo();
    const kerb = new Geo();
    const tyreWall = new Geo();
    const gravel = new Geo();
    const runoffGrass = new Geo();

    const line = (geo, i, da, db) => this.strip(geo, i, da - LINE_W / 2, da + LINE_W / 2, db - LINE_W / 2, db + LINE_W / 2, 0.02, 1, 1);

    for (let i = this.i0; i < this.i1; i++) {
      const A = this.section(i);
      const B = this.section(i + 1);
      const s = i * t.step;
      const dashOn = s % DASH_PERIOD < DASH;

      // 포장
      this.strip(road, i, A.left, A.right, B.left, B.right, 0, 4, 4);

      // 내 차로: 오른쪽 가장자리 실선, 차선 점선
      line(white, i, A.half - 0.25, B.half - 0.25);
      if (dashOn) {
        for (let k = 1; k < Math.min(A.lanes, B.lanes); k++) {
          line(white, i, -A.half + (k * 2 * A.half) / A.lanes, -B.half + (k * 2 * B.half) / B.lanes);
        }
      }
      // 왼쪽: 분리대 있으면 황색 실선, 없고 반대 차로 있으면 황색 복선, 일방통행이면 백색 실선
      if (A.med > 0.3) {
        line(yellow, i, -A.half + 0.25, -B.half + 0.25);
      } else if (A.oppW > 0.5) {
        line(yellow, i, -A.half + 0.12, -B.half + 0.12);
        line(yellow, i, -A.half - 0.12, -B.half - 0.12);
      } else {
        line(white, i, -A.half + 0.25, -B.half + 0.25);
      }
      // 반대 차로
      if (A.oppW > 0.5) {
        line(white, i, A.oppEdge + 0.25, B.oppEdge + 0.25);
        if (dashOn) {
          for (let k = 1; k < Math.min(A.opp, B.opp); k++) {
            line(white, i, -A.half - A.med - (k * A.oppW) / A.opp, -B.half - B.med - (k * B.oppW) / B.opp);
          }
        }
      }

      // 중앙분리대
      if (A.med > 0.3) {
        const ca = -A.half - A.med / 2;
        const cb = -B.half - B.med / 2;
        if (A.kind === KIND.EXPRESS) this.box(barrier, i, ca, cb, 0.3, 0.9);
        else {
          this.box(curb, i, ca, cb, A.med / 2 - 0.1, 0.2);
          this.strip(green, i, ca - A.med / 2 + 0.25, ca + A.med / 2 - 0.25, cb - B.med / 2 + 0.25, cb + B.med / 2 - 0.25, 0.21, 4, 4);
        }
      }

      // 길가 (오른쪽 = +1, 왼쪽 = -1)
      for (const side of [1, -1]) {
        const ea = side > 0 ? A.right : A.left;
        const eb = side > 0 ? B.right : B.left;
        const out = side > 0 ? this.normal(i) : this.normal(i).map((v) => -v);
        if (A.kind === KIND.EXPRESS) {
          this.wall(noise, i, ea + side * 0.3, eb + side * 0.3, 0, NOISE_WALL_H, [-out[0], 0, -out[2]]);
          this.wall(curb, i, ea + side * 0.3, eb + side * 0.3, -SKIRT, 0, out);
          if (s % 12 < t.step) this.trees.push([i, ea + side * (7 + this.r() * 6)]);
          if (side > 0 && s % 50 < t.step) this.lamps.push([i, ea - 0.2, side]);
        } else if (A.kind === KIND.CIRCUIT) {
          // 서킷: 커브에만 빨강·흰 연석, 그 바깥 런오프(커브는 자갈, 직선은 잔디), 끝에 방호벽
          const roA = t.runoffAt(i);
          const roB = t.runoffAt(i + 1);
          const curvy = t.gravelAt(i);
          const ka = ea + side * CURB_W;
          const kb = eb + side * CURB_W;
          if (curvy) this.strip(kerb, i, Math.min(ea, ka), Math.max(ea, ka), Math.min(eb, kb), Math.max(eb, kb), 0.03, 1, 2);
          const wa = ea + side * roA;
          const wb = eb + side * roB;
          if (roA > CURB_W) {
            this.strip(curvy ? gravel : runoffGrass, i, Math.min(ka, wa), Math.max(ka, wa), Math.min(kb, wb), Math.max(kb, wb), -0.02, 4, 4);
          }
          this.wall(tyreWall, i, wa, wb, -SKIRT, 1.0, [-out[0], 0, -out[2]], 2, 1);
          if (s % 14 < t.step) this.trees.push([i, wa + side * (4 + this.r() * 16)]);
        } else if (A.kind === KIND.RAMP) {
          this.wall(rail, i, ea + side * 0.2, eb + side * 0.2, 0.3, RAIL_H, [-out[0], 0, -out[2]]);
          this.wall(curb, i, ea, eb, -SKIRT, 0, out);
          if (s % 12 < t.step) this.trees.push([i, ea + side * (4 + this.r() * 5)]);
        } else {
          // 연석 + 보도
          this.wall(curb, i, ea, eb, 0, 0.15, [-out[0], 0, -out[2]]);
          const fa = ea + side * SIDEWALK;
          const fb = eb + side * SIDEWALK;
          this.strip(walk, i, Math.min(ea, fa), Math.max(ea, fa), Math.min(eb, fb), Math.max(eb, fb), 0.15, 5, 5);
          this.wall(curb, i, fa, fb, -SKIRT, 0.15, out);
          if (s % 30 < t.step) this.lamps.push([i, ea + side * 0.8, side]);
          else if (s % 10 < t.step) this.trees.push([i, ea + side * 2.8]);
        }
      }

      // 다리: 상판 옆면·밑면 + 교각
      if (t.bridge[i] && t.bridge[i + 1]) {
        const [ra, la] = t.extents(i);
        const [rb, lb] = t.extents(i + 1);
        const n = this.normal(i);
        const top = A.kind === KIND.URBAN || A.kind === KIND.LOCAL ? 0.15 : 0;
        this.wall(concrete, i, ra, rb, -GIRDER, top, n, 4, 4);
        this.wall(concrete, i, -la, -lb, -GIRDER, top, [-n[0], 0, -n[2]], 4, 4);
        geo4(concrete, this.pt(i, -la, -GIRDER), this.pt(i, ra, -GIRDER), this.pt(i + 1, rb, -GIRDER), this.pt(i + 1, -lb, -GIRDER));
        const [cx, , cz] = this.pt(i, (ra - la) / 2);
        const ground = this.terrain.demAt(cx + this.ox, cz + this.oz);
        const deck = t.y[i] - GIRDER;
        // 서킷 입체 교차는 아래로 노면이 지나가므로 교각 없이
        if (!t.loop && deck - ground > 1.5 && s % PIER_EVERY < t.step) {
          // 차로 묶음마다 기둥 하나씩
          const mid = (ra - la) / 2;
          const cols = ra + la > 24 ? [mid - (ra + la) / 4, mid + (ra + la) / 4] : [mid];
          for (const c of cols) this.pier(concrete, i, c - 1, c + 1, ground - 1, deck);
        }
      }

      // 출발선·결승선
      for (const mark of t.lines) {
        if (s <= mark && mark < s + t.step) this.strip(checker, i, -A.half, A.half, -B.half, B.half, 0.025, A.half * 2, 2);
      }
    }

    const add = (geo, mat, shadow = false) => {
      const g = geo.build();
      if (!g) return;
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = shadow;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
    };
    const M = this.a.mat;
    add(road, M.road, true);
    add(white, M.white);
    add(yellow, M.yellow);
    add(checker, M.checker);
    add(walk, M.walk);
    add(curb, M.curb);
    add(barrier, M.barrier);
    add(green, M.medianGreen);
    add(noise, M.noiseWall);
    add(rail, M.rail);
    add(concrete, M.barrier);
    add(kerb, M.kerb);
    add(tyreWall, M.tyreWall);
    add(gravel, M.gravel, true);
    add(runoffGrass, M.runoffGrass, true);

    this.buildBuildings(add);
    this.buildInstances();
  }

  buildBuildings(add) {
    const t = this.track;
    const list = t.buildings;
    // s로 정렬돼 있으므로 이진 탐색
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].s < this.s0) lo = mid + 1;
      else hi = mid;
    }
    const r = mulberry32(this.idx * 104729 + 7);
    const variant = this.idx % 3;
    const walls = [new Geo(true), new Geo(true), new Geo(true), new Geo(true)];
    const cell = [
      [12, 23.2],
      [12, 3.5],
      [6, 12],
      [8, 8],
    ];
    const roofs = new Geo(true);
    const roofColor = new THREE.Color(0x9a9a98);
    const col = new THREE.Color();

    for (let b = lo; b < list.length && list[b].s < this.s0 + CHUNK; b++) {
      const { p, h, f } = list[b];
      const n = p.length / 2;
      const pts = [];
      for (let k = 0; k < n; k++) pts.push([p[2 * k] - this.ox, p[2 * k + 1] - this.oz]);
      // 위에서 볼 때 반시계(X=x, Y=-z)가 되도록 정렬 → 벽 법선이 바깥을 향함
      let area = 0;
      for (let k = 0; k < n; k++) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[(k + 1) % n];
        area += ax * -bz - bx * -az;
      }
      if (area < 0) pts.reverse();

      if (f === FACADE.APT) col.setHex(APT_TINTS[(r() * APT_TINTS.length) | 0]);
      else if (f === FACADE.PLAIN) col.setHex(PLAIN_TINTS[(r() * PLAIN_TINTS.length) | 0]);
      else if (f === FACADE.GLASS) col.setRGB(0.85 + r() * 0.15, 0.9 + r() * 0.1, 1);
      else col.setHex(0xffffff);

      // 지형 위에 세운다: 바닥은 가장 낮은 모서리보다 조금 아래, 높이는 평균 지면 기준
      let base = Infinity;
      let avg = 0;
      for (const [x, z] of pts) {
        const g = this.groundAt(x, z);
        base = Math.min(base, g);
        avg += g / n;
      }
      base -= 1;
      const top = avg + h;
      const geo = walls[f];
      const [cw, ch] = cell[f];
      let u = 0;
      for (let k = 0; k < n; k++) {
        const [ax, az] = pts[k];
        const [bx, bz] = pts[(k + 1) % n];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        const u0 = u / cw;
        const u1 = (u + len) / cw;
        u += len;
        // 반시계 다각형에서 바깥 법선 = (-ez, ex)
        const want = [-(bz - az), 0, bx - ax];
        const v0 = (base - avg) / ch; // 지면 아래로 묻힌 부분은 음수 v
        geo.quad([ax, base, az], [bx, base, bz], [bx, top, bz], [ax, top, az], want, [u0, v0], [u1, v0], [u1, h / ch], [u0, h / ch], col);
      }
      const contour = pts.map(([x, z]) => new THREE.Vector2(x, -z));
      for (const [a, b2, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
        roofs.tri([pts[a][0], top, pts[a][1]], [pts[b2][0], top, pts[b2][1]], [pts[c][0], top, pts[c][1]], UP, undefined, undefined, undefined, roofColor);
      }
    }

    add(walls[FACADE.APT], this.a.facadeMats[variant]);
    add(walls[FACADE.SHOP], this.a.shopMats[this.idx % this.a.shopMats.length]);
    add(walls[FACADE.GLASS], this.a.glassMat);
    add(walls[FACADE.PLAIN], this.a.plainMat);
    add(roofs, this.a.mat.roof);
  }

  buildInstances() {
    const t = this.track;
    const a = this.a;
    const inst = (geo, mat, count) => {
      if (!count) return null;
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    const r = this.r;

    // 서킷은 트랙이 서로 가까이 지나가는 곳이 있어, 다른 구간 노면·런오프 위에 놓인 나무는 뺀다
    if (t.loop) {
      const clear = t.w[0] / 2 + t.runoff + 2;
      this.trees = this.trees.filter(([i, d]) => {
        const [x, , z] = this.pt(i, d);
        return t.nearest(x + this.ox, z + this.oz, clear) < 0;
      });
    }
    const trunks = inst(a.geo.trunk, a.mat.trunk, this.trees.length);
    const crowns = inst(a.geo.crown, a.mat.crown, this.trees.length);
    this.trees.forEach(([i, d], k) => {
      const [x, , z] = this.pt(i, d);
      const gy = this.groundAt(x, z);
      const sy = 0.9 + r() * 0.5;
      dummy.position.set(x, gy, z);
      dummy.rotation.set(0, r() * Math.PI * 2, 0);
      dummy.scale.set(1, sy, 1);
      dummy.updateMatrix();
      trunks.setMatrixAt(k, dummy.matrix);
      const cs = 0.85 + r() * 0.5;
      dummy.position.y = gy + 2.4 * sy + 1.1;
      dummy.scale.set(cs, cs * 1.1, cs);
      dummy.updateMatrix();
      crowns.setMatrixAt(k, dummy.matrix);
      crowns.setColorAt(k, leafColor(r, tmpColor));
    });

    const poles = inst(a.geo.pole, a.mat.pole, this.lamps.length);
    const arms = inst(a.geo.arm, a.mat.pole, this.lamps.length);
    const heads = inst(a.geo.head, a.mat.head, this.lamps.length);
    this.lamps.forEach(([i, d, side], k) => {
      const [x, y, z] = this.pt(i, d);
      const ry = t.ry[i];
      // 팔은 도로 쪽으로: 오른쪽 길가는 -법선, 왼쪽은 +법선
      const theta = side > 0 ? ry + Math.PI : ry;
      const dx = Math.cos(theta);
      const dz = -Math.sin(theta);
      const put = (mesh, px, py, pz) => {
        dummy.position.set(px, py, pz);
        dummy.rotation.set(0, theta, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
      };
      put(poles, x, y, z);
      put(arms, x + dx * 1.25, y + 8.85, z + dz * 1.25);
      put(heads, x + dx * 2.45, y + 8.75, z + dz * 2.45);
    });
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      // 공유 지오메트리(나무·가로등)는 남기고 청크 전용만 해제
      else if (o.isMesh) o.geometry.dispose();
    });
  }
}

export class World {
  constructor(scene, track, terrain) {
    this.scene = scene;
    this.track = track;
    this.terrain = terrain;
    this.assets = World.assets ?? (World.assets = new Assets()); // 재질·텍스처는 트랙이 바뀌어도 재사용
    this.chunks = new Map();
    this.count = Math.ceil(track.length / CHUNK); // 순환 트랙의 청크 수
    this.maxIdx = Math.floor(track.length / CHUNK);
  }

  // s 주변에 있어야 할 청크 [index, 차까지 거리]. 순환 트랙은 인덱스를 감싼다
  wanted(s, behind = BEHIND, ahead = AHEAD) {
    const out = [];
    const t = this.track;
    const cur = Math.floor(s / CHUNK);
    for (let k = Math.floor((s - behind) / CHUNK); k <= Math.floor((s + ahead) / CHUNK); k++) {
      const idx = t.loop ? ((k % this.count) + this.count) % this.count : k;
      if (!t.loop && (idx < 0 || idx > this.maxIdx)) continue;
      out.push([idx, Math.abs(k - cur)]);
    }
    return out;
  }

  // 시작 시 화면에 보일 청크를 전부 즉시 생성
  prime(s) {
    for (const [i] of this.wanted(s)) if (!this.chunks.has(i)) this.chunks.set(i, new Chunk(this, i));
  }

  update(s) {
    const keep = new Set(this.wanted(s, BEHIND + CHUNK, AHEAD + CHUNK).map(([i]) => i));
    for (const [i, c] of this.chunks) {
      if (keep.has(i)) continue;
      c.dispose();
      this.chunks.delete(i);
    }
    // 가까운 청크부터, 프레임당 시간 한도 안에서
    const start = performance.now();
    const order = this.wanted(s).filter(([i]) => !this.chunks.has(i));
    order.sort((x, y) => x[1] - y[1]);
    for (const [i] of order) {
      this.chunks.set(i, new Chunk(this, i));
      if (performance.now() - start > BUILD_BUDGET_MS) break;
    }
  }

  dispose() {
    for (const c of this.chunks.values()) c.dispose();
    this.chunks.clear();
  }
}
