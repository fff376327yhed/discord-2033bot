// Firestore 연결 테스트: 문서를 쓰고, 읽고, 지운다.
// 실행: npm run check
import { getDb } from '../src/lib/firebase.js';

const db = getDb();
const ref = db.collection('_health').doc('check');

await ref.set({ at: Date.now(), note: '서울2033 연결 테스트' });
console.log('✅ 쓰기 성공');

const snap = await ref.get();
console.log('✅ 읽기 성공:', snap.data());

await ref.delete();
console.log('✅ 삭제 성공. Firestore 연결 정상입니다.');