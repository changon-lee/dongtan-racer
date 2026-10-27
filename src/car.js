import * as THREE from 'three';
import { buildModel3, PAINTS, WHEEL_R } from './model3.js';
import { FINISH_MARGIN } from './track.js';

// Tesla Model 3 Performance 근사 스펙
const SPEC = {
  mass: 1910, // kg
  power: 460e3, // W
  traction: 9.2, // m/s², 저속 구간 트랙션 한계
  vmax: 262 / 3.6, // m/s, 전자식 속도 제한
  dragK: 0.5 * 1.225 * 0.219 * 2.22, // ½ρ·Cd·A
  rollA: 0.011 * 9.81, // 구름저항 가속도
  brake: 10,
  regen: 1.8, // 페달을 떼면 회생제동
  wheelbase: 2.875,
  wheelR: WHEEL_R,
};

// 부스터: 가득 찬 게이지로 BOOST_TIME초 분사. 다 쓰면 키를 뗐다 다시 눌러야 재발사
export const BOOST = {
  time: 4, // s, 게이지 100% 사용 시간
  charge: 20, // s, 충전 속도 ×1에서 0 → 100%
  thrust: 7, // m/s², 트랙션과 무관한 추력
  overKmh: 80, // 부스터 중엔 최고속도 + 80 km/h까지
  minStart: 0.1, // 발사에 필요한 최소 게이지
};

// 조향 (게임용으로 현실보다 잘 돈다)
const STEER = {
  latGrip: 16, // m/s², 횡가속 한계 (실차 ~9)
  minYawRate: 0.3, // rad/s, 초고속에서도 이만큼은 돈다 (250km/h에서 반경 ~230m)
  yawFade: 40, // 최대 헤딩 0.5rad가 이 속도(m/s)에서 절반으로
};

// 벽 충돌: 한 번에 깎지 않고 서서히.
// 부딪히면 벽 쪽 속도 성분만큼을 짧은 시간에 나눠 잃고, 벽에 붙어 있는 동안 마찰 감속이 점점 세진다.
// 금방 떼면 조금, 오래 박혀 있으면 많이 줄어든다.
const WALL = {
  impactLoss: 1.2, // 벽 쪽 속도 성분의 몇 배를 잃는지
  hitLoss: 0.05, // + 새로 부딪힐 때마다 현재 속도의 5%
  impactTime: 0.25, // s, 충돌 손실이 빠지는 시간
  grindStart: 5, // m/s², 닿자마자 마찰 감속
  grindMax: 22, // m/s², 오래 붙어 있을 때
  grindRamp: 1.5, // s, grindStart → grindMax
  press: 0.4, // 벽 쪽으로 조향 중이면 마찰 +40%
  band: 0.3, // m, 벽에서 이 거리 안이면 붙어 있는 것으로 봄
  release: 2, // 벽에서 떨어지면 접촉 시간이 이 배속으로 줄어듦
};

// 서킷 런오프: 감속 = drag + dragV·v (m/s², 빠를수록 세게), 구동력·부스터 추력 × grip
// 자갈에선 시속 30km 남짓, 잔디에선 90km 남짓으로만 기어 나올 수 있다
const RUNOFF = {
  gravel: { drag: 2, dragV: 0.3, grip: 0.5 }, // 200km/h에서 18.7, 100km/h에서 10.3 m/s²
  grass: { drag: 1, dragV: 0.22, grip: 0.7 }, // 200km/h에서 13.2, 100km/h에서 7.1 m/s²
};
// 조향 보조를 끄면 트랙 대비 헤딩 제한을 이만큼으로 넓힌다 (rad)
const FREE_YAW = 1;

const KMH100 = 100 / 3.6;
const G = 9.81;
const clamp = THREE.MathUtils.clamp;

// 위치는 트랙 기준: distance = 경로상 거리 s, d = 중심선에서 오른쪽(+) 오프셋, yaw = 트랙 방향 대비 헤딩
// 서킷(track.loop)이면 distance는 한 바퀴 안에서 돌고, travel이 누적 주행 거리, 랩은 travel로 센다
export class Car {
  constructor(envMap, track) {
    this.track = track;
    this.root = new THREE.Group();
    this.body = new THREE.Group(); // 피치·롤용 피벗
    this.root.rotation.order = 'YXZ'; // 헤딩 → 경사(피치)
    this.root.add(this.body);
    this.wheels = [];
    this.paintIdx = 0;
    buildModel3(this, envMap);
    this.pose = { x: 0, y: 0, z: 0, ry: 0, grade: 0 };
    this.last100 = null;
    this.best100 = null;
    this.topSpeed = 0;
    this.vmax = SPEC.vmax;
    this.accelMul = 1;
    this.chargeMul = 1;
    this.laps = 3;
    this.assist = true;
    this.flames = buildFlames();
    this.body.add(this.flames);
    this.boostVis = 0;
    this.setTrack(track);
  }

  setTrack(track) {
    this.track = track;
    this.finishS = track.loop ? Infinity : track.length - FINISH_MARGIN;
    // 서킷은 출발선 뒤 그리드에서 출발 → 첫 랩은 그만큼 길다
    this.lapOffset = track.loop ? track.length - track.startS : 0;
    this.restart();
  }

  // 출발점으로
  restart() {
    this.distance = this.track.startS;
    this.travel = 0;
    this.courseTime = null; // 코스 기록: 첫 출발부터 결승선까지
    this.lapTimes = [];
    this.lapStart = 0;
    this.finished = false;
    this.d = Infinity; // reset()에서 맨 오른쪽 차로로
    this.boostGauge = 1;
    this.reset();
  }

  // 옵션: 최고속도(km/h), 가속력 배율(트랙션·출력에 곱함), 부스터 충전 속도 배율, 조향 보조
  setOptions({ vmaxKmh, accelMul, chargeMul, laps, assist }) {
    this.vmax = vmaxKmh / 3.6;
    this.accelMul = accelMul;
    this.chargeMul = chargeMul;
    if (laps) this.laps = laps;
    if (assist !== undefined) this.assist = assist;
  }

  get lap() {
    return Math.min(this.laps, this.lapTimes.length + 1);
  }

  get bestLap() {
    return this.lapTimes.length ? Math.min(...this.lapTimes) : null;
  }

  // 제자리에서 정지 + 가장 가까운 차로 중앙으로
  reset() {
    const t = this.track;
    const [i] = t.index(this.distance);
    const lanes = t.lanes[i];
    const laneW = t.w[i] / lanes;
    const k = Math.min(lanes - 1, Math.max(0, Math.floor((this.d + t.w[i] / 2) / laneW)));
    this.d = -t.w[i] / 2 + (k + 0.5) * laneW;
    this.v = 0;
    this.yaw = 0;
    this.steer = 0;
    this.pedal = 0;
    this.accel = 0;
    this.accelSmooth = 0;
    this.latAccel = 0;
    this.latSmooth = 0;
    this.wheelAngle = 0;
    this.scrape = 0;
    this.powerFrac = 0;
    this.regenFrac = 0;
    this.braking = false;
    this.boosting = false;
    this.boostLock = false;
    this.wallLoss = 0; // 아직 덜 빠진 충돌 감속 (m/s)
    this.crashLoss = 0; // 다른 차와 충돌한 감속 (m/s), 0.12초에 걸쳐 빠짐
    this.wallTime = 0; // 벽에 붙어 있던 시간 (s)
    this.offTrack = 0; // 런오프에 걸친 차폭 비율
    this.timer = null; // 0-100 측정 중이면 경과 시간
  }

  // 다른 차와 충돌: loss(m/s)만큼 빠르게 감속, shake는 카메라 흔들림 세기
  crash(loss, shake) {
    this.crashLoss += loss;
    this.scrape = Math.min(1, this.scrape + shake);
  }

  setPaint(idx) {
    this.paintIdx = idx;
    const [, color, metalness, roughness] = PAINTS[idx];
    this.paint.color.setHex(color);
    this.paint.metalness = metalness;
    this.paint.roughness = roughness;
  }

  update(dt, input) {
    const S = SPEC;
    const track = this.track;
    // 결승 후에는 자동 정지
    const throttleIn = this.finished ? 0 : input.throttle;
    const brakeIn = this.finished || input.brake;
    const steerIn = input.steer;

    this.pedal += (throttleIn - this.pedal) * Math.min(1, dt * 10);
    this.steer += (steerIn - this.steer) * Math.min(1, dt * (steerIn === 0 ? 6 : 4));
    this.braking = brakeIn;

    // 부스터 게이지
    const boostIn = input.boost && !this.finished;
    if (!boostIn) this.boostLock = false;
    if (this.boosting && !boostIn) this.boosting = false;
    if (!this.boosting && boostIn && !this.boostLock && this.boostGauge >= BOOST.minStart) this.boosting = true;
    if (this.boosting) {
      this.boostGauge -= dt / BOOST.time;
      if (this.boostGauge <= 0) {
        this.boostGauge = 0;
        this.boosting = false;
        this.boostLock = true;
      }
    } else {
      this.boostGauge = Math.min(1, this.boostGauge + (dt * this.chargeMul) / BOOST.charge);
    }

    // 서킷 런오프(자갈·잔디)에 걸친 비율만큼 미끄러지고 끌린다
    this.offTrack = track.offTrack(this.distance, this.d);
    const surf = this.offTrack > 0 ? (track.gravelAt(track.index(this.distance)[0]) ? RUNOFF.gravel : RUNOFF.grass) : null;
    const grip = surf ? 1 - (1 - surf.grip) * this.offTrack : 1;

    // 종방향
    const v = this.v;
    const power = S.power * this.accelMul;
    let drive = 0;
    if (this.pedal > 0.01) {
      drive = Math.min(S.traction * this.accelMul, power / (S.mass * Math.max(v, 0.5))) * this.pedal;
      drive *= clamp((this.vmax + 0.2 - v) / 0.5, 0, 1); // 리미터: 공기저항과 평형이 vmax에 오도록
    }
    let thrust = 0;
    if (this.boosting) thrust = BOOST.thrust * clamp((this.vmax + BOOST.overKmh / 3.6 + 0.2 - v) / 0.5, 0, 1);
    drive *= grip;
    thrust *= grip;
    const resist = v > 0.01 ? (S.dragK * v * v) / S.mass + S.rollA : 0;
    const rough = surf && v > 0.05 ? (surf.drag + surf.dragV * v) * this.offTrack : 0;
    const regen = v > 0.3 ? S.regen * (1 - this.pedal) * Math.min(1, v / 5) : 0;
    const brake = brakeIn ? S.brake : 0;
    // 오르막이면 감속, 내리막이면 가속. 정지 상태에선 밀려 내려가지 않음(오토 홀드)
    const g = track.gradeAt(this.distance) * Math.cos(this.yaw);
    const slope = (G * g) / Math.sqrt(1 + g * g);
    this.v = Math.max(0, v + (drive + thrust - resist - rough - regen - brake - (v > 0.05 ? slope : 0)) * dt);
    this.accel = (this.v - v) / dt;
    this.powerFrac = (drive * S.mass * this.v) / power;
    this.regenFrac = (regen * S.mass * this.v) / power;
    this.topSpeed = Math.max(this.topSpeed, this.v);

    // 0-100 측정: 정지 상태에서 출발하면 시작, 브레이크·페달 뗌이면 취소
    if (v < 0.05 && this.v >= 0.05) this.timer = 0;
    if (this.timer !== null) {
      this.timer += dt;
      if (brakeIn || throttleIn === 0) {
        this.timer = null;
      } else if (this.v >= KMH100) {
        this.last100 = this.timer;
        this.best100 = this.best100 === null ? this.timer : Math.min(this.best100, this.timer);
        this.timer = null;
      }
    }

    // 횡방향: 자전거 모델 + 횡가속 한계. 고속일수록 조향각·최대 헤딩 축소
    const steerMax = 0.5 / (1 + this.v / 9);
    let yawRate = (this.v * Math.tan(this.steer * steerMax)) / S.wheelbase;
    const yawLimit = Math.max(STEER.latGrip / Math.max(this.v, 1), STEER.minYawRate);
    yawRate = clamp(yawRate, -yawLimit, yawLimit);
    const ds = Math.cos(this.yaw) * this.v * dt;
    // 도로가 휘면 트랙 기준 헤딩은 그만큼 반대로 돈다 (조향 안 하면 바깥으로 밀림)
    this.yaw += yawRate * dt - track.curvature(this.distance) * ds;
    // 조향 보조: 키를 놓으면 도로 방향으로 정렬하고, 도로 대비 헤딩을 속도에 따라 좁게 제한
    // 끄면 놓아도 헤딩이 그대로라 직접 반대로 꺾어 바로잡아야 한다
    if (this.assist && steerIn === 0) this.yaw *= Math.exp(-2.5 * dt);
    const maxYaw = this.assist ? 0.5 / (1 + this.v / STEER.yawFade) : FREE_YAW;
    this.yaw = clamp(this.yaw, -maxYaw, maxYaw);
    this.latAccel = this.v * yawRate;

    this.d -= Math.sin(this.yaw) * this.v * dt;
    this.travel += ds;
    this.distance = track.loop ? track.wrapS(this.distance + ds) : Math.min(this.distance + ds, track.length - 3);

    // 코스 기록 · 랩
    if (this.courseTime === null && !this.finished && this.v > 0.05) this.courseTime = 0;
    if (this.courseTime !== null && !this.finished) {
      this.courseTime += dt;
      if (this.distance >= this.finishS) this.finished = true;
      // k번째 랩은 출발선을 k번째 다시 넘을 때 끝난다 (그리드 → 출발선 lapOffset 포함)
      if (track.loop && this.travel >= this.lapOffset + track.length * (this.lapTimes.length + 1)) {
        this.lapTimes.push(this.courseTime - this.lapStart);
        this.lapStart = this.courseTime;
        if (this.lapTimes.length >= this.laps) this.finished = true;
      }
    }
    // 중앙분리대·연석·방음벽 충돌
    this.scrape = Math.max(0, this.scrape - dt * 3);
    // 런오프 위에선 덜컹거림 (카메라 흔들림·소음)
    if (this.offTrack > 0) this.scrape = Math.max(this.scrape, this.offTrack * Math.min(0.35, this.v / 60));
    const [dMin, dMax] = track.bounds(this.distance);
    if (this.d < dMin || this.d > dMax) {
      const intoWall = this.d < dMin ? this.yaw > 0 : this.yaw < 0;
      this.d = clamp(this.d, dMin, dMax);
      if (intoWall) {
        const impact = Math.abs(Math.sin(this.yaw)) * this.v;
        // 새 충돌은 접촉이 완전히 끝난 뒤에만 (긁는 중 재접촉은 마찰로만)
        if (this.wallTime === 0) {
          this.wallLoss += impact * WALL.impactLoss + this.v * WALL.hitLoss;
          this.scrape = Math.min(1, this.scrape + impact / 5);
        }
        // 벽 쪽으로 계속 조향하면 벽을 따라 미끄러지고, 아니면 살짝 튕겨 나온다
        const pressing = this.d > 0 ? steerIn < 0 : steerIn > 0;
        this.yaw = pressing ? 0 : -this.yaw * 0.3;
      }
      this.wallTime += dt;
    } else if (this.wallTime > 0 && (this.d < dMin + WALL.band || this.d > dMax - WALL.band)) {
      this.wallTime += dt; // 튕겨 나왔다가 다시 붙는 동안도 계속 긁는 중
    } else {
      this.wallTime = Math.max(0, this.wallTime - dt * WALL.release);
    }
    if (this.crashLoss > 0) {
      const dv = this.crashLoss * (1 - Math.exp(-dt / 0.12));
      this.v = Math.max(0, this.v - dv);
      this.crashLoss = this.crashLoss - dv < 0.01 ? 0 : this.crashLoss - dv;
    }
    // 충돌 손실을 impactTime 동안 나눠서
    if (this.wallLoss > 0) {
      const dv = this.wallLoss * (1 - Math.exp(-dt / WALL.impactTime));
      this.v = Math.max(0, this.v - dv);
      this.wallLoss = this.wallLoss - dv < 0.01 ? 0 : this.wallLoss - dv;
    }
    // 붙어 있는 동안 마찰: 오래 붙어 있을수록, 벽 쪽으로 조향할수록 세게
    const near = this.d < dMin + WALL.band || this.d > dMax - WALL.band;
    if (near && this.wallTime > 0 && this.v > 1) {
      const pressing = this.d > 0 ? this.steer < -0.1 : this.steer > 0.1;
      const k = Math.min(1, this.wallTime / WALL.grindRamp);
      const grind = (WALL.grindStart + (WALL.grindMax - WALL.grindStart) * k) * (pressing ? 1 + WALL.press : 1);
      this.v = Math.max(0, this.v - grind * dt);
      this.scrape = Math.max(this.scrape, 0.2 + 0.4 * k);
    }
  }

  // 렌더 프레임마다 메시 갱신
  sync(dt) {
    const p = this.track.pose(this.distance, this.d, this.pose);
    this.root.position.set(p.x, p.y, p.z);
    this.root.rotation.y = p.ry + this.yaw;
    this.root.rotation.x = Math.atan(p.grade * Math.cos(this.yaw));

    const k = 1 - Math.exp(-5 * dt);
    this.accelSmooth += (this.accel - this.accelSmooth) * k;
    this.latSmooth += (this.latAccel - this.latSmooth) * k;
    this.body.rotation.x = clamp(this.accelSmooth * 0.0045, -0.05, 0.05);
    this.body.rotation.z = clamp(-this.latSmooth * 0.006, -0.05, 0.05);

    this.wheelAngle = (this.wheelAngle + (this.v / SPEC.wheelR) * dt) % (Math.PI * 2);
    const steerVis = this.steer * (0.45 / (1 + this.v / STEER.yawFade));
    for (const w of this.wheels) {
      w.spin.rotation.x = -this.wheelAngle;
      if (w.front) w.pivot.rotation.y = steerVis;
    }
    this.setBrakeLights(this.braking);

    // 부스터 불꽃: 켜고 끌 때 짧게 커지고 줄어듦 + 깜빡임
    this.boostVis += ((this.boosting ? 1 : 0) - this.boostVis) * (1 - Math.exp(-14 * dt));
    this.flames.visible = this.boostVis > 0.02;
    if (this.flames.visible) {
      for (const f of this.flames.children) {
        const flicker = 0.75 + Math.random() * 0.5;
        f.scale.set(this.boostVis, this.boostVis, this.boostVis * flicker * f.userData.len);
      }
    }
  }
}

// 리어 디퓨저 양쪽에서 뒤(+z)로 뿜는 불꽃. 바깥 주황 + 안쪽 파란 심
function buildFlames() {
  const group = new THREE.Group();
  group.visible = false;
  // 밑면이 원점, 끝이 +z 1m. 정점 알파로 끝으로 갈수록 투명하게
  const cone = (r) => {
    const g = new THREE.ConeGeometry(r, 1, 14, 4, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const z = g.attributes.position;
    const rgba = new Float32Array(z.count * 4);
    for (let i = 0; i < z.count; i++) rgba.set([1, 1, 1, (1 - z.getZ(i)) ** 1.5], i * 4);
    g.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    return g;
  };
  // 바깥 불꽃은 일반 블렌딩(흰 차체 위에서도 색이 보이게), 심은 가산 블렌딩으로 빛나게
  const mat = (color, opacity, blending) =>
    new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, opacity, blending, depthWrite: false, side: THREE.DoubleSide });
  const outer = cone(0.15);
  const inner = cone(0.06);
  const outerMat = mat(0xff6a10, 0.9, THREE.NormalBlending);
  const innerMat = mat(0x4aa8ff, 0.8, THREE.AdditiveBlending);
  for (const x of [-0.42, 0.42]) {
    for (const [geo, m, len] of [[outer, outerMat, 1.8], [inner, innerMat, 0.7]]) {
      const f = new THREE.Mesh(geo, m);
      f.position.set(x, 0.34, 2.4);
      f.userData.len = len;
      f.renderOrder = geo === inner ? 3 : 2; // 심을 바깥 불꽃 위에
      group.add(f);
    }
  }
  return group;
}
