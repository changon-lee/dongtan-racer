const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'KeyC', 'KeyM', 'KeyO',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Escape',
]);

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set(); // 이번 프레임에 새로 눌린 키 (consume으로 한 번만 처리)
    addEventListener('keydown', (e) => {
      // 옵션 시트의 슬라이더·버튼을 키보드로 조작할 때는 게임 입력으로 보지 않음
      if (e.target.closest?.('input, button') && e.code !== 'Escape') return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  any(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  get throttle() {
    return this.any('KeyW', 'ArrowUp') ? 1 : 0;
  }

  get brake() {
    return this.any('KeyS', 'ArrowDown');
  }

  get boost() {
    return this.keys.has('Space');
  }

  // +1 = 왼쪽, -1 = 오른쪽
  get steer() {
    return (this.any('KeyA', 'ArrowLeft') ? 1 : 0) - (this.any('KeyD', 'ArrowRight') ? 1 : 0);
  }

  consume(code) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  endFrame() {
    this.pressed.clear();
  }
}
