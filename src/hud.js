import { BOOST } from './car.js';
import { isTouch } from './touch.js';

const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

export class Hud {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      speed: $('speed'), course: $('course'), remain: $('remain'), zero100: $('zero100'), best: $('best'), vmax: $('vmax'), area: $('area'), start: $('start'), elev: $('elev'), lap: $('lap'), lapTime: $('lapTime'), bestLap: $('bestLap'),
    };
    this.powerBar = $('powerBar');
    this.regenBar = $('regenBar');
    this.boost = $('boost');
    this.boostBar = $('boostBar');
    this.prev = {};
  }

  set(key, text) {
    if (this.prev[key] === text) return;
    this.prev[key] = text;
    this.els[key].textContent = text;
  }

  message(text) {
    this.set('start', text);
    this.els.start.classList.toggle('hidden', !text);
  }

  // prompt: 출발 안내를 띄워도 되는 상태인지 (카운트다운 중엔 숨김)
  update(car, track, prompt = true) {
    this.set('speed', String(Math.round(car.v * 3.6)));
    this.set('course', car.courseTime === null ? '--' : fmtTime(car.courseTime));
    if (track.loop) {
      this.set('lap', `${car.lap} / ${car.laps}`);
      this.set('lapTime', car.courseTime === null ? '--' : fmtTime(car.courseTime - car.lapStart));
      this.set('bestLap', car.bestLap === null ? '--' : fmtTime(car.bestLap));
    } else {
      this.set('remain', `${(Math.max(0, car.finishS - car.distance) / 1000).toFixed(2)} km`);
    }
    const running = car.timer !== null;
    this.set('zero100', running ? `${car.timer.toFixed(2)} s` : car.last100 !== null ? `${car.last100.toFixed(2)} s` : '--');
    this.els.zero100.classList.toggle('running', running);
    this.set('best', car.best100 !== null ? `${car.best100.toFixed(2)} s` : '--');
    this.set('vmax', `${Math.round(car.topSpeed * 3.6)} km/h`);
    this.set('area', track.nameAt(car.distance) || '경로 위');
    const grade = car.pose.grade * 100;
    this.set('elev', `${Math.round(car.pose.y)} m · ${grade > 0.05 ? '+' : ''}${grade.toFixed(1)}%`);
    this.powerBar.style.transform = `scaleX(${Math.min(1, car.powerFrac).toFixed(3)})`;
    this.regenBar.style.transform = `scaleX(${Math.min(1, car.regenFrac * 3).toFixed(3)})`;
    this.boostBar.style.transform = `scaleX(${car.boostGauge.toFixed(3)})`;
    this.boost.classList.toggle('on', car.boosting);
    this.boost.classList.toggle('low', !car.boosting && (car.boostLock || car.boostGauge < BOOST.minStart));
    this.message(prompt && !car.finished && car.courseTime === null ? (isTouch ? '가속 버튼을 눌러 출발' : 'W 를 눌러 출발') : '');
  }
}

// 북쪽이 위인 경로 미니맵
export class Minimap {
  constructor(canvas, track) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.track = track;
    const every = 25;
    this.pts = [];
    for (let i = 0; i < track.n; i += every) this.pts.push([track.x[i], track.z[i], i * track.step]);
    if (track.loop) this.pts.push([track.x[0], track.z[0], track.length]);
    else this.pts.push([track.x[track.n - 1], track.z[track.n - 1], track.length]);
    let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of this.pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const pad = 12;
    const { width: w, height: h } = canvas;
    this.scale = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxZ - minZ));
    this.offX = (w - (maxX - minX) * this.scale) / 2 - minX * this.scale;
    this.offZ = (h - (maxZ - minZ) * this.scale) / 2 - minZ * this.scale;
  }

  map(x, z) {
    return [x * this.scale + this.offX, z * this.scale + this.offZ];
  }

  draw(car) {
    const { g, canvas } = this;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const path = (upTo) => {
      g.beginPath();
      this.pts.forEach(([x, z, s], k) => {
        if (s > upTo) return;
        const [px, pz] = this.map(x, z);
        if (k) g.lineTo(px, pz);
        else g.moveTo(px, pz);
      });
      g.stroke();
    };
    g.lineJoin = 'round';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    path(Infinity);
    g.strokeStyle = '#3e8bff';
    path(car.distance);

    const dot = (x, z, color, r) => {
      const [px, pz] = this.map(x, z);
      g.fillStyle = color;
      g.beginPath();
      g.arc(px, pz, r, 0, Math.PI * 2);
      g.fill();
    };
    const end = this.pts.at(-1);
    dot(end[0], end[1], '#ff4d4d', 4);
    dot(car.pose.x, car.pose.z, '#fff', 5);
    dot(car.pose.x, car.pose.z, '#3e8bff', 3);
  }
}
