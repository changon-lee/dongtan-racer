import * as THREE from 'three';

const FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
let anisotropy = 1;

export function setAnisotropy(n) {
  anisotropy = n;
}

function canvasTexture(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ARROW_ANGLE = { up: 0, right: Math.PI / 2, left: -Math.PI / 2, upright: Math.PI / 4, upleft: -Math.PI / 4 };

function drawArrow(g, cx, cy, size, dir) {
  g.save();
  g.translate(cx, cy);
  g.rotate(ARROW_ANGLE[dir] ?? 0);
  const s = size / 2;
  g.beginPath();
  g.moveTo(0, -s);
  g.lineTo(s * 0.62, -s * 0.15);
  g.lineTo(s * 0.2, -s * 0.15);
  g.lineTo(s * 0.2, s);
  g.lineTo(-s * 0.2, s);
  g.lineTo(-s * 0.2, -s * 0.15);
  g.lineTo(-s * 0.62, -s * 0.15);
  g.closePath();
  g.fill();
  g.restore();
}

export function skyTexture() {
  return canvasTexture(4, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#3f82c9');
    grad.addColorStop(0.42, '#9cc2e2');
    grad.addColorStop(0.58, '#d3dfe6');
    grad.addColorStop(1, '#c4cfcb');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }, false);
}

// 도로 폭 30m(x) × 길이 10m(z) 한 타일
export function roadTexture() {
  return canvasTexture(1024, 512, (g, w, h) => {
    g.fillStyle = '#3b3d41';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const c = (48 + Math.random() * 34) | 0;
      g.fillStyle = `rgba(${c},${c},${c + 3},0.55)`;
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    const X = (m) => ((m + 15) / 30) * w;
    const W = (m) => (m / 30) * w;
    // 차선 중앙 바퀴 자국
    g.fillStyle = 'rgba(20,20,22,0.18)';
    for (const lane of [2.75, 6.25, 9.75, 13.25]) {
      for (const s of [-1, 1]) {
        for (const o of [-0.8, 0.8]) g.fillRect(X(s * lane + o) - W(0.25), 0, W(0.5), h);
      }
    }
    const line = (xm, color, dash) => {
      g.fillStyle = color;
      g.fillRect(X(xm) - W(0.075), 0, W(0.15), dash ? h * 0.4 : h);
    };
    for (const s of [-1, 1]) {
      line(s * 1.15, '#e8b923');
      line(s * 1.4, '#e8b923');
      line(s * 14.6, '#e9e9e6');
      for (const d of [4.5, 8, 11.5]) line(s * d, '#e9e9e6', true);
    }
  });
}

// 차선 없는 아스팔트 4m × 4m (차선은 지오메트리로 따로 그린다)
export function asphaltTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#3b3d41';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 4000; i++) {
      const c = (48 + Math.random() * 34) | 0;
      g.fillStyle = `rgba(${c},${c},${c + 3},0.55)`;
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
  });
}

// 방음벽 패널 4m × 4.5m
export function noiseWallTexture() {
  return canvasTexture(128, 144, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#b9cbd4');
    grad.addColorStop(1, '#8fa3ad');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(60,70,78,0.55)';
    g.fillRect(0, 0, 4, h);
    g.fillRect(0, h - 10, w, 10);
    g.fillStyle = 'rgba(255,255,255,0.25)';
    for (let y = 18; y < h - 10; y += 18) g.fillRect(4, y, w - 4, 2);
  });
}

export function checkerTexture() {
  return canvasTexture(64, 16, (g, w, h) => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 2; j++) {
        g.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
        g.fillRect(i * 8, j * 8, 8, 8);
      }
    }
  });
}

// 빨강·흰색 줄무늬 (서킷 연석·방호벽). alongV: 텍스처 세로(v) 방향으로 반복, 아니면 가로(u)
export function stripeTexture(alongV) {
  return canvasTexture(alongV ? 8 : 64, alongV ? 64 : 8, (g, w, h) => {
    g.fillStyle = '#d42a2a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#f2f2f0';
    if (alongV) g.fillRect(0, h / 2, w, h / 2);
    else g.fillRect(w / 2, 0, w / 2, h);
  });
}

// 보도 5m × 5m, 점자블록 포함
export function sidewalkTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const n = 10;
    const cell = w / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = (160 + Math.random() * 22) | 0;
        g.fillStyle = i === 3 ? '#d9b52a' : `rgb(${v + 14},${v},${v - 10})`;
        g.fillRect(i * cell, j * cell, cell, cell);
      }
    }
    g.fillStyle = 'rgba(70,60,55,0.35)';
    for (let i = 0; i <= n; i++) {
      g.fillRect(i * cell - 1, 0, 2, h);
      g.fillRect(0, i * cell - 1, w, 2);
    }
  });
}

// 아파트 외벽: 4세대(12m) × 8층(23.2m) 한 타일. 흰 바탕이라 재질 color로 틴트한다.
export function facadeTexture(variant) {
  const r = seeded(1000 + variant);
  return canvasTexture(256, 512, (g, w, h) => {
    g.fillStyle = '#f4f2ee';
    g.fillRect(0, 0, w, h);
    const fh = h / 8;
    const cw = w / 4;
    for (let f = 0; f < 8; f++) {
      for (let c = 0; c < 4; c++) {
        const x0 = c * cw;
        const y0 = f * fh;
        const roll = r();
        const grad = g.createLinearGradient(0, y0 + 12, 0, y0 + 48);
        if (roll < 0.15) {
          grad.addColorStop(0, '#d8d0bd');
          grad.addColorStop(1, '#b9b09c');
        } else {
          grad.addColorStop(0, roll < 0.5 ? '#6f879c' : '#56697b');
          grad.addColorStop(1, '#34424f');
        }
        g.fillStyle = grad;
        if (variant === 1) {
          g.fillRect(x0 + 5, y0 + 10, 54, 40);
        } else {
          g.fillRect(x0 + 8, y0 + 12, 48, 36);
        }
        g.fillStyle = '#e6e3dc';
        g.fillRect(x0 + 31, y0 + 12, 2, 36);
        g.fillStyle = 'rgba(0,0,0,0.14)';
        g.fillRect(x0 + 6, y0 + 46, 52, 3);
      }
      g.fillStyle = '#dcd8d0';
      g.fillRect(0, f * fh + 58, w, 6);
    }
    if (variant === 2) {
      // 세로 강조 띠
      g.fillStyle = 'rgba(120,120,120,0.18)';
      g.fillRect(0, 0, 6, h);
    }
  });
}

const SHOPS = [
  '카페', '치킨', '편의점', '약국', '수학학원', '영어학원', '내과', 'PC방', '마트', '부동산',
  '김밥', '베이커리', '안경', '네일', '소아과', '피자', '국밥', '헬스', '치과', '태권도',
];
const SIGN_COLORS = ['#c0392b', '#1f5fa8', '#2e8b57', '#e67e22', '#6c3483', '#f1c40f', '#16a085', '#222'];

// 상가 1층분(12m × 3.5m)에 가게 2개
export function shopTexture(variant) {
  const r = seeded(2000 + variant);
  return canvasTexture(512, 160, (g, w, h) => {
    g.fillStyle = '#d9d5cd';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2; i++) {
      const x0 = i * (w / 2);
      const bg = SIGN_COLORS[(r() * SIGN_COLORS.length) | 0];
      g.fillStyle = bg;
      g.fillRect(x0 + 6, 6, w / 2 - 12, 44);
      g.fillStyle = bg === '#f1c40f' ? '#222' : '#fff';
      g.font = `bold 32px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(SHOPS[(r() * SHOPS.length) | 0], x0 + w / 4, 30);
      const grad = g.createLinearGradient(0, 58, 0, h - 8);
      grad.addColorStop(0, '#8fa6b8');
      grad.addColorStop(1, '#3d4b57');
      g.fillStyle = grad;
      g.fillRect(x0 + 10, 58, w / 2 - 20, h - 66);
      g.fillStyle = '#c9c5bc';
      g.fillRect(x0 + w / 4 - 1, 58, 3, h - 66);
    }
  });
}

// 유리 커튼월 6m × 12m
export function glassTexture() {
  return canvasTexture(128, 256, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#86a9c4');
    grad.addColorStop(1, '#4b6c88');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(230,240,248,0.55)';
    for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 2, h);
    g.fillStyle = 'rgba(30,45,60,0.45)';
    for (let y = 0; y < h; y += 64) g.fillRect(0, y, w, 4);
  });
}

// 초록 도로 표지판. entries: [[dir, 한글, English], ...]
export function signTexture(entries) {
  return canvasTexture(1024, 288, (g, w, h) => {
    g.fillStyle = '#0d6e3d';
    g.beginPath();
    g.roundRect(0, 0, w, h, 24);
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 8;
    g.beginPath();
    g.roundRect(12, 12, w - 24, h - 24, 18);
    g.stroke();
    const cw = w / entries.length;
    g.fillStyle = '#fff';
    entries.forEach(([dir, ko, en], i) => {
      const cx = cw * i + cw / 2;
      if (i > 0) g.fillRect(cw * i - 2, 36, 4, h - 72);
      drawArrow(g, cx - cw * 0.33, h / 2, 100, dir);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `bold 78px ${FONT}`;
      g.fillText(ko, cx + 34, 120, cw * 0.62);
      g.font = `32px ${FONT}`;
      g.fillText(en, cx + 34, 200, cw * 0.62);
    });
  }, false);
}

export function bannerTexture(text, { bg = '#ffffff', fg = '#111111', w = 1024, h = 128, arrow = null } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${Math.round(h * 0.58)}px ${FONT}`;
    const tx = arrow ? w / 2 + h * 0.4 : w / 2;
    g.fillText(text, tx, h / 2 + 2, w * 0.86);
    if (arrow) {
      const tw = Math.min(g.measureText(text).width, w * 0.86);
      drawArrow(g, tx - tw / 2 - h * 0.5, h / 2, h * 0.7, arrow);
    }
  }, false);
}
