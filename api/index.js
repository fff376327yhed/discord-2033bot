// Vercel 서버리스 함수: 웹 API 전체를 Express 앱 하나로 처리한다.
// (3단계에서 디스코드용 api/interactions.js를 따로 추가한다. 원본 요청 본문이 필요해서 분리)
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { getDb } from '../src/lib/firebase.js';

const app = express();

// Vercel 프록시 뒤에서 실제 접속자 IP를 인식 (속도 제한에 필요)
app.set('trust proxy', 1);

// 보안 헤더 기본 적용
app.use(helmet());

// 요청 본문 크기 제한 (너무 큰 데이터로 서버를 괴롭히는 것을 방지)
app.use(express.json({ limit: '200kb' }));

// 요청 속도 제한: IP당 1분에 120회
// 주의: 서버리스에서는 인스턴스마다 따로 세므로 완벽하지 않음 (7단계에서 보강 예정)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// 서버와 Firestore 연결 상태 확인
app.get('/api/health', async (req, res) => {
  try {
    const db = getDb();
    await db.collection('_health').doc('ping').get(); // 문서가 없어도 읽기 시도 자체가 연결 확인
    res.json({ ok: true, firestore: 'connected' });
  } catch (err) {
    console.error('[health 오류]', err); // 상세 오류는 서버 로그에만 남김
    res.status(500).json({ ok: false, error: 'Firestore 연결에 실패했습니다.' });
  }
});

// 없는 주소
app.use((req, res) => {
  res.status(404).json({ error: '찾을 수 없는 주소입니다.' });
});

// 처리 중 예외 (상세 내용은 클라이언트에 노출하지 않음)
app.use((err, req, res, next) => {
  console.error('[서버 오류]', err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

// Vercel은 default export된 Express 앱을 함수로 실행한다.
export default app;