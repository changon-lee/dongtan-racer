import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KIND } from './track.js';

// 다른 차·오토바이. 트랙 좌표(s, d)로 움직이고 차로를 따라간다.
// dir = +1 내 진행 방향, -1 반대 차로(마주 오는 차).
// think()는 렌더 프레임마다(앞차 간격·차로 변경), step()은 물리 스텝마다(이동·충돌).

export const TRAFFIC_LEVELS = ['없음', '적게', '보통', '많게'];
const DENSITY = [0, 2.5, 6, 12]; // 차로 1개 · 1km당 대수
const BEHIND = 250;
const AHEAD = 1150;
const SPAWN_NEAR = 850; // 앞쪽 새 차는 이 거리 너머(안개 속)에 생긴다
const CLEAR = 80; // 처음 채울 때 내 차 주변 비워 두는 거리
const MAX_PER_TYPE = 300;
const BASE_KMH = [100, 60, 40, 55, 120]; // 도로 종류별 기본 속도 (고속, 간선, 이면, 램프, 서킷)

const PLAYER = { L: 4.72, W: 1.92, mass: 1910 };

// L·W·H (m), 질량(kg), 속도 배율
const TYPES = {
  sedan: { L: 4.7, W: 1.84, mass: 1500, speed: 1 },
  suv: { L: 4.8, W: 1.94, mass: 2000, speed: 1 },
  truck: { L: 6.6, W: 2.2, mass: 5000, speed: 0.85 },
  bus: { L: 11, W: 2.5, mass: 12000, speed: 0.8 },
  moto: { L: 2.1, W: 0.8, mass: 250, speed: 1.1 },
};
const TYPE_NAMES = Object.keys(TYPES);
// 고속도로·자동차전용도로엔 이륜차 통행 금지
const MIX_EXPRESS = { sedan: 0.52, suv: 0.3, truck: 0.14, bus: 0.04 };
const MIX_CITY = { sedan: 0.44, suv: 0.24, truck: 0.07, bus: 0.05, moto: 0.2 };

// 충돌
const HIT = {
  keep: 0.6, // 차를 뒤에서 박으면 운동량 보존 속도의 60%만 남김
  keepHeadOn: 0.25, // 마주 오는 차와 정면충돌
  sideLoss: 0.15, // 옆으로 긁으면 15%
  motoSideLoss: 0.02,
  motoLoss: 0.4, // 오토바이를 박으면 운동량 보존 손실의 40%만
  cool: 0.6, // s, 같은 차와 연속 충돌 무시
};

const PAINTS = {
  sedan: [[0xf2f2f0, 30], [0x1a1b1e, 18], [0x9a9da2, 16], [0x5d6166, 10], [0x23395b, 6], [0x8e1b1b, 5], [0xb8ad96, 4], [0x2f4a3a, 3]],
  suv: [[0xf2f2f0, 30], [0x1a1b1e, 22], [0x9a9da2, 14], [0x5d6166, 12], [0x23395b, 6], [0x6b5444, 5]],
  truck: [[0xf4f4f2, 40], [0x2a56a6, 30], [0x9ea3a8, 15], [0xc9372c, 5]],
  bus: [[0x2a62c9, 45], [0x3a9a4a, 30], [0xd2442f, 15], [0xf0b429, 10]],
  moto: [[0xd62d2d, 30], [0x1a1b1e, 30], [0xf2c230, 20], [0xf2f2f0, 20]],
};

const pickWeighted = (entries, r) => {
  const total = entries.reduce((s, e) => s + e[1], 0);
  let x = r * total;
  for (const e of entries) if ((x -= e[1]) < 0) return e[0];
  return entries[0][0];
};

// ---------- 모델 (앞이 -z). paint 부분은 인스턴스 색으로 칠하고 나머지는 고정 색 ----------

function part(geo, color, x, y, z) {
  const g = geo.toNonIndexed().translate(x, y, z);
  const c = new THREE.Color(color);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) arr.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}
const box = (w, h, l, color, x, y, z) => part(new THREE.BoxGeometry(w, h, l), color, x, y, z);
const wheel = (r, w, x, z) => part(new THREE.CylinderGeometry(r, r, w, 10).rotateZ(Math.PI / 2), 0x18181a, x, r, z);

const GLASS = 0x1c2630;
const TAIL = 0xb3121a;
const HEAD = 0xfff4d6;

function carModel({ L, W }, h0, hBody, hTop, cabinL, cabinZ) {
  const paint = [box(W, hBody - h0, L, 0xffffff, 0, (h0 + hBody) / 2, 0), box(W - 0.16, 0.08, cabinL - 0.3, 0xffffff, 0, hTop, cabinZ)];
  const fixed = [
    box(W - 0.12, hTop - hBody, cabinL, GLASS, 0, (hBody + hTop) / 2, cabinZ),
    box(0.45, 0.12, 0.04, TAIL, -W / 2 + 0.32, hBody - 0.14, L / 2 + 0.01),
    box(0.45, 0.12, 0.04, TAIL, W / 2 - 0.32, hBody - 0.14, L / 2 + 0.01),
    box(0.4, 0.1, 0.04, HEAD, -W / 2 + 0.3, hBody - 0.2, -L / 2 - 0.01),
    box(0.4, 0.1, 0.04, HEAD, W / 2 - 0.3, hBody - 0.2, -L / 2 - 0.01),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) fixed.push(wheel(0.33, 0.24, sx * (W / 2 - 0.1), sz * (L / 2 - 0.85)));
  return { paint: mergeGeometries(paint), fixed: mergeGeometries(fixed) };
}

function buildModels() {
  const { L: tL, W: tW } = TYPES.truck;
  const truck = {
    paint: mergeGeometries([box(tW, 1.7, 1.9, 0xffffff, 0, 1.15, -tL / 2 + 0.95)]),
    fixed: mergeGeometries([
      box(tW - 0.1, 0.6, 0.05, GLASS, 0, 1.65, -tL / 2 - 0.01),
      box(tW, 2.3, 4.5, 0xdadcdf, 0, 1.75, tL / 2 - 2.25),
      box(tW - 0.2, 0.25, tL, 0x2b2b2d, 0, 0.45, 0),
      box(0.3, 0.12, 0.04, TAIL, -tW / 2 + 0.25, 0.75, tL / 2 + 0.01),
      box(0.3, 0.12, 0.04, TAIL, tW / 2 - 0.25, 0.75, tL / 2 + 0.01),
      ...[-1, 1].flatMap((sx) => [wheel(0.45, 0.3, sx * (tW / 2 - 0.15), -tL / 2 + 1.2), wheel(0.45, 0.3, sx * (tW / 2 - 0.15), tL / 2 - 1.3)]),
    ]),
  };
  const { L: bL, W: bW } = TYPES.bus;
  const bus = {
    paint: mergeGeometries([box(bW, 1.3, bL, 0xffffff, 0, 0.95, 0), box(bW, 0.35, bL, 0xffffff, 0, 3.0, 0)]),
    fixed: mergeGeometries([
      box(bW + 0.02, 1.2, bL - 0.6, GLASS, 0, 2.2, 0.2),
      box(bW - 0.1, 1.4, 0.05, GLASS, 0, 2.1, -bL / 2 - 0.01),
      box(0.35, 0.3, 0.04, TAIL, -bW / 2 + 0.3, 1.1, bL / 2 + 0.01),
      box(0.35, 0.3, 0.04, TAIL, bW / 2 - 0.3, 1.1, bL / 2 + 0.01),
      ...[-1, 1].flatMap((sx) => [wheel(0.5, 0.3, sx * (bW / 2 - 0.2), -bL / 2 + 2.3), wheel(0.5, 0.3, sx * (bW / 2 - 0.2), bL / 2 - 2.8)]),
    ]),
  };
  const moto = {
    paint: mergeGeometries([
      box(0.34, 0.32, 0.9, 0xffffff, 0, 0.78, -0.05),
      part(new THREE.SphereGeometry(0.17, 10, 8), 0xffffff, 0, 1.72, 0.12), // 헬멧
    ]),
    fixed: mergeGeometries([
      wheel(0.31, 0.12, 0, -0.72),
      wheel(0.31, 0.12, 0, 0.72),
      box(0.12, 0.12, 1.5, 0x2b2b2d, 0, 0.45, 0),
      box(0.42, 0.62, 0.3, 0x2c2f36, 0, 1.25, 0.18), // 상체
      box(0.36, 0.2, 0.55, 0x23262c, 0, 0.92, 0.25), // 다리
      box(0.5, 0.06, 0.06, 0x111111, 0, 1.08, -0.42), // 핸들
      box(0.18, 0.08, 0.04, TAIL, 0, 0.8, 0.86),
      box(0.16, 0.12, 0.04, HEAD, 0, 0.98, -0.55),
    ]),
  };
  return {
    sedan: carModel(TYPES.sedan, 0.22, 0.95, 1.42, 2.3, 0.25),
    suv: carModel(TYPES.suv, 0.28, 1.08, 1.72, 2.8, 0.35),
    truck,
    bus,
    moto,
  };
}

// ---------- 시스템 ----------

export class Traffic {
  constructor(scene, track) {
    this.track = track;
    this.level = 2;
    this.list = [];
    this.events = []; // 이번 프레임 충돌 세기 (소리용)
    this.rand = Math.random;
    const models = buildModels();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.meshes = {};
    for (const name of TYPE_NAMES) {
      const paint = new THREE.InstancedMesh(models[name].paint, mat, MAX_PER_TYPE);
      const fixed = new THREE.InstancedMesh(models[name].fixed, mat, MAX_PER_TYPE);
      paint.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 3), 3);
      for (const m of [paint, fixed]) {
        m.count = 0;
        m.frustumCulled = false;
        m.castShadow = true;
        scene.add(m);
      }
      this.meshes[name] = { paint, fixed };
    }
  }

  dispose() {
    for (const { paint, fixed } of Object.values(this.meshes)) {
      for (const m of [paint, fixed]) {
        m.removeFromParent();
        m.geometry.dispose();
        m.dispose();
      }
    }
    this.list = [];
  }

  setLevel(level) {
    this.level = level;
  }

  // dir 방향 lane번 차로 중심 d. 반대 차로가 없으면 null
  laneD(s, dir, lane) {
    const t = this.track;
    const [i] = t.index(s);
    const half = t.w[i] / 2;
    if (dir > 0) {
      const n = t.lanes[i];
      return -half + ((Math.min(lane, n - 1) + 0.5) * 2 * half) / n;
    }
    const n = t.opp[i];
    if (!n || t.oppW[i] < 1) return null;
    return -half - t.medW[i] - ((Math.min(lane, n - 1) + 0.5) * t.oppW[i]) / n;
  }

  desiredSpeed(v) {
    return (BASE_KMH[this.track.kindAt(v.s)] / 3.6) * TYPES[v.type].speed * v.factor;
  }

  // 차로 lane에 [s0, s1] 범위 안 다른 차가 있는지
  laneBusy(dir, lane, s0, s1, self) {
    for (const o of this.list) {
      if (o === self || o.dir !== dir || o.lane !== lane || o.hitT > 0) continue;
      if (o.s > s0 && o.s < s1) return true;
    }
    return false;
  }

  // v를 [lo, hi] 구간 어딘가에 새 차로 배치. 실패하면 false
  place(v, lo, hi, player) {
    const t = this.track;
    for (let tries = 0; tries < 6; tries++) {
      const s = lo + this.rand() * (hi - lo);
      if (s < 30 || s > t.length - 30) continue;
      if (Math.abs(s - player) < CLEAR && lo < player && hi > player) continue;
      const [i] = t.index(s);
      const ours = t.lanes[i];
      const opp = t.oppW[i] >= 1 ? t.opp[i] : 0;
      const dir = this.rand() * (ours + opp * 0.8) < ours ? 1 : -1;
      const lane = Math.floor(this.rand() * (dir > 0 ? ours : opp));
      if (this.laneBusy(dir, lane, s - 25, s + 25, v)) continue;
      const express = t.kind[i] === KIND.EXPRESS || t.kind[i] === KIND.RAMP;
      const type = pickWeighted(Object.entries(express ? MIX_EXPRESS : MIX_CITY), this.rand());
      Object.assign(v, {
        type, dir, lane, s,
        d: this.laneD(s, dir, lane),
        factor: 0.9 + this.rand() * 0.22,
        laneCool: 2 + this.rand() * 6,
        hitT: 0, cool: 0, vd: 0, spin: 0, spinRate: 0, yawVis: 0, crashed: false, dead: false,
        moto: type === 'moto' ? (this.rand() - 0.5) * 1.2 : 0, // 오토바이는 차로 안에서 한쪽으로 치우쳐 달림
        color: new THREE.Color(pickWeighted(PAINTS[type], this.rand())),
      });
      v.v = this.desiredSpeed(v);
      v.target = v.v;
      return true;
    }
    return false;
  }

  think(dt, car) {
    const t = this.track;
    const ps = car.distance;
    // 목표 대수: 앞 1km의 평균 차로 수 × 밀도 × 구간 길이
    let lanes = 0;
    for (let k = 0; k < 10; k++) {
      const [i] = t.index(ps + k * 100);
      lanes += t.lanes[i] + (t.oppW[i] >= 1 ? t.opp[i] * 0.8 : 0);
    }
    const target = Math.round((DENSITY[this.level] * (lanes / 10) * (BEHIND + AHEAD)) / 1000);

    // 구간 밖·사고 처리 끝난 차 재배치
    for (const v of this.list) {
      const rel = v.s - ps;
      const noLane = v.dir < 0 && this.laneD(v.s, -1, v.lane) === null;
      const wrongRoad = v.type === 'moto' && t.kindAt(v.s) === KIND.EXPRESS;
      if (!(v.dead || noLane || wrongRoad || rel < -BEHIND || rel > AHEAD + 100)) continue;
      // 멀리 순간이동했으면 구간 전체에, 뒤로 빠졌으면 앞쪽 안개 속에, 앞질러 갔으면 뒤쪽에
      let ok;
      if (Math.abs(rel) > BEHIND + AHEAD) ok = this.place(v, ps - BEHIND, ps + AHEAD, ps);
      else if (rel > AHEAD) ok = this.place(v, ps - BEHIND, ps - BEHIND + 60, ps);
      else ok = this.place(v, ps + SPAWN_NEAR, ps + AHEAD, ps);
      if (!ok) v.dead = true;
    }
    // 대수 맞추기
    let spawns = 0;
    while (this.list.length < target && spawns++ < 30) {
      const v = {};
      const fill = this.list.length < target * 0.5;
      if (this.place(v, fill ? ps - BEHIND : ps + SPAWN_NEAR, ps + AHEAD, ps)) this.list.push(v);
    }
    if (this.list.length > target) {
      // 화면에 안 보이는 차부터 제거
      let excess = this.list.length - target;
      this.list = this.list.filter((v) => {
        const rel = v.s - ps;
        if (excess > 0 && (v.dead || rel < -30 || rel > SPAWN_NEAR)) {
          excess--;
          return false;
        }
        return true;
      });
    }

    // 앞차 찾기: 방향별로 진행 순서 정렬
    const byDir = { 1: [], '-1': [] };
    for (const v of this.list) if (!v.dead) byDir[v.dir].push(v);
    for (const dir of [1, -1]) {
      const arr = byDir[dir].sort((a, b) => dir * (a.s - b.s));
      for (let k = 0; k < arr.length; k++) {
        const v = arr[k];
        if (v.hitT > 0) continue;
        const want = this.desiredSpeed(v);
        let leader = null;
        let gap = Infinity;
        for (let j = k + 1; j < arr.length; j++) {
          const o = arr[j];
          const ds = dir * (o.s - v.s);
          if (ds > 120) break;
          if (Math.abs(o.d - v.d) > (TYPES[o.type].W + TYPES[v.type].W) / 2 + 0.4) continue;
          gap = ds - (TYPES[o.type].L + TYPES[v.type].L) / 2;
          leader = { v: dir * (o.dir * o.v) };
          break;
        }
        // 내 차도 앞차로 본다 (같은 방향, 같은 차로)
        if (dir > 0) {
          const ds = ps - v.s;
          if (ds > 0 && ds < 120 && Math.abs(car.d - v.d) < (PLAYER.W + TYPES[v.type].W) / 2 + 0.4) {
            const g = ds - (PLAYER.L + TYPES[v.type].L) / 2;
            if (g < gap) {
              gap = g;
              leader = { v: car.v };
            }
          }
        }
        let tgt = want;
        if (leader) {
          const minGap = 5 + v.v * 0.9; // 0.9초 차간 시간
          tgt = Math.min(want, Math.max(0, leader.v + (gap - minGap) * 0.6));
        }
        v.target = tgt;
        // 막히면 옆 차로로
        v.laneCool -= dt;
        if (leader && leader.v < want - 3 && gap < 70 && v.laneCool <= 0) {
          const [i] = t.index(v.s);
          const n = dir > 0 ? t.lanes[i] : t.opp[i];
          const side = this.rand() < 0.5 ? -1 : 1;
          for (const nl of [v.lane + side, v.lane - side]) {
            if (nl < 0 || nl >= n) continue;
            const lo = v.s - (dir > 0 ? 20 : 35);
            const hi = v.s + (dir > 0 ? 35 : 20);
            if (!this.laneBusy(dir, nl, lo, hi, v)) {
              v.lane = nl;
              break;
            }
          }
          v.laneCool = 3 + this.rand() * 5;
        }
      }
    }
  }

  step(dt, car) {
    for (const v of this.list) {
      if (v.dead) continue;
      v.cool = Math.max(0, v.cool - dt);
      const prevD = v.d;
      if (v.hitT > 0) {
        // 사고 후: 미끄러지며 감속·회전
        v.hitT -= dt;
        v.v = Math.max(0, v.v - (v.crashed ? 8 : 5) * dt);
        v.d += v.vd * dt;
        v.vd *= Math.exp(-2 * dt);
        v.spin += v.spinRate * dt;
        v.spinRate *= Math.exp(-1.5 * dt);
        if (v.hitT <= 0) {
          if (v.crashed) v.dead = true;
          else this.relane(v);
        }
      } else {
        v.v += THREE.MathUtils.clamp(v.target - v.v, -8 * dt, 2.5 * dt);
        const ld = this.laneD(v.s, v.dir, v.lane);
        if (ld !== null) v.d += (ld + v.moto - v.d) * (1 - Math.exp(-1.4 * dt));
        v.spin *= Math.exp(-3 * dt);
      }
      v.s += v.dir * v.v * dt;
      v.yawVis = -v.dir * Math.atan2(v.d - prevD, Math.max(v.v, 1) * dt);
    }
    this.collide(car);
  }

  // 사고 후 가장 가까운 차로로 복귀
  relane(v) {
    const t = this.track;
    const [i] = t.index(v.s);
    const n = v.dir > 0 ? t.lanes[i] : t.opp[i];
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      const d = Math.abs(this.laneD(v.s, v.dir, k) - v.d);
      if (d < bd) [bd, best] = [d, k];
    }
    v.lane = best;
  }

  collide(car) {
    const ps = car.distance;
    for (const v of this.list) {
      if (v.dead || v.crashed) continue;
      const T = TYPES[v.type];
      const ds = v.s - ps;
      if (Math.abs(ds) > 15) continue;
      const dd = v.d - car.d;
      const penS = (PLAYER.L + T.L) / 2 - Math.abs(ds);
      const penD = (PLAYER.W + T.W) / 2 - Math.abs(dd);
      if (penS <= 0 || penD <= 0) continue;
      const moto = v.type === 'moto';
      const vp = car.v;
      const vv = v.dir * v.v;
      const side = Math.sign(dd) || 1; // 차가 내 오른쪽(+)에 있으면 +1

      if (penD < penS) {
        // 옆으로 긁음: 서로 밀어냄
        car.d -= side * penD * (moto ? 0.1 : 0.5);
        v.d += side * penD * (moto ? 0.9 : 0.5);
        if (v.cool > 0) continue;
        v.cool = HIT.cool;
        car.crash(vp * (moto ? HIT.motoSideLoss : HIT.sideLoss), moto ? 0.15 : 0.5);
        car.yaw *= 0.3;
        this.knock(v, side * (moto ? 7 : 3), moto, Math.min(1, Math.abs(vp - vv) / 20));
        this.events.push(moto ? 0.3 : 0.5);
        continue;
      }

      // 앞뒤로 박음: 겹치지 않게 떼어 놓고 운동량 교환
      if (ds > 0) car.distance = v.s - (PLAYER.L + T.L) / 2 - 0.05;
      else v.s = ps - (PLAYER.L + T.L) / 2 - 0.05;
      if (v.cool > 0) continue;
      v.cool = HIT.cool;
      const vc = (PLAYER.mass * vp + T.mass * vv) / (PLAYER.mass + T.mass);
      const rel = Math.abs(vp - vv);
      const strength = Math.min(1, rel / 25);
      if (moto) {
        // 가벼워서 내 차는 거의 그대로, 오토바이는 튕겨 나감
        car.crash(Math.max(0, vp - vc) * HIT.motoLoss, 0.25);
        v.dir = 1;
        v.v = Math.max(0, vp * 1.05);
        this.knock(v, (this.rand() < 0.5 ? -1 : 1) * 5, true, 1);
        this.events.push(0.35);
      } else {
        const hitFromBehind = vv > vp; // 뒤차가 나를 박음
        const after = hitFromBehind ? vc : Math.max(0, vc * (vv < -1 ? HIT.keepHeadOn : HIT.keep));
        if (after < vp) car.crash(vp - after, 1);
        else car.v = after;
        v.v = Math.max(0, v.dir * (hitFromBehind ? Math.min(vc, vv) : Math.max(vc, vv * 0.5)));
        this.knock(v, (this.rand() - 0.5) * 4, false, strength);
        this.events.push(0.4 + 0.6 * strength);
      }
    }
  }

  knock(v, vd, crashed, strength) {
    v.vd = vd;
    v.spinRate = (this.rand() < 0.5 ? -1 : 1) * (crashed ? 6 + this.rand() * 4 : 0.5 + strength * 2.5);
    v.hitT = crashed ? 2.5 : 1.2 + strength;
    v.crashed = crashed;
  }

  // 인스턴스 행렬 갱신
  sync() {
    const t = this.track;
    const counts = {};
    for (const name of TYPE_NAMES) counts[name] = 0;
    const dummy = this.dummy ?? (this.dummy = new THREE.Object3D());
    dummy.rotation.order = 'YXZ';
    const pose = this.pose ?? (this.pose = {});
    for (const v of this.list) {
      if (v.dead) continue;
      const k = counts[v.type];
      if (k >= MAX_PER_TYPE) continue;
      counts[v.type]++;
      t.pose(v.s, v.d, pose);
      dummy.position.set(pose.x, pose.y, pose.z);
      dummy.rotation.set(Math.atan(pose.grade * v.dir), pose.ry + (v.dir < 0 ? Math.PI : 0) + v.yawVis + v.spin, v.crashed ? THREE.MathUtils.clamp(v.spin * 0.3, -1.4, 1.4) : 0);
      dummy.updateMatrix();
      const m = this.meshes[v.type];
      m.paint.setMatrixAt(k, dummy.matrix);
      m.fixed.setMatrixAt(k, dummy.matrix);
      m.paint.setColorAt(k, v.color);
    }
    for (const name of TYPE_NAMES) {
      const m = this.meshes[name];
      m.paint.count = m.fixed.count = counts[name];
      m.paint.instanceMatrix.needsUpdate = m.fixed.instanceMatrix.needsUpdate = true;
      m.paint.instanceColor.needsUpdate = true;
    }
  }
}
