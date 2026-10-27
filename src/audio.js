const MASTER = 0.5;

// 전기모터 휘슬 + 풍절음. 브라우저 정책상 첫 키 입력 때 start() 한다.
export class MotorAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) return;
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER;
    this.master.connect(ctx.destination);

    this.low = ctx.createOscillator();
    this.low.type = 'sawtooth';
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    lp.Q.value = 2;
    const lowGain = ctx.createGain();
    lowGain.gain.value = 0.35;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.low.connect(lowGain).connect(lp);
    this.whine.connect(lp);
    lp.connect(this.motorGain).connect(this.master);

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.value = 900;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(nf).connect(this.windGain).connect(this.master);

    // 부스터: 낮게 울리는 분사음
    const boostNoise = ctx.createBufferSource();
    boostNoise.buffer = buf;
    boostNoise.loop = true;
    boostNoise.playbackRate.value = 0.7;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 320;
    bf.Q.value = 0.8;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    boostNoise.connect(bf).connect(this.boostGain).connect(this.master);
    boostNoise.start();

    this.low.start();
    this.whine.start();
    noise.start();
  }

  update(car) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = car.v;
    this.low.frequency.setTargetAtTime(40 + v * 7, t, 0.05);
    this.whine.frequency.setTargetAtTime(220 + v * 38, t, 0.05);
    const load = Math.max(car.powerFrac, car.regenFrac * 2);
    this.motorGain.gain.setTargetAtTime(Math.min(1, v / 8) * (0.04 + 0.16 * load), t, 0.08);
    this.boostGain.gain.setTargetAtTime(car.boosting ? 0.9 : 0, t, car.boosting ? 0.04 : 0.15);
    this.windGain.gain.setTargetAtTime(Math.min(0.5, (v / 72) ** 2 * 0.4) + car.scrape * 0.3, t, 0.1);
  }

  // 충돌음: 짧은 저역 노이즈 버스트
  crash(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.5 + Math.random() * 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500 + strength * 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4 + strength * 1.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25 + strength * 0.4);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.8);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : MASTER;
  }

  // 일시정지 중엔 오디오 컨텍스트를 멈춘다
  setPaused(paused) {
    if (!this.ctx) return;
    if (paused) this.ctx.suspend();
    else this.ctx.resume();
  }
}
