import { LAP_CHOICES, TRACKS } from './tracks.js';

// 메인 화면·일시정지·도착 화면·옵션 시트 전환. 게임 상태는 main.js가 갖고, 여기선 화면만 바꾼다.

const BEST_KEY = 'dongtan-racer:best'; // + `:${trackId}` (서킷은 랩 수별로)
const BEST_LAP_KEY = 'dongtan-racer:bestlap';

export const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

function read(key) {
  try {
    const v = Number(localStorage.getItem(key));
    return v > 0 ? v : null;
  } catch {
    return null;
  }
}

function write(key, v) {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    // 저장 불가여도 진행
  }
}

// 예전 버전(트랙 1개)에 저장된 기록을 도로 코스 기록으로 옮긴다
try {
  const old = localStorage.getItem(BEST_KEY);
  if (old && !localStorage.getItem(`${BEST_KEY}:route`)) localStorage.setItem(`${BEST_KEY}:route`, old);
  localStorage.removeItem(BEST_KEY);
} catch {
  // 무시
}

const bestKey = (track, laps) => (track.loop ? `${BEST_KEY}:${track.id}:${laps}` : `${BEST_KEY}:${track.id}`);

export class UI {
  // actions: { start, restart, pause, resume, menu, selectTrack(id), selectLaps(n) }
  constructor(tracks, actions) {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.tracks = tracks; // id → Track
    this.actions = actions;
    this.screens = { loading: $('loading'), menu: $('menu'), pause: $('pause'), finish: $('finish') };
    this.sheet = $('sheet');
    this.sheetTitle = $('sheetTitle');
    this.panes = { options: $('optionsPane'), controls: $('controlsPane') };
    this.countdownEl = $('countdown');

    $('startBtn').addEventListener('click', () => actions.start());
    $('pauseBtn').addEventListener('click', () => actions.pause());
    $('sheetClose').addEventListener('click', () => this.closeSheet());
    for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => this.openSheet(b.dataset.open));
    for (const b of document.querySelectorAll('[data-action]')) b.addEventListener('click', () => actions[b.dataset.action]());
    // 마우스로 누른 버튼에 포커스가 남으면 Space·Enter가 버튼을 다시 누른다
    addEventListener('click', (e) => e.target.closest?.('button')?.blur());

    // 트랙 카드
    this.cards = TRACKS.map((info) => {
      const t = tracks[info.id];
      const b = document.createElement('button');
      b.className = 'track-card';
      b.setAttribute('role', 'radio');
      b.innerHTML = `<span class="type">${info.type}</span><span class="name">${info.name}</span><span class="len">${(t.length / 1000).toFixed(t.loop ? 2 : 1)} km${t.loop ? ' · 1랩' : ''}</span>`;
      b.addEventListener('click', () => actions.selectTrack(info.id));
      $('trackList').appendChild(b);
      return b;
    });
    // 랩 수
    this.lapBtns = LAP_CHOICES.map((n) => {
      const b = document.createElement('button');
      b.textContent = `${n}랩`;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => actions.selectLaps(n));
      $('lapsSeg').appendChild(b);
      return b;
    });
  }

  // 메인 화면을 고른 트랙·랩 수에 맞춘다
  setSelection(id, laps) {
    const $ = this.$;
    const info = TRACKS.find((x) => x.id === id);
    const track = this.tracks[id];
    this.track = track;
    this.laps = laps;
    this.cards.forEach((b, k) => {
      const on = TRACKS[k].id === id;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    this.lapBtns.forEach((b, k) => {
      const on = LAP_CHOICES[k] === laps;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    $('lapsRow').classList.toggle('on', track.loop);
    $('menuSubtitle').textContent = info.desc;
    $('routeFrom').textContent = info.from;
    $('routeTo').textContent = info.to;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < track.n; i++) {
      minY = Math.min(minY, track.y[i]);
      maxY = Math.max(maxY, track.y[i]);
    }
    $('mDist').textContent = track.loop ? `${(track.length / 1000).toFixed(2)} km × ${laps}` : `${(track.length / 1000).toFixed(1)} km`;
    $('mElev').textContent = `${Math.round(minY)}–${Math.round(maxY)} m`;
    const best = read(bestKey(track, laps));
    $('mBest').textContent = best ? fmtTime(best) : '--';
    document.body.classList.toggle('circuit', track.loop);
    this.drawRoute($('routePreview'), track);
  }

  show(name) {
    for (const [k, el] of Object.entries(this.screens)) el.classList.toggle('show', k === name);
  }

  get sheetOpen() {
    return this.sheet.classList.contains('open');
  }

  openSheet(kind) {
    this.sheetTitle.textContent = kind === 'controls' ? '조작법' : '옵션';
    for (const [k, el] of Object.entries(this.panes)) el.classList.toggle('on', k === kind);
    this.sheet.classList.add('open');
    this.sheet.setAttribute('aria-hidden', 'false');
  }

  closeSheet() {
    if (!this.sheetOpen) return;
    this.sheet.classList.remove('open');
    this.sheet.setAttribute('aria-hidden', 'true');
  }

  // 도착 화면 채우기. 신기록이면 저장
  showFinish(car) {
    const $ = this.$;
    const track = car.track;
    const info = TRACKS.find((x) => x.id === track.id);
    const t = car.courseTime;
    const key = bestKey(track, car.laps);
    const prev = read(key);
    const record = prev === null || t < prev;
    if (record) write(key, t);
    $('fTitle').textContent = track.loop ? `Finish · ${info.name} · ${car.laps}랩` : `Finish · ${info.to}`;
    $('fTime').textContent = fmtTime(t);
    $('fBadge').classList.toggle('on', record);
    $('fBest').textContent = fmtTime(record ? t : prev);
    if (track.loop) {
      // 베스트 랩 (트랙별, 랩 수와 무관)
      const lapKey = `${BEST_LAP_KEY}:${track.id}`;
      const lap = car.bestLap;
      const prevLap = read(lapKey);
      if (lap && (prevLap === null || lap < prevLap)) write(lapKey, lap);
      $('fMidLabel').textContent = '베스트 랩';
      $('fAvg').textContent = lap ? fmtTime(lap) : '--';
    } else {
      $('fMidLabel').textContent = '평균 속도';
      $('fAvg').textContent = `${Math.round((car.travel / t) * 3.6)} km/h`;
    }
    $('fTop').textContent = `${Math.round(car.topSpeed * 3.6)} km/h`;
    this.setSelection(track.id, car.laps);
    this.show('finish');
  }

  countdown(text) {
    const el = this.countdownEl;
    if (el.textContent === text) return;
    el.textContent = text;
    el.classList.toggle('go', text === 'GO');
    el.classList.remove('pop');
    if (text) {
      void el.offsetWidth; // 애니메이션 재시작
      el.classList.add('pop');
    }
  }

  // 코스 모양 (북쪽 위)
  drawRoute(canvas, track) {
    const g = canvas.getContext('2d');
    const { width: w, height: h } = canvas;
    const pts = [];
    for (let i = 0; i < track.n; i += track.loop ? 4 : 20) pts.push([track.x[i], track.z[i]]);
    pts.push(track.loop ? pts[0] : [track.x[track.n - 1], track.z[track.n - 1]]);
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of pts) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const pad = 22;
    const k = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (z1 - z0));
    const ox = (w - (x1 - x0) * k) / 2;
    const oz = (h - (z1 - z0) * k) / 2;
    const P = ([x, z]) => [ox + (x - x0) * k, oz + (z - z0) * k];

    g.clearRect(0, 0, w, h);
    g.lineJoin = g.lineCap = 'round';
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#5b8cff');
    grad.addColorStop(1, track.loop ? '#8a6cff' : '#ff6b6b');
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(...P(p)) : g.moveTo(...P(p))));
    g.strokeStyle = 'rgba(91,140,255,0.25)';
    g.lineWidth = 12;
    g.stroke();
    g.strokeStyle = grad;
    g.lineWidth = 4;
    g.stroke();
    const dot = (p, color) => {
      const [x, y] = P(p);
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    };
    if (!track.loop) dot(pts.at(-1), '#ff5d5d');
    dot(pts[0], '#5b8cff');
  }
}
