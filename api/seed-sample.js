// 샘플 스토리를 Firestore에 올린다. 여러 번 실행해도 안전하다. (플레이 수는 유지)
// 실행: npm run seed
import { getDb } from '../src/lib/firebase.js';
import { COL } from '../src/lib/collections.js';
import { sampleStory } from '../src/engine/sample-story.js';

const db = getDb();
const storyRef = db.collection(COL.STORIES).doc(sampleStory.id);
const existing = await storyRef.get();
const now = Date.now();

// 스토리 본체
await storyRef.set({
  authorId: sampleStory.authorId,
  title: sampleStory.title,
  description: sampleStory.description,
  tags: sampleStory.tags,
  isPublic: true,
  startSceneId: sampleStory.startSceneId,
  config: sampleStory.config,
  likeCount: existing.get('likeCount') ?? 0,
  playCount: existing.get('playCount') ?? 0,
  sceneCount: Object.keys(sampleStory.scenes).length,
  createdAt: existing.get('createdAt') ?? now,
  updatedAt: now,
});

// 장면들 (하위 컬렉션). 문서 ID = 장면 키
const batch = db.batch();
Object.entries(sampleStory.scenes).forEach(([sceneId, scene], i) => {
  const { id, ...data } = scene; // id는 문서 ID로 대신하므로 필드에서 뺀다
  batch.set(storyRef.collection(COL.SCENES).doc(sceneId), {
    ...data,
    posX: (i % 4) * 260, // 에디터(5단계)에서 쓸 노드 위치 초기값
    posY: Math.floor(i / 4) * 180,
  });
});
await batch.commit();

console.log(`✅ 샘플 스토리 업로드 완료: ${sampleStory.id} (장면 ${Object.keys(sampleStory.scenes).length}개)`);