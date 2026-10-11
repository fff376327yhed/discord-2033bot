// Firestore 연결 모듈 (서버 전용: 비밀 키를 쓰므로 브라우저 코드에서 절대 import 금지)
import 'dotenv/config'; // 로컬에서는 .env를 읽고, Vercel에서는 대시보드 환경 변수가 이미 들어 있음
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// 환경 변수에서 서비스 계정 JSON을 복원한다.
function loadServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 환경 변수가 없습니다. .env를 확인하세요.');
  }
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

let db = null;

// Firestore 인스턴스를 가져온다. 처음 호출할 때만 초기화하고 이후엔 재사용한다.
// (서버리스는 같은 인스턴스가 여러 요청에 재사용되므로 매번 초기화하면 느려짐)
export function getDb() {
  if (db) return db;
  if (!getApps().length) {
    initializeApp({ credential: cert(loadServiceAccount()) });
  }
  db = getFirestore();
  // undefined 값이 있는 필드는 저장하지 않고 무시 (없으면 저장 시 에러가 남)
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}