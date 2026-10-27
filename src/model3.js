import * as THREE from 'three';

// Tesla Model 3 Highland (2024~) Performance.
// 차체는 길이 방향(u: 앞 끝 0 → 뒤 끝 4.72m) 단면을 이어 붙인 로프트 곡면이다.
// 단면 = 측면 형상(높이별 폭) + 위아래 라운드 모서리, 앞뒤 끝은 초타원으로 오므린다.

const LEN = 4.72;
const HALF = LEN / 2;
const U_F = 0.3; // 앞 끝 라운드가 시작되는 u
const U_R = 4.58; // 뒤 끝 라운드가 시작되는 u
export const WHEEL_R = 0.335; // 235/35R20
const FRONT_AXLE = 0.84;
const REAR_AXLE = FRONT_AXLE + 2.875;
const ARCH_R = 0.395;
const TRACK = 1.58;

export const PAINTS = [
  ['Pearl White', 0xeceae4, 0.05, 0.28],
  ['Stealth Grey', 0x3a3d42, 0.55, 0.32],
  ['Ultra Red', 0x9a0d18, 0.45, 0.3],
  ['Deep Blue', 0x1b3566, 0.6, 0.3],
  ['Quicksilver', 0x9da2a7, 0.75, 0.26],
  ['Diamond Black', 0x0b0b0d, 0.5, 0.3],
];

const clamp = THREE.MathUtils.clamp;
const clamp01 = (v) => clamp(v, 0, 1);
const se = (t, p) => Math.pow(1 - Math.pow(clamp01(t), p), 1 / p); // 초타원 오므림

// 단조 3차 보간 (오버슈트 없이 키 사이를 매끄럽게)
function pchip(keys) {
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const n = xs.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 / (1 / d[i - 1] + 1 / d[i]);
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// 측면도: 후드·벨트라인·트렁크 높이
const topAt = pchip([
  [0.3, 0.655], [0.6, 0.74], [1.0, 0.835], [1.22, 0.91], [1.6, 0.945],
  [2.5, 0.97], [3.4, 0.995], [3.95, 1.02], [4.3, 1.035], [4.58, 1.03],
]);
const botAt = pchip([[0.3, 0.2], [0.6, 0.17], [4.15, 0.17], [4.4, 0.24], [4.58, 0.3]]);
// 평면도: 반폭
const widthAt = pchip([[0.3, 0.86], [0.6, 0.9], [1.0, 0.925], [3.8, 0.925], [4.2, 0.912], [4.58, 0.88]]);
// 글래스 루프 높이 (윈드실드 밑단 → 루프 → 리어글라스 끝)
const roofAt = pchip([
  [1.22, 0.925], [1.45, 1.06], [1.75, 1.23], [2.05, 1.37], [2.35, 1.43],
  [2.65, 1.441], [2.95, 1.42], [3.25, 1.33], [3.55, 1.2], [3.8, 1.1], [3.98, 1.04],
]);

// 높이별 폭 비율: 아래는 로커 쪽으로, 위는 숄더에서 안쪽으로 말린다
const sideAt = (y) => 1 - 0.07 * clamp01((0.42 - y) / 0.25) ** 2 - 0.08 * clamp01((y - 0.72) / 0.3) ** 2;

function archBottom(u, base) {
  for (const c of [FRONT_AXLE, REAR_AXLE]) {
    const d = u - c;
    if (Math.abs(d) < ARCH_R) base = Math.max(base, WHEEL_R + Math.sqrt(ARCH_R * ARCH_R - d * d));
  }
  return base;
}

const NB = 5;
const NC = 4;
const NS = 20;
const NC2 = 10;
const NT = 9;

// 단면 링: 오른쪽 윤곽(밑 중앙 → 옆면 → 윗 중앙)을 만들고 좌우 대칭으로 닫는다. 점 개수는 항상 같다.
function contour(bot, top, xAt, rb, rt, crown) {
  const pts = [];
  const xb = xAt(bot + rb);
  const xt = xAt(top - rt);
  for (let k = 0; k < NB; k++) pts.push([((xb - rb) * k) / NB, bot]);
  for (let k = 0; k < NC; k++) {
    const a = -Math.PI / 2 + ((Math.PI / 2) * k) / NC;
    pts.push([xb - rb + rb * Math.cos(a), bot + rb + rb * Math.sin(a)]);
  }
  for (let k = 0; k < NS; k++) {
    const y = bot + rb + ((top - rt - bot - rb) * k) / NS;
    pts.push([xAt(y), y]);
  }
  for (let k = 0; k < NC2; k++) {
    const a = ((Math.PI / 2) * k) / NC2;
    pts.push([xt - rt + rt * Math.cos(a), top - rt + rt * Math.sin(a)]);
  }
  const x0 = Math.max(xt - rt, 1e-4);
  for (let k = 0; k <= NT; k++) {
    const x = x0 * (1 - k / NT);
    pts.push([x, top + crown * (1 - (x / x0) ** 2)]);
  }
  const left = pts.slice(1, -1).reverse().map(([x, y]) => [-x, y]);
  return pts.concat(left);
}

function bodyRing(u) {
  const uc = clamp(u, U_F, U_R);
  const W = widthAt(uc);
  const top = topAt(uc);
  const bot = archBottom(uc, botAt(uc));
  const H = top - bot;
  const ring = contour(bot, top, (y) => W * sideAt(y), Math.min(0.06, H * 0.3), Math.min(0.13, H * 0.42), 0.012);
  let cy;
  let fx;
  let fy;
  if (u < U_F) {
    const t = (U_F - u) / U_F;
    [cy, fx, fy] = [0.45, se(t, 1.9), se(t, 2.2)];
  } else if (u > U_R) {
    const t = (u - U_R) / (LEN - U_R);
    [cy, fx, fy] = [0.66, se(t, 2.6), se(t, 3.2)];
  } else {
    return ring;
  }
  return ring.map(([x, y]) => [x * fx, cy + (y - cy) * fy]);
}

function glassRing(u) {
  const bot = topAt(u) - 0.03;
  const H = Math.max(roofAt(u) - bot, 0.002);
  const crown = Math.min(0.03, H * 0.3);
  const top = bot + H - crown;
  const wb = widthAt(u) * sideAt(bot) - 0.1;
  const wt = Math.min(wb - 0.02, 0.62);
  const rt = Math.min(0.2, (top - bot) * 0.5, wt * 0.5);
  const span = Math.max(top - rt - bot, 1e-4);
  return contour(bot, top, (y) => wb + (wt - wb) * clamp01((y - bot) / span), Math.min(0.005, H * 0.2), rt, crown);
}

// 램프·트림 영역은 면 단위가 아니라 프래그먼트 단위로 판정해야 경계가 계단처럼 깨지지 않는다.
// 차체 로컬 좌표(u = z + HALF)로 영역을 정하고 페인트 재질 위에 덮어쓴다.
const BODY_PARTS_GLSL = /* glsl */ `
  float pu = vBodyPos.z + ${HALF.toFixed(2)};
  float ax = abs(vBodyPos.x);
  float py = vBodyPos.y;
  int part = 0;
  // 슬림 헤드램프: 앞 코너에서 펜더 위로 쓸어 올라간다. 윗변이 DRL
  if (pu < 0.45 && ax > 0.36 + pu * 0.9) {
    float lo = 0.58 + pu * 0.2;
    float hi = lo + 0.065 + pu * 0.02;
    if (py > lo && py < hi) part = py > hi - 0.016 ? 3 : 2;
  }
  // 퍼포먼스 프런트: 코너 에어커튼, 하단 흡기구, 립
  if (part == 0 && pu < 0.4) {
    if (pu < 0.32 && ax > 0.62 && ax < 0.8 && py > 0.26 && py < 0.38 + (ax - 0.62) * 0.35) part = 1;
    else if (ax < 0.52 && py > 0.235 && py < 0.31) part = 1;
    else if (py < 0.215) part = 1;
  }
  // C자 테일램프: 위·아래 가로획 + 안쪽 세로획이 점등부
  if (part == 0 && pu > 4.28 && ax > 0.36) {
    float lo = 0.86 + max(0.0, 4.58 - pu) * 0.22;
    float hi = 0.975;
    if (py > lo && py < hi) {
      bool lit = py > hi - 0.02 || py < lo + 0.02 || (pu > 4.62 && ax < 0.405);
      part = lit ? 5 : 4;
    }
  }
  if (part == 0 && pu > 4.48 && py < 0.4) part = 1; // 디퓨저

  if (part == 1) { diffuseColor.rgb = vec3(0.012); roughnessFactor = 0.35; metalnessFactor = 0.3; }
  else if (part == 2) { diffuseColor.rgb = vec3(0.02, 0.022, 0.025); roughnessFactor = 0.08; metalnessFactor = 0.6; }
  else if (part == 3) { diffuseColor.rgb = vec3(1.0); totalEmissiveRadiance = vec3(0.95, 0.97, 1.0) * 2.4; }
  else if (part == 4) { diffuseColor.rgb = vec3(0.035, 0.002, 0.004); roughnessFactor = 0.08; metalnessFactor = 0.3; totalEmissiveRadiance = vec3(0.04, 0.0, 0.002); }
  else if (part == 5) { diffuseColor.rgb = vec3(0.2, 0.0, 0.0); totalEmissiveRadiance = vec3(1.0, 0.1, 0.1) * uTail; }
`;

function applyBodyParts(material, uTail) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTail = uTail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBodyPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBodyPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBodyPos;\nuniform float uTail;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${BODY_PARTS_GLSL}`);
  };
  material.customProgramCacheKey = () => 'model3-body';
}

function loft(stations, ringAt) {
  const rings = stations.map(ringAt);
  const R = rings[0].length;
  const S = stations.length;
  const pos = new Float32Array(S * R * 3);
  rings.forEach((ring, i) => {
    ring.forEach(([x, y], j) => pos.set([x, y, stations[i] - HALF], (i * R + j) * 3));
  });
  const index = [];
  for (let i = 0; i < S - 1; i++) {
    for (let j = 0; j < R; j++) {
      const a = i * R + j;
      const b = i * R + ((j + 1) % R);
      const c = (i + 1) * R + ((j + 1) % R);
      const d = (i + 1) * R + j;
      index.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function stationsFor(u0, u1, step, roundStart, roundEnd) {
  const st = [];
  if (roundStart) for (let i = 0; i < 20; i++) st.push(U_F * (1 - Math.cos(((i / 20) * Math.PI) / 2)));
  for (let u = u0; u < u1 - 1e-6; u += step) st.push(u);
  if (roundEnd) for (let i = 0; i <= 16; i++) st.push(U_R + (LEN - U_R) * Math.sin(((i / 16) * Math.PI) / 2));
  else st.push(u1);
  return st;
}

function badgeTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#d9dadc';
  g.font = 'bold 44px "Segoe UI", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.letterSpacing = '28px';
  g.fillText('TESLA', 256 + 14, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildModel3(car, envMap) {
  const [, color, metalness, roughness] = PAINTS[0];
  const paint = new THREE.MeshPhysicalMaterial({
    color, metalness, roughness, clearcoat: 1, clearcoatRoughness: 0.05, envMap, envMapIntensity: 1,
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x07090c, metalness: 0.3, roughness: 0.04, envMap, envMapIntensity: 1.4 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.35, metalness: 0.3, envMap, envMapIntensity: 0.6 });
  const uTail = { value: 1.4 };
  applyBodyParts(paint, uTail);
  const tireM = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
  const rimM = new THREE.MeshStandardMaterial({ color: 0x34373c, metalness: 0.85, roughness: 0.3, envMap });
  const barrelM = new THREE.MeshStandardMaterial({ color: 0x090909, roughness: 0.8 });
  const rotorM = new THREE.MeshStandardMaterial({ color: 0x6b6e73, metalness: 0.8, roughness: 0.45, envMap });
  const caliperM = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.4 });
  car.paint = paint;
  car.setBrakeLights = (on) => {
    uTail.value = on ? 5 : 1.4;
  };

  const shell = new THREE.Group();
  car.body.position.y = 0.5;
  shell.position.y = -0.5;
  car.body.add(shell);

  const add = (geo, mat, x, y, z, parent = shell) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  add(loft(stationsFor(U_F, U_R, 0.02, true, true), bodyRing), paint, 0, 0, 0);
  add(loft(stationsFor(1.22, 3.98, 0.02, false, false), glassRing), glass, 0, 0, 0);

  // 휠하우스 안쪽 라이너 (아치 사이로 반대편이 비치지 않게). 후드·범퍼 밖으로 나오지 않는 범위
  add(new THREE.BoxGeometry(1.3, 0.44, 4.15 - 0.42), barrelM, 0, 0.41, (0.42 + 4.15) / 2 - HALF);

  // 카본 립 스포일러
  add(new THREE.BoxGeometry(1.2, 0.022, 0.1), trim, 0, 1.047, 4.55 - HALF);
  // 디퓨저 핀
  for (const x of [-0.42, -0.15, 0.15, 0.42]) add(new THREE.BoxGeometry(0.018, 0.07, 0.16), trim, x, 0.345, 4.66 - HALF);

  // 사이드미러 (도어 장착형)
  const mirrorG = new THREE.SphereGeometry(1, 16, 10).scale(0.09, 0.05, 0.07);
  for (const s of [-1, 1]) {
    add(mirrorG, paint, s * 0.97, 0.99, 1.47 - HALF);
    add(new THREE.BoxGeometry(0.12, 0.035, 0.05), paint, s * 0.87, 0.97, 1.47 - HALF);
  }

  // 트렁크 TESLA 레터링 (외부 배포 시엔 상표라 빼는 게 안전)
  const badge = new THREE.Mesh(
    new THREE.PlaneGeometry(0.46, 0.058),
    new THREE.MeshStandardMaterial({ map: badgeTexture(), transparent: true, metalness: 0.6, roughness: 0.3, envMap }),
  );
  badge.position.set(0, 0.88, HALF + 0.004);
  shell.add(badge);

  // 20" 휠: 토러스 타이어 + 10스포크(5쌍) + 빨간 캘리퍼
  const tireG = new THREE.TorusGeometry(0.2945, 0.0405, 10, 32).rotateY(Math.PI / 2).scale(2.9, 1, 1);
  const lipG = new THREE.TorusGeometry(0.252, 0.011, 6, 32).rotateY(Math.PI / 2);
  const barrelG = new THREE.CylinderGeometry(0.25, 0.25, 0.02, 24).rotateZ(Math.PI / 2);
  const rotorG = new THREE.CylinderGeometry(0.178, 0.178, 0.03, 24).rotateZ(Math.PI / 2);
  const spokeG = new THREE.BoxGeometry(0.022, 0.2, 0.032);
  const hubG = new THREE.CylinderGeometry(0.06, 0.06, 0.04, 16).rotateZ(Math.PI / 2);
  const caliperG = new THREE.BoxGeometry(0.06, 0.15, 0.22);

  for (const [u, front] of [[FRONT_AXLE, true], [REAR_AXLE, false]]) {
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set((s * TRACK) / 2, WHEEL_R, u - HALF);
      car.root.add(pivot);
      const spin = new THREE.Group();
      pivot.add(spin);
      add(tireG, tireM, 0, 0, 0, spin);
      add(lipG, rimM, s * 0.09, 0, 0, spin);
      add(barrelG, barrelM, -s * 0.05, 0, 0, spin);
      add(hubG, rimM, s * 0.075, 0, 0, spin);
      for (let i = 0; i < 5; i++) {
        for (const off of [-0.17, 0.17]) {
          const a = (i * Math.PI * 2) / 5 + off;
          const spoke = add(spokeG, rimM, s * 0.07, Math.cos(a) * 0.155, Math.sin(a) * 0.155, spin);
          spoke.rotation.x = a + off * 0.6; // 살짝 비튼 트위스트
        }
      }
      add(rotorG, rotorM, 0, 0, 0, pivot);
      add(caliperG, caliperM, s * 0.035, 0.11, front ? 0.1 : -0.1, pivot);
      car.wheels.push({ pivot, spin, front });
    }
  }
}
