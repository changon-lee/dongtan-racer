// 모바일 화면 버튼: 왼쪽 ◀ ▶ 조향, 오른쪽 브레이크·가속·부스터
// 손가락마다 지금 올라가 있는 버튼을 좌표로 찾는다 → 누른 채 옆 버튼으로 밀어도 따라간다

export const isTouch = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch');

export function setupTouch(input) {
  if (isTouch) document.body.classList.add('touch');
  const pad = document.getElementById('touch');
  const btns = [...pad.querySelectorAll('[data-touch]')];
  const fingers = new Map(); // pointerId → data-touch 값 (버튼 밖이면 null)

  const hit = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-touch]')?.dataset.touch ?? null;
  const refresh = () => {
    const on = new Set(fingers.values());
    for (const k in input.touch) input.touch[k] = on.has(k);
    for (const b of btns) b.classList.toggle('on', on.has(b.dataset.touch));
  };

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fingers.set(e.pointerId, hit(e));
    refresh();
  });
  pad.addEventListener('pointermove', (e) => {
    if (!fingers.has(e.pointerId)) return;
    const k = hit(e);
    if (k === fingers.get(e.pointerId)) return;
    fingers.set(e.pointerId, k);
    refresh();
  });
  const up = (e) => {
    if (fingers.delete(e.pointerId)) refresh();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pad.addEventListener(type, up);
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  // 일시정지 등으로 화면이 바뀌면 누르던 버튼은 놓은 것으로
  addEventListener('blur', () => {
    fingers.clear();
    refresh();
  });
  // iOS 핀치 확대 막기
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

// 안드로이드: 주행 시작 때 전체 화면 (방향은 자유. iPhone Safari는 지원 안 함 → 조용히 무시)
export function enterFullscreen() {
  if (!isTouch || document.fullscreenElement) return;
  document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch(() => {});
}
