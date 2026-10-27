import { BOOST } from './car.js';
import { PAINTS } from './model3.js';
import { TRAFFIC_LEVELS } from './traffic.js';
import { LAP_CHOICES, TRACKS } from './tracks.js';

const STORAGE_KEY = 'dongtan-racer:settings';
export const DEFAULTS = { vmaxKmh: 262, accelMul: 1, chargeMul: 1, traffic: 2, paint: 0, sound: true, assist: true, track: 'route', laps: 3 };
const STOCK_VMAX = 262;

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function save(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // 저장 불가(시크릿 모드 등)여도 게임은 그대로 동작
  }
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitize(v) {
  return {
    vmaxKmh: clampNum(v.vmaxKmh, 262, 450, DEFAULTS.vmaxKmh),
    accelMul: clampNum(v.accelMul, 0.5, 2, DEFAULTS.accelMul),
    chargeMul: clampNum(v.chargeMul, 0.25, 4, DEFAULTS.chargeMul),
    traffic: Math.round(clampNum(v.traffic, 0, TRAFFIC_LEVELS.length - 1, DEFAULTS.traffic)),
    paint: Math.round(clampNum(v.paint, 0, PAINTS.length - 1, DEFAULTS.paint)),
    sound: typeof v.sound === 'boolean' ? v.sound : DEFAULTS.sound,
    assist: typeof v.assist === 'boolean' ? v.assist : DEFAULTS.assist,
    track: TRACKS.some((t) => t.id === v.track) ? v.track : DEFAULTS.track,
    laps: LAP_CHOICES.includes(v.laps) ? v.laps : DEFAULTS.laps,
  };
}

// 슬라이더 채움 비율 (CSS --fill)
function fill(input) {
  const { min, max, value } = input;
  input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
}

// 옵션 시트의 입력들. 값이 바뀔 때마다 onChange(values)를 부른다.
export class Settings {
  constructor(onChange) {
    const $ = (id) => document.getElementById(id);
    this.onChange = onChange;
    this.el = {
      vmax: $('vmaxInput'), vmaxVal: $('vmaxVal'), note: $('settingsNote'),
      accel: $('accelInput'), accelVal: $('accelVal'),
      charge: $('chargeInput'), chargeVal: $('chargeVal'),
      sound: $('soundInput'), assist: $('assistInput'), paintName: $('paintName'),
    };

    // 색상 견본
    const swatches = $('swatches');
    this.swatches = PAINTS.map(([name, hex], i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.title = name;
      b.setAttribute('aria-label', name);
      b.style.background = `#${hex.toString(16).padStart(6, '0')}`;
      b.addEventListener('click', () => this.set({ paint: i }));
      swatches.appendChild(b);
      return b;
    });

    // 교통량 버튼
    const seg = $('trafficSeg');
    this.trafficBtns = TRAFFIC_LEVELS.map((label, i) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => this.set({ traffic: i }));
      seg.appendChild(b);
      return b;
    });

    const { vmax, accel, charge, sound, assist } = this.el;
    vmax.addEventListener('input', () => this.set({ vmaxKmh: Number(vmax.value) }));
    accel.addEventListener('input', () => this.set({ accelMul: Number(accel.value) }));
    charge.addEventListener('input', () => this.set({ chargeMul: Number(charge.value) }));
    sound.addEventListener('change', () => this.set({ sound: sound.checked }));
    assist.addEventListener('change', () => this.set({ assist: assist.checked }));
    // 트랙·랩 수는 메인 화면에서 고르는 값이라 기본값 복원에서 제외
    $('settingsReset').addEventListener('click', () => this.set({ ...DEFAULTS, track: this.values.track, laps: this.values.laps }));

    this.values = sanitize(load());
    this.apply();
  }

  set(patch) {
    this.values = sanitize({ ...this.values, ...patch });
    this.apply();
  }

  apply() {
    const { vmaxKmh, accelMul, chargeMul, traffic, paint, sound, assist } = this.values;
    const e = this.el;
    e.vmax.value = vmaxKmh;
    e.accel.value = accelMul;
    e.charge.value = chargeMul;
    e.sound.checked = sound;
    e.assist.checked = assist;
    for (const input of [e.vmax, e.accel, e.charge]) fill(input);

    e.vmaxVal.textContent = vmaxKmh > STOCK_VMAX ? `${vmaxKmh} km/h · 리미터 해제` : `${vmaxKmh} km/h · 순정`;
    e.accelVal.textContent = `×${accelMul.toFixed(1)}`;
    e.chargeVal.textContent = `×${chargeMul.toFixed(2).replace(/0$/, '')} · ${+(BOOST.charge / chargeMul).toFixed(1)}초에 가득`;
    // 460kW 기준 공기저항 평형속도 ≈ 409km/h × 배율^(1/3) 근처라 그 이상은 못 낸다
    const reachable = Math.round(409 * Math.cbrt(accelMul));
    e.note.textContent = vmaxKmh > reachable ? `현재 가속력으로는 공기저항 때문에 약 ${reachable} km/h까지 납니다. 부스터를 쓰면 더 낼 수 있습니다.` : '';

    this.trafficBtns.forEach((b, i) => {
      b.classList.toggle('on', i === traffic);
      b.setAttribute('aria-checked', String(i === traffic));
    });
    this.swatches.forEach((b, i) => b.classList.toggle('on', i === paint));
    e.paintName.textContent = PAINTS[paint][0];

    save(this.values);
    this.onChange(this.values);
  }
}
