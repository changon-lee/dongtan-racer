import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const D2R = Math.PI / 180;

// 세로 화면: 좌우 시야가 화면비 0.75일 때만큼은 보이도록 세로 FOV를 넓힌다 (최대 105°)
function fitFov(fov, aspect) {
  if (aspect >= 0.75) return fov;
  return Math.min(105, (2 * Math.atan((Math.tan((fov / 2) * D2R) * 0.75) / aspect)) / D2R);
}

export class ChaseCamera {
  constructor(aspect) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 2000);
    this.heading = null;
    this.t = 0;
    this.boostK = 0;
  }

  // 위치는 차에 고정하고 방향만 부드럽게 따라간다 (월드 좌표 lerp는 고속에서 수십 m 뒤처짐)
  update(dt, car) {
    this.t += dt;
    const p = car.pose;
    // 차 헤딩을 절반만 따라가서 조향 시 차 옆모습이 살짝 보이게
    const target = p.ry + car.yaw * 0.5;
    if (this.heading === null) this.heading = target;
    this.heading += wrap(target - this.heading) * (1 - Math.exp(-6 * dt));

    const speedK = clamp(car.v / 72, 0, 1);
    this.boostK += ((car.boosting ? 1 : 0) - this.boostK) * (1 - Math.exp(-4 * dt));
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const back = 6 + speedK * 0.8 + clamp(car.accelSmooth, -10, 10) * 0.05 + this.boostK * 0.6;
    const height = 2.2 - speedK * 0.25;

    const cam = this.camera;
    // 높이는 경사를 따라 뒤쪽 도로면 기준으로
    cam.position.set(p.x - fx * back, p.y - p.grade * back + height, p.z - fz * back);
    // 고속·충돌 시 흔들림
    const amp = Math.min(0.045, Math.max(0, (car.v - 50) / 22) * 0.025) + car.scrape * 0.1 + this.boostK * 0.03;
    if (amp > 0) {
      cam.position.x += Math.sin(this.t * 47) * Math.sin(this.t * 13) * amp;
      cam.position.y += Math.sin(this.t * 53 + 1.3) * Math.sin(this.t * 7) * amp;
    }
    cam.lookAt(p.x + fx * 10, p.y + p.grade * 10 + 0.9, p.z + fz * 10);

    // 262km/h 이후(리미터 해제)는 450km/h까지 FOV를 조금 더 벌린다
    // 부스터 중엔 10도 더
    const fov = fitFov(60 + 22 * Math.pow(speedK, 1.3) + 8 * clamp((car.v - 72) / 53, 0, 1) + this.boostK * 10, cam.aspect);
    if (Math.abs(fov - cam.fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  // 메인 화면: 차 주위를 천천히 돈다. 왼쪽 메뉴를 피해 차가 화면 오른쪽에 오도록 시선을 왼쪽으로 민다
  orbit(dt, car) {
    this.t += dt;
    this.heading = null;
    const p = car.pose;
    const a = p.ry + 2.3 + this.t * 0.12;
    const r = 7.2;
    const cam = this.camera;
    cam.position.set(p.x + Math.sin(a) * r, p.y + 1.7, p.z + Math.cos(a) * r);
    // 시선 (-sin a, -cos a)의 화면 오른쪽 = (cos a, -sin a). 시선을 그 반대로 밀면 차가 오른쪽에 보인다
    const rx = Math.cos(a);
    const rz = -Math.sin(a);
    const shift = 2.2;
    cam.lookAt(p.x - rx * shift, p.y + 0.6, p.z - rz * shift);
    const fov = fitFov(42, cam.aspect);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
