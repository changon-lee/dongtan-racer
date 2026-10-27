// public/route.json(tools/build-route.mjs로 생성)을 읽어 트랙 질의를 제공한다.
// 좌표계: x = 동쪽, z = 남쪽(m). 트랙 중심선 = 내 진행 방향 차로들의 중앙.
// d(횡 오프셋)는 오른쪽이 +. heading(ry)은 three.js rotation.y 규약(왼쪽 회전이 +).

export const KIND = { EXPRESS: 0, URBAN: 1, LOCAL: 2, RAMP: 3, CIRCUIT: 4 };
export const START_S = 14; // 도로 코스: 차 뒤로도 도로가 보이도록 경로 시작에서 조금 들어간 곳
export const FINISH_MARGIN = 40; // 도로 코스: 경로 끝 40m 전이 결승선
const GRID_BEHIND = 12; // 서킷: 출발선 12m 뒤에서 출발
const GHOST = 160;
export const CURB_W = 1.2; // 서킷 연석 폭 // 순환 트랙 끝에 덧붙이는 샘플 수 (청크 1개 200m 이상)

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const HASH_CELL = 60;
const HASH_EVERY = 3;
const hashKey = (gx, gz) => gx * 100003 + gz;

function smooth(arr, half) {
  const out = new Float32Array(arr.length);
  let sum = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < arr.length; i++) {
    while (hi < Math.min(arr.length - 1, i + half)) sum += arr[++hi];
    while (lo < i - half) sum -= arr[lo++];
    out[i] = sum / (hi - lo + 1);
  }
  return out;
}

export class Track {
  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return new Track(await res.json());
  }

  constructor(data) {
    this.data = data;
    this.id = data.id ?? 'route';
    this.loop = !!data.loop; // 순환 서킷: 마지막 샘플 다음이 첫 샘플
    this.step = data.step;
    this.laneW = data.laneW;
    this.length = data.length;
    this.runoff = data.runoff ?? 0;
    this.bridgeRunoff = data.bridgeRunoff ?? this.runoff;
    this.n = data.x.length;
    const n = this.n;
    // 이웃 샘플: 순환이면 감싸고, 아니면 끝에서 멈춤
    const at = this.loop ? (i) => ((i % n) + n) % n : (i) => Math.min(n - 1, Math.max(0, i));
    this.x = Float64Array.from(data.x);
    this.z = Float64Array.from(data.z);
    this.w = Float32Array.from(data.w);
    this.lanes = Uint8Array.from(data.lanes);
    this.opp = Uint8Array.from(data.opp);
    this.med = Float32Array.from(data.med);
    this.kind = Uint8Array.from(data.kind);
    this.buildings = data.buildings;
    this.names = data.names;
    // 반대 차로 폭·분리대 폭은 정수 차선 수에서 계단처럼 바뀌므로 ±20m로 부드럽게
    this.oppW = smooth(Float32Array.from(data.opp, (v) => v * data.laneW), 10);
    this.medW = smooth(this.med, 10);

    // 고도·경사·다리
    this.y = data.y ? Float64Array.from(data.y) : new Float64Array(n);
    this.grade = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.loop ? i - 5 : Math.max(0, i - 5);
      const b = this.loop ? i + 5 : Math.min(n - 1, i + 5);
      this.grade[i] = (this.y[at(b)] - this.y[at(a)]) / ((b - a) * this.step);
    }
    this.bridge = new Uint8Array(n);
    for (const [s0, s1] of data.bridges ?? []) this.bridge.fill(1, Math.round(s0 / this.step), Math.round(s1 / this.step) + 1);
    this.dem = data.dem ?? null;

    // 최근접 샘플 검색용 격자 (6m 간격 샘플만 넣고 찾은 뒤 주변을 다듬는다)
    this.hash = new Map();
    for (let i = 0; i < n; i += HASH_EVERY) {
      const k = hashKey(Math.floor(this.x[i] / HASH_CELL), Math.floor(this.z[i] / HASH_CELL));
      if (!this.hash.has(k)) this.hash.set(k, []);
      this.hash.get(k).push(i);
    }

    // 접선·법선·헤딩·곡률
    this.tx = new Float64Array(n);
    this.tz = new Float64Array(n);
    this.ry = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = at(i - 1);
      const b = at(i + 1);
      const dx = this.x[b] - this.x[a];
      const dz = this.z[b] - this.z[a];
      const l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l;
      this.tz[i] = dz / l;
      this.ry[i] = Math.atan2(-this.tx[i], -this.tz[i]);
    }
    const k = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (!this.loop && (i === 0 || i === n - 1)) continue;
      k[i] = wrap(this.ry[at(i + 1)] - this.ry[at(i - 1)]) / (2 * this.step);
    }
    // 곡률 노이즈 완화
    this.kappa = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let c = 0;
      for (let j = i - 3; j <= i + 3; j++) {
        if (!this.loop && (j < 0 || j >= n)) continue;
        s += k[at(j)];
        c++;
      }
      this.kappa[i] = s / c;
    }

    // 순환이면 첫 샘플들을 끝에 복사해 둔다(고스트). i + 1 접근과 마지막 청크가 그대로 동작
    if (this.loop) {
      const extra = GHOST;
      for (const name of ['x', 'z', 'w', 'lanes', 'opp', 'med', 'kind', 'oppW', 'medW', 'y', 'grade', 'bridge', 'tx', 'tz', 'ry', 'kappa']) {
        const src = this[name];
        const dst = new src.constructor(n + extra);
        dst.set(src);
        for (let g = 0; g < extra; g++) dst[n + g] = src[g % n];
        this[name] = dst;
      }
    }
    // 출발·결승선 표시 위치, 차 출발 위치
    this.lines = this.loop ? [0] : [START_S + 4, this.length - FINISH_MARGIN];
    this.startS = this.loop ? this.length - GRID_BEHIND : START_S;
  }

  // 순환이면 s를 [0, length)로 감싼다. 반환 i는 [0, n), i + 1은 항상 유효(순환은 고스트)
  wrapS(s) {
    return this.loop ? ((s % this.length) + this.length) % this.length : s;
  }

  index(s) {
    const f = this.loop ? Math.min(this.wrapS(s) / this.step, this.n - 1e-6) : Math.min(Math.max(s / this.step, 0), this.n - 1.001);
    return [Math.floor(f), f - Math.floor(f)];
  }

  // s 지점 중심선에서 d만큼 오른쪽인 월드 좌표와 헤딩
  pose(s, d = 0, out = {}) {
    const [i, f] = this.index(s);
    const x = this.x[i] + (this.x[i + 1] - this.x[i]) * f;
    const z = this.z[i] + (this.z[i + 1] - this.z[i]) * f;
    const ry = this.ry[i] + wrap(this.ry[i + 1] - this.ry[i]) * f;
    // 오른쪽 법선 = (-tz, tx) = (cos ry, -sin ry)
    out.x = x + Math.cos(ry) * d;
    out.z = z - Math.sin(ry) * d;
    out.y = this.y[i] + (this.y[i + 1] - this.y[i]) * f;
    out.ry = ry;
    out.grade = this.grade[i] + (this.grade[i + 1] - this.grade[i]) * f;
    return out;
  }

  gradeAt(s) {
    const [i, f] = this.index(s);
    return this.grade[i] + (this.grade[i + 1] - this.grade[i]) * f;
  }

  // 월드 (x, z)에서 maxDist 안의 가장 가까운 트랙 샘플, 없으면 -1
  nearest(x, z, maxDist) {
    const gx = Math.floor(x / HASH_CELL);
    const gz = Math.floor(z / HASH_CELL);
    const r = Math.ceil(maxDist / HASH_CELL);
    let best = -1;
    let bestD = (maxDist + HASH_EVERY * this.step) ** 2;
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const list = this.hash.get(hashKey(gx + i, gz + j));
        if (!list) continue;
        for (const k of list) {
          const d = (this.x[k] - x) ** 2 + (this.z[k] - z) ** 2;
          if (d < bestD) [bestD, best] = [d, k];
        }
      }
    }
    if (best < 0) return -1;
    const lo = Math.max(0, best - HASH_EVERY);
    const hi = Math.min(this.n - 1, best + HASH_EVERY);
    for (let k = lo; k <= hi; k++) {
      const d = (this.x[k] - x) ** 2 + (this.z[k] - z) ** 2;
      if (d < bestD) [bestD, best] = [d, k];
    }
    return bestD <= maxDist * maxDist ? best : -1;
  }

  // 샘플 i 단면의 오른쪽·왼쪽 바깥 끝 (보도 포함, 중심선 기준 거리)
  extents(i) {
    if (this.kind[i] === KIND.CIRCUIT) {
      const e = this.w[i] / 2 + this.runoffAt(i) + 0.5;
      return [e, e];
    }
    const half = this.w[i] / 2;
    const sh = this.shoulder(i);
    const walk = this.kind[i] === KIND.URBAN || this.kind[i] === KIND.LOCAL ? 4 : 0.5;
    return [half + sh + walk, half + this.medW[i] + this.oppW[i] + sh + walk];
  }

  curvature(s) {
    const [i, f] = this.index(s);
    return this.kappa[i] + (this.kappa[i + 1] - this.kappa[i]) * f;
  }

  width(s) {
    const [i, f] = this.index(s);
    return this.w[i] + (this.w[i + 1] - this.w[i]) * f;
  }

  kindAt(s) {
    return this.kind[this.index(s)[0]];
  }

  // 포장된 갓길 폭 (오른쪽 끝, 반대 차로 바깥 끝 공통)
  shoulder(i) {
    const k = this.kind[i];
    return k === KIND.EXPRESS ? 3 : k === KIND.RAMP ? 1.5 : k === KIND.CIRCUIT ? 0 : 0.3;
  }

  // 서킷: 노면 끝 ~ 방호벽 거리 (다리 위는 좁음)
  runoffAt(i) {
    return this.bridge[i] ? this.bridgeRunoff : this.runoff;
  }

  // 서킷 런오프 재질: 커브 바깥은 자갈, 직선 옆은 잔디
  gravelAt(i) {
    return Math.abs(this.kappa[i]) > 1 / 300;
  }

  // 서킷 연석 바깥 런오프에 걸친 차폭 비율 0~1 (차 반폭 0.95)
  offTrack(s, d) {
    const [i] = this.index(s);
    if (this.kind[i] !== KIND.CIRCUIT) return 0;
    return Math.min(1, Math.max(0, (Math.abs(d) + 0.95 - this.w[i] / 2 - CURB_W) / 1.9));
  }

  // 차가 갈 수 있는 횡 범위 (차 반폭 0.95 반영)
  // 왼쪽: 분리대가 있으면 그 면까지, 없으면 반대 차로 끝까지(마주 오는 차가 없으니). 오른쪽: 갓길·연석까지
  bounds(s) {
    const [i] = this.index(s);
    if (this.kind[i] === KIND.CIRCUIT) {
      const e = this.w[i] / 2 + this.runoffAt(i) - 0.3 - 0.95; // 방호벽 두께 0.3
      return [-e, e];
    }
    const half = this.width(s) / 2;
    const med = this.medW[i];
    const sh = this.shoulder(i);
    let left;
    if (med > 0.3) left = this.kind[i] === KIND.EXPRESS ? -half - med / 2 + 0.3 : -half - 0.1;
    else left = -half - this.oppW[i] - sh;
    return [left + 0.95, half + sh - 0.95];
  }

  nameAt(s) {
    const names = this.names;
    let lo = 0;
    let hi = names.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (names[mid][0] <= s) lo = mid;
      else hi = mid - 1;
    }
    return names[lo][1];
  }
}
