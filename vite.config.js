import { defineConfig } from 'vite';

// 상대 경로로 빌드 → GitHub Pages(https://<id>.github.io/<저장소>/)처럼 하위 경로에 올려도 동작
export default defineConfig({
  base: './',
});
