import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 빌드 결과를 ../public 에 바로 내보낸다.
  // Vercel이 지금도 public을 정적 서빙 중이라면 vercel.json을 안 바꿔도 된다.
  // 주의: npm run build 를 실행하는 순간 기존 public/index.html은 지워지고 새 결과물로 교체된다.
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // 개발 중에는 /api 요청을 로컬 Express 서버(node scripts/cli.js dev, 3000번)로 넘긴다.
      // 브라우저 입장에서는 항상 5173 하나만 보이므로 CORS/쿠키 문제가 생기지 않는다.
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});