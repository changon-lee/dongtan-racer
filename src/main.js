import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Input } from './input.js';
import { Car } from './car.js';
import { Track } from './track.js';
import { World } from './world.js';
import { Terrain } from './terrain.js';
import { Traffic } from './traffic.js';
import { ChaseCamera } from './camera.js';
import { Hud, Minimap } from './hud.js';
import { MotorAudio } from './audio.js';
import { Settings } from './settings.js';
import { UI } from './ui.js';
import { PAINTS } from './model3.js';
import { TRACKS } from './tracks.js';
import { setAnisotropy, skyTexture } from './textures.js';
import { enterFullscreen, isTouch, setupTouch } from './touch.js';

const STEP = 1 / 120; // 고정 물리 스텝
const HORIZON = 0xd3dfe6;
const SUN_OFFSET = new THREE.Vector3(-32, 80, 30);

// 해상도 배율: 휴대폰은 낮게 시작하고, 프레임이 느리면 자동으로 더 낮춘다
const MAX_RATIO = Math.min(devicePixelRatio, isTouch ? 1.5 : 2);
const MIN_RATIO = isTouch ? 0.75 : 1;
let pixelRatio = MAX_RATIO;

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);
setAnisotropy(renderer.capabilities.getMaxAnisotropy());

const scene = new THREE.Scene();
scene.background = skyTexture();
scene.fog = new THREE.Fog(HORIZON, 140, 980);

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

scene.add(new THREE.HemisphereLight(0xc4dcff, 0x6b6b5a, 1.3));
// 그림자는 차만 드리운다. 해와 그림자 카메라가 차를 따라다닌다.
const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(isTouch ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 200 });
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const hud = new Hud();
// 트랙은 처음에 모두 받아 둔다 (메인 화면 미리보기·통계용). 월드·지형·교통은 고른 트랙만 만든다
const tracks = Object.fromEntries(
  await Promise.all(TRACKS.map(async (info) => [info.id, await Track.load(`${import.meta.env.BASE_URL}${info.file}`)])),
);

// 지형 타일 바깥을 메우는 큰 평면 (가장 낮은 지면보다 아래, 차를 따라다님)
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
  new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(0.22, 0.3, 0.27) }),
);
scene.add(ground);
const input = new Input();
const releaseTouch = setupTouch(input);
const minimapCanvas = document.getElementById('minimap');
const chase = new ChaseCamera(innerWidth / innerHeight);
const audio = new MotorAudio();
let track = null;
let terrain = null;
let world = null;
let traffic = null;
let minimap = null;
let car = null;

// 트랙 교체: 이전 트랙의 청크·지형·교통을 치우고 새로 만든다
function mountTrack(id) {
  if (track?.id === id) return;
  world?.dispose();
  terrain?.dispose();
  traffic?.dispose();
  track = tracks[id];
  terrain = new Terrain(scene, track);
  world = new World(scene, track, terrain);
  traffic = new Traffic(scene, track);
  minimap = new Minimap(minimapCanvas, track);
  ground.position.y = terrain.minHeight - 2;
  if (car) car.setTrack(track);
  else {
    car = new Car(envMap, track);
    scene.add(car.root);
  }
  car.sync(0);
  terrain.prime(car.pose.x, car.pose.z);
  world.prime(car.distance);
  window.__game = { car, track, tracks, world, terrain, traffic, scene, renderer, camera: chase.camera };
}

function applySettings(values) {
  car.setOptions(values);
  car.setPaint(values.paint);
  // 서킷엔 일반 교통이 없다
  traffic.setLevel(track.loop ? 0 : values.traffic);
  audio.setMuted(!values.sound);
}

// 처음 생성 때도 onChange가 불려 저장된 트랙이 올라간다
const settings = new Settings((values) => {
  mountTrack(values.track);
  applySettings(values);
});

addEventListener('keydown', () => audio.start(), { once: true });
addEventListener('pointerdown', () => audio.start(), { once: true });
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  chase.resize(innerWidth / innerHeight);
});


// ---------- 게임 상태: menu → countdown → playing ⇄ paused → finished ----------

const COUNTDOWN = 3;
let state = 'menu';
let pausedFrom = 'playing';
let countdownT = 0;
let goT = 0;
let finishT = 0;

const ui = new UI(tracks, {
  selectTrack: (id) => {
    settings.set({ track: id });
    ui.setSelection(id, settings.values.laps);
  },
  selectLaps: (laps) => {
    settings.set({ laps });
    ui.setSelection(settings.values.track, laps);
  },
  start: () => begin(),
  restart: () => begin(),
  pause: () => pause(),
  resume: () => resume(),
  menu: () => toMenu(),
});

function setState(s) {
  state = s;
  document.body.dataset.state = s;
  audio.setPaused(s === 'paused');
  if (s !== 'playing' && s !== 'countdown') releaseTouch();
}

// 다른 앱·탭으로 넘어가면 자동 일시정지 (전화·알림으로 나갔다 와도 차가 혼자 달리고 있지 않게, 소리도 멈춤)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

// 출발선에서 카운트다운부터
function begin() {
  audio.start();
  enterFullscreen();
  ui.closeSheet();
  ui.show(null);
  car.restart();
  car.topSpeed = 0;
  countdownT = COUNTDOWN;
  acc = 0;
  setState('countdown');
}

function pause() {
  if (state !== 'playing' && state !== 'countdown') return;
  pausedFrom = state;
  setState('paused');
  ui.countdown('');
  ui.show('pause');
}

function resume() {
  ui.closeSheet();
  ui.show(null);
  acc = 0;
  setState(pausedFrom);
}

function toMenu() {
  ui.closeSheet();
  ui.countdown('');
  car.restart();
  car.topSpeed = 0;
  ui.show('menu');
  setState('menu');
}

function handleKeys() {
  const esc = input.consume('Escape');
  const enter = input.consume('Enter');
  const options = input.consume('KeyO');
  if (input.consume('KeyC')) settings.set({ paint: (settings.values.paint + 1) % PAINTS.length });
  if (input.consume('KeyM')) settings.set({ sound: !settings.values.sound });

  if (esc && ui.sheetOpen) return ui.closeSheet();
  switch (state) {
    case 'menu':
      if (enter && !ui.sheetOpen) begin();
      if (options) ui.sheetOpen ? ui.closeSheet() : ui.openSheet('options');
      break;
    case 'countdown':
    case 'playing':
      if (esc) pause();
      if (options) {
        pause();
        ui.openSheet('options');
      }
      if (state === 'playing' && input.consume('KeyR')) car.reset();
      break;
    case 'paused':
      if (options) ui.sheetOpen ? ui.closeSheet() : ui.openSheet('options');
      else if ((esc || enter) && !ui.sheetOpen) resume();
      break;
    case 'finished':
      if (finishT > 0) break; // 결과 화면이 뜨기 전
      if (enter) begin();
      if (esc) toMenu();
      break;
  }
}

function updateFlow(dt) {
  if (state === 'countdown') {
    countdownT -= dt;
    if (countdownT > 0) ui.countdown(String(Math.ceil(countdownT)));
    else {
      ui.countdown('GO');
      goT = 0.8;
      setState('playing');
    }
  }
  if (goT > 0 && (goT -= dt) <= 0) ui.countdown('');
  if (state === 'playing' && car.finished) {
    setState('finished');
    finishT = 1.4; // 결승선 통과 후 잠깐 달리는 모습을 보여주고 결과 화면
  }
  if (state === 'finished' && finishT > 0 && (finishT -= dt) <= 0) ui.showFinish(car);
}

let acc = 0;
let last = performance.now();

// 2초 평균 프레임 시간이 24ms(약 42fps)를 넘으면 해상도 배율을 한 단계 낮춘다 (올리지는 않음)
// 낮췄는데 빨라지지 않으면 해상도 탓이 아니다 (예: 아이폰 저전력 모드의 30fps 제한) → 되돌리고 그만 조절
const perf = { t: 0, n: 0, prevAvg: 0, prevRatio: 0, done: false };
function setRatio(r) {
  pixelRatio = r;
  renderer.setPixelRatio(r);
  renderer.setSize(innerWidth, innerHeight);
}
function adaptResolution(rawDt) {
  if (perf.done || state !== 'playing' || rawDt > 0.25) return; // 탭 전환 등으로 멈췄던 프레임은 제외
  perf.t += rawDt;
  perf.n++;
  if (perf.t < 2) return;
  const avg = perf.t / perf.n;
  perf.t = perf.n = 0;
  if (perf.prevRatio && avg > perf.prevAvg * 0.9) {
    setRatio(perf.prevRatio);
    perf.done = true;
    return;
  }
  perf.prevRatio = 0;
  if (avg > 0.024 && pixelRatio > MIN_RATIO) {
    perf.prevAvg = avg;
    perf.prevRatio = pixelRatio;
    setRatio(Math.max(MIN_RATIO, pixelRatio - 0.25));
  }
}

function frame(now) {
  const rawDt = (now - last) / 1000;
  const dt = Math.min(rawDt, 0.1);
  last = now;
  adaptResolution(rawDt);

  handleKeys();
  updateFlow(dt);

  const live = state !== 'paused';
  const driving = state === 'playing' || state === 'finished';
  if (live) {
    traffic.think(dt, car);
    acc += dt;
    while (acc >= STEP) {
      if (driving) car.update(STEP, input);
      traffic.step(STEP, car);
      acc -= STEP;
    }
  }
  for (const strength of traffic.events) audio.crash(strength);
  traffic.events.length = 0;

  car.sync(live ? dt : 0);
  traffic.sync();
  const p = car.pose;
  world.update(car.distance);
  terrain.update(p.x, p.z);
  sun.target.position.set(p.x, p.y, p.z);
  sun.position.copy(sun.target.position).add(SUN_OFFSET);
  ground.position.x = p.x;
  ground.position.z = p.z;
  if (state === 'menu') chase.orbit(dt, car);
  else if (live) chase.update(dt, car);
  if (state !== 'menu') {
    hud.update(car, track, state === 'playing');
    minimap.draw(car);
  }
  audio.update(car);
  input.endFrame();

  renderer.render(scene, chase.camera);
  requestAnimationFrame(frame);
}

ui.setSelection(settings.values.track, settings.values.laps);
ui.show('menu');
setState('menu');
requestAnimationFrame(frame);
