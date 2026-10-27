// 고를 수 있는 트랙. file은 public/ 아래 (tools/build-route.mjs, tools/build-circuit.mjs로 생성)
export const TRACKS = [
  {
    id: 'route',
    file: 'route.json',
    name: '동탄 → 잠실',
    type: '도로 코스',
    desc: '동탄 숲속마을에서 경부고속도로를 타고 잠실 롯데월드타워까지. 실제 지도와 지형으로 만든 코스를 달립니다.',
    from: '동탄 숲속마을 모아미래도',
    to: '잠실 롯데월드타워',
  },
  {
    id: 'yongin',
    file: 'yongin.json',
    name: '용인 스피드웨이',
    type: '서킷',
    desc: '에버랜드 옆 언덕에 자리한 서킷. 높낮이 54m, 트랙이 자기 위를 넘어가는 입체 교차까지 있는 테크니컬 코스를 정해진 랩만큼 돕니다.',
    from: '출발·결승선 (피트 앞 직선)',
    to: '정해진 랩 수 완주',
  },
];

export const LAP_CHOICES = [1, 3, 5, 10];
