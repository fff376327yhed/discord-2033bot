// Vercel 서버리스 함수: 웹 API 전체를 Express 앱 하나로 처리한다.
// (디스코드용 api/interactions.js는 원본 요청 본문이 필요해서 따로 둔다)
// 4단계: 로그인/스토리 API는 src/bundle.js 의 createWebRouter()로 붙인다. 함수 개수는 그대로 2개다.
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { getDb, createWebRouter } from '../src/bundle.js';

const app = express();

// Vercel 프록시 뒤에서 실제 접속자 IP를 인식 (속도 제한에 필요)
app.set('trust proxy', 1);

// 보안 헤더 기본 적용
app.use(helmet());

// 요청 본문 크기 제한 (너무 큰 데이터로 서버를 괴롭히는 것을 방지)
// 기본은 200KB, 장면 전체 저장(PUT /api/stories/:id/scenes)만 1.5MB까지 허용한다.
// 한글은 글자당 3바이트라서 장면이 많은 스토리는 200KB를 넘을 수 있다.
// 참고: Vercel 함수 자체의 요청 크기 한도(약 4.5MB로 알고 있음)는 확인이 필요하다.
const smallJson = express.json({ limit: '200kb' });
const largeJson = express.json({ limit: '1.5mb' });
app.use((req, res, next) => {
  const isSceneSave = req.method === 'PUT' && /^\/api\/stories\/[^/]+\/scenes\/?$/.test(req.path);
  return (isSceneSave ? largeJson : smallJson)(req, res, next);
});

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

// 4단계: 디스코드 로그인 + 스토리/장면 API
app.use(createWebRouter());

// 없는 주소
app.use((req, res) => {
  res.status(404).json({ error: '찾을 수 없는 주소입니다.' });
});

// 처리 중 예외 (상세 내용은 클라이언트에 노출하지 않음)
app.use((err, req, res, next) => {
  // 잘못된 JSON, 너무 큰 본문은 서버 오류가 아니라 요청자의 잘못이므로 4xx로 알려준다.
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON 형식이 올바르지 않습니다.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: '요청이 너무 큽니다.' });

  console.error('[서버 오류]', err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

// Vercel은 default export된 Express 앱을 함수로 실행한다.
export default app;