import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 부스터 이펙트: 디퓨저 양쪽에서 뒤(+z)로 뿜는 푸른 플라즈마.
// 드로우콜 4개: 바깥 제트(일반 블렌딩, 밝은 하늘에서도 보이게) · 코어(가산, 빛나게) · 불꽃 입자+노즐 글로우(Points 1개) · 점화 링
// 지오메트리·머티리얼은 모듈에서 한 번만 만든다 (차는 하나뿐이고 계속 재사용)

// car.body 기준 좌표 (body가 지면 위 0.5m라 디퓨저 높이 0.345m → -0.155)
const NOZZLES = [-0.42, 0.42].map((x) => new THREE.Vector3(x, -0.16, 2.38));
const ROAD_Y = -0.47; // 노면 바로 위
const SPARKS = 56;
const HALOS = NOZZLES.length;

// 노즐에서 살짝 부풀었다가 끝으로 가늘어지는 회전체 (축 +z, 길이 1)
function jetGeometry(r0, segments) {
  const pts = [];
  for (let k = 0; k <= segments; k++) {
    const t = k / segments;
    const r = r0 * (1 + 0.35 * Math.sin(Math.min(1, t / 0.18) * Math.PI * 0.5)) * Math.pow(1 - t, 0.9) + 0.004;
    pts.push(new THREE.Vector2(r, t));
  }
  const one = new THREE.LatheGeometry(pts, 18).rotateX(Math.PI / 2); // y(0→1) → z(0→1)
  const geos = NOZZLES.map((p) => one.clone().translate(p.x, p.y, 0));
  one.dispose();
  const g = mergeGeometries(geos);
  for (const x of geos) x.dispose();
  return g;
}

const JET_VERT = /* glsl */ `
  uniform float uLen;
  uniform float uNozzleZ;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.z = uNozzleZ + p.z * uLen;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

// t: 노즐 0 → 끝 1. 가운데(정면)일수록 진하고 테두리는 부드럽게 사라짐.
// 쇼크 다이아몬드(제자리 밝은 마디) + 뒤로 흐르는 결
const JET_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uPower;
  uniform vec3 uNear;
  uniform vec3 uMid;
  uniform vec3 uFar;
  uniform float uEdge;
  uniform float uDiamond;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    float t = vUv.y;
    float a = vUv.x * 6.2831853;
    float facing = abs(dot(normalize(vN), normalize(vV)));
    float body = pow(facing, uEdge);
    float diamonds = pow(0.5 + 0.5 * cos(t * 34.0 - uTime * 3.0), 3.0) * (1.0 - t);
    float flow = 0.5 + 0.5 * sin(t * 22.0 - uTime * 46.0 + sin(a * 3.0 + uTime * 7.0) * 1.6);
    float fade = pow(1.0 - t, 1.6) * smoothstep(0.0, 0.05, t + 0.02);
    float k = fade * body * (0.72 + uDiamond * diamonds + 0.22 * flow);
    vec3 col = mix(uNear, uMid, smoothstep(0.0, 0.35, t));
    col = mix(col, uFar, smoothstep(0.35, 0.95, t));
    gl_FragColor = vec4(col, clamp(k * uPower, 0.0, 1.0));
  }
`;

function jetMaterial(opts) {
  return new THREE.ShaderMaterial({
    vertexShader: JET_VERT,
    fragmentShader: JET_FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0 },
      uLen: { value: 1 },
      uNozzleZ: { value: NOZZLES[0].z },
      uNear: { value: new THREE.Color(opts.near) },
      uMid: { value: new THREE.Color(opts.mid) },
      uFar: { value: new THREE.Color(opts.far) },
      uEdge: { value: opts.edge },
      uDiamond: { value: opts.diamond },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: opts.blending,
  });
}

// 불꽃 입자 + 노즐 글로우. 크기는 m 단위 → 화면 높이·FOV로 픽셀 환산
const POINT_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute float aHot;
  uniform float uScale;
  varying float vAlpha;
  varying float vHot;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uScale / max(0.1, -mv.z);
    vAlpha = aAlpha;
    vHot = aHot;
    gl_Position = projectionMatrix * mv;
  }
`;
const POINT_FRAG = /* glsl */ `
  varying float vAlpha;
  varying float vHot;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float soft = pow(1.0 - d, 1.0 + vHot * 1.5);
    vec3 col = mix(vec3(0.33, 0.62, 1.0), vec3(0.86, 0.97, 1.0), clamp(soft * 1.4 * vHot + (1.0 - vHot) * soft * 0.6, 0.0, 1.0));
    gl_FragColor = vec4(col, soft * vAlpha);
  }
`;

// 점화 순간 노즐에서 뒤로 퍼지는 얇은 링
const RING_VERT = /* glsl */ `
  uniform float uP;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.z += uP * 0.9;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;
const RING_FRAG = /* glsl */ `
  uniform float uP;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float R = mix(0.12, 0.95, sqrt(uP));
    float w = mix(0.05, 0.16, uP);
    float ring = smoothstep(w, 0.0, abs(r - R));
    gl_FragColor = vec4(mix(vec3(0.85, 0.97, 1.0), vec3(0.45, 0.6, 1.0), uP), ring * (1.0 - uP) * 0.9);
  }
`;

// 노면에 비치는 푸른 빛 (차 뒤 타원형)
const GLOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const GLOW_FRAG = /* glsl */ `
  uniform float uPower;
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vec2 q = (vUv - vec2(0.5, 0.78)) * vec2(2.0, 1.25);
    float d = length(q);
    float a = pow(max(0.0, 1.0 - d), 2.2) * (0.9 + 0.1 * sin(uTime * 37.0));
    gl_FragColor = vec4(0.32, 0.72, 1.0, a * 0.5 * uPower);
  }
`;

const shared = {};
function assets() {
  if (shared.outerG) return shared;
  shared.outerG = jetGeometry(0.1, 24);
  shared.coreG = jetGeometry(0.042, 16);
  shared.outerM = jetMaterial({ near: 0xbff4ff, mid: 0x3fb6ff, far: 0x6a4dff, edge: 1.3, diamond: 0.35, blending: THREE.NormalBlending });
  shared.coreM = jetMaterial({ near: 0xffffff, mid: 0xb8f0ff, far: 0x4f8dff, edge: 0.8, diamond: 0.9, blending: THREE.AdditiveBlending });
  shared.pointM = new THREE.ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: { uScale: { value: 500 } },
    transparent: true,
    depthWrite: false,
  });
  shared.ringG = mergeGeometries(NOZZLES.map((p) => new THREE.PlaneGeometry(0.62, 0.62).translate(p.x, p.y, p.z + 0.04)));
  shared.ringM = new THREE.ShaderMaterial({
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    uniforms: { uP: { value: 1 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // 차 뒤 범퍼 아래부터 3m (PlaneGeometry는 xy 평면 → 눕혀서 xz)
  shared.glowG = new THREE.PlaneGeometry(2.3, 3.2).rotateX(-Math.PI / 2).translate(0, ROAD_Y, 2.1 + 1.6);
  shared.glowM = new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: { uPower: { value: 0 }, uTime: { value: 0 } },
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  return shared;
}

const OUTER_LEN = 2.1;
const CORE_LEN = 1.15;
const RING_TIME = 0.32; // s

export class BoostFx {
  constructor() {
    const A = assets();
    this.group = new THREE.Group();
    this.group.visible = false;
    this.outer = new THREE.Mesh(A.outerG, A.outerM);
    this.core = new THREE.Mesh(A.coreG, A.coreM);
    this.outer.renderOrder = 2;
    this.core.renderOrder = 3;

    // 입자: 앞 HALOS개는 노즐 글로우(고정), 나머지는 불꽃
    const n = HALOS + SPARKS;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    const hot = new Float32Array(n).fill(1);
    NOZZLES.forEach((p, i) => {
      this.pos.set([p.x, p.y, p.z + 0.06], i * 3);
      hot[i] = 0;
    });
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aHot', new THREE.BufferAttribute(hot, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, NOZZLES[0].y, 3.4), 3);
    this.points = new THREE.Points(g, A.pointM);
    this.points.renderOrder = 4;
    // 픽셀 크기 = m × 화면 높이 / (2·tan(fov/2))
    const buf = new THREE.Vector2();
    this.points.onBeforeRender = (renderer, scene, camera) => {
      renderer.getDrawingBufferSize(buf);
      A.pointM.uniforms.uScale.value = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov ?? 60) / 2));
    };

    this.ring = new THREE.Mesh(A.ringG, A.ringM);
    this.ring.renderOrder = 5;
    this.glow = new THREE.Mesh(A.glowG, A.glowM);
    this.glow.renderOrder = 1;
    this.group.add(this.glow, this.outer, this.core, this.points, this.ring);

    // 불꽃 상태 (차 기준 좌표, 뒤로 흘러가며 사라짐)
    this.life = new Float32Array(SPARKS);
    this.maxLife = new Float32Array(SPARKS);
    this.vel = new Float32Array(SPARKS * 3);
    this.next = 0;
    this.spawnAcc = 0;
    this.vis = 0;
    this.time = 0;
    this.burst = 0; // 점화 직후 1 → 0
    this.ringP = 1;
    this.was = false;
    this.warm = 2; // 처음 몇 프레임은 투명하게 그려 셰이더를 미리 컴파일 (첫 부스터 때 끊김 방지)
  }

  spawn(count) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % SPARKS;
      const p = NOZZLES[i & 1];
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.05;
      const j = (HALOS + i) * 3;
      this.pos[j] = p.x + Math.cos(a) * r;
      this.pos[j + 1] = p.y + Math.sin(a) * r;
      this.pos[j + 2] = p.z + 0.05 + Math.random() * 0.25;
      const spread = 0.35 + Math.random() * 0.6;
      this.vel[i * 3] = Math.cos(a) * spread;
      this.vel[i * 3 + 1] = Math.sin(a) * spread + 0.15;
      this.vel[i * 3 + 2] = 7 + Math.random() * 9;
      this.maxLife[i] = this.life[i] = 0.14 + Math.random() * 0.22;
      this.size[HALOS + i] = 0.035 + Math.random() * 0.045;
    }
  }

  update(dt, boosting) {
    if (this.warm > 0) {
      this.warm--;
      this.group.visible = true;
      for (const o of this.group.children) o.visible = true;
      return;
    }
    this.time += dt;
    if (boosting && !this.was) {
      this.burst = 1;
      this.ringP = 0;
      this.spawn(18);
    }
    this.was = boosting;
    this.vis += ((boosting ? 1 : 0) - this.vis) * (1 - Math.exp(-(boosting ? 18 : 9) * dt));
    this.burst = Math.max(0, this.burst - dt / 0.35);
    this.ringP = Math.min(1, this.ringP + dt / RING_TIME);

    // 불꽃 방출·이동
    let alive = 0;
    if (boosting) {
      this.spawnAcc += dt * 150;
      const n = Math.floor(this.spawnAcc);
      this.spawnAcc -= n;
      if (n) this.spawn(n);
    }
    for (let i = 0; i < SPARKS; i++) {
      const a = HALOS + i;
      if (this.life[i] <= 0) {
        this.alpha[a] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const j = a * 3;
      this.pos[j] += this.vel[i * 3] * dt;
      this.pos[j + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[j + 2] += this.vel[i * 3 + 2] * dt;
      const k = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[a] = k * k * 0.95;
    }

    const on = this.vis > 0.01;
    this.group.visible = on || alive > 0 || this.ringP < 1;
    if (!this.group.visible) return;

    const A = shared;
    // 켜질 때 쭉 뻗었다가(burst) 제 길이로, 끌 때는 짧아지며 사라짐
    const len = this.vis * (1 + 0.45 * this.burst);
    const breathe = 1 + 0.03 * Math.sin(this.time * 31) + 0.02 * Math.sin(this.time * 53);
    A.outerM.uniforms.uLen.value = Math.max(0.001, OUTER_LEN * len * breathe);
    A.coreM.uniforms.uLen.value = Math.max(0.001, CORE_LEN * len * breathe);
    A.outerM.uniforms.uPower.value = this.vis * (0.95 + 0.5 * this.burst);
    A.coreM.uniforms.uPower.value = this.vis * (1.1 + 0.8 * this.burst);
    A.outerM.uniforms.uTime.value = this.time;
    A.coreM.uniforms.uTime.value = this.time;
    this.outer.visible = this.core.visible = this.glow.visible = on;
    A.glowM.uniforms.uPower.value = this.vis * (1 + 0.6 * this.burst);
    A.glowM.uniforms.uTime.value = this.time;
    A.ringM.uniforms.uP.value = this.ringP;
    this.ring.visible = this.ringP < 1;

    for (let i = 0; i < HALOS; i++) {
      this.size[i] = 0.42 * (0.85 + 0.15 * Math.sin(this.time * 23 + i)) * (1 + 0.6 * this.burst);
      this.alpha[i] = 0.55 * this.vis;
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
  }
}
