// 로컬 개발용 서버: api/index.js의 Express 앱을 그대로 띄우고 public 폴더도 보여준다.
// 실행: npm run dev
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import app from '../api/index.js'; // 이 import 과정에서 .env가 로드됨

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 3000;

const root = express();
root.use(express.static(path.resolve(__dirname, '../public'))); // Vercel이 public을 서빙하는 것과 동일하게
root.use(app);

root.listen(port, () => {
  console.log(`🚇 서울2033 로컬 서버: http://localhost:${port}`);
  console.log(`   상태 확인: http://localhost:${port}/api/health`);
});