// Firestore 읽기/쓰기 모음. 봇 핸들러는 DB를 직접 만지지 않고 여기만 호출한다.
// 상태 변경은 트랜잭션으로 처리해서, 동시에 눌러도 한 번만 반영되게 한다.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../lib/firebase.js';
import { COL, SCENE_ID_PATTERN, userStoryKey } from '../lib/collections.js';
import { startStory, advance } from '../engine/index.js';

const refs = {
  story: (id) => getDb().collection(COL.STORIES).doc(id),
  scene: (storyId, sceneId) =>
    getDb().collection(COL.STORIES).doc(storyId).collection(COL.SCENES).doc(sceneId),
  session: (userId, storyId) => getDb().collection(COL.SESSIONS).doc(userStoryKey(userId, storyId)),
  ending: (userId, storyId) => getDb().collection(COL.ENDINGS).doc(userStoryKey(userId, storyId)),
  user: (id) => getDb().collection(COL.USERS).doc(id),
};

// 트랜잭션 없이 읽을 때 쓰는 "읽기 도구" (tx.get과 같은 모양으로 맞춤)
const directReader = { get: (ref) => ref.get() };

// 엔진에 넘겨줄 장면 불러오기 함수를 만든다. 같은 장면은 한 번만 읽는다.
function makeSceneLoader(reader, storyId) {
  const cache = new Map();
  return async (sceneId) => {
    if (typeof sceneId !== 'string' || !SCENE_ID_PATTERN.test(sceneId)) return null;
    if (cache.has(sceneId)) return cache.get(sceneId);
    const snap = await reader.get(refs.scene(storyId, sceneId));
    // 문서 ID를 장면 id로 강제한다 (저장된 데이터와 달라도 문서 ID가 기준)
    const scene = snap.exists ? { ...snap.data(), id: snap.id } : null;
    cache.set(sceneId, scene);
    return scene;
  };
}

/** 공개 스토리를 최신순으로 가져온다. (첫 실행 시 Firestore 인덱스 생성이 필요할 수 있음) */
export async function getPublicStories(limit = 5) {
  const snap = await getDb()
    .collection(COL.STORIES)
    .where('isPublic', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
}

/**
 * 새 게임 시작. 성공하면 { ok:true, story, state, scene, changes }
 * 실패 code: NO_STORY, FORBIDDEN, ALREADY_ACTIVE, NO_START, 그 외 엔진 오류
 */
export async function startSession(user, storyId) {
  return getDb().runTransaction(async (tx) => {
    // 읽기는 모두 쓰기보다 먼저 해야 한다 (트랜잭션 규칙)
    const [storySnap, sessionSnap, userSnap] = await Promise.all([
      tx.get(refs.story(storyId)),
      tx.get(refs.session(user.id, storyId)),
      tx.get(refs.user(user.id)),
    ]);

    if (!storySnap.exists) return { ok: false, code: 'NO_STORY' };
    const story = { ...storySnap.data(), id: storySnap.id };
    // 비공개 스토리는 제작자 본인만 플레이 가능
    if (!story.isPublic && story.authorId !== user.id) return { ok: false, code: 'FORBIDDEN' };
    if (sessionSnap.exists && sessionSnap.get('status') === 'active') {
      return { ok: false, code: 'ALREADY_ACTIVE', story };
    }

    const loadScene = makeSceneLoader(tx, storyId);
    const startScene = await loadScene(story.startSceneId);
    if (!startScene) return { ok: false, code: 'NO_START' };

    const result = await startStory(story.config ?? {}, startScene, loadScene);
    if (!result.ok) return result;

    const now = Date.now();
    const finished = Boolean(result.state.ending);

    tx.set(
      refs.user(user.id),
      {
        username: user.username,
        avatar: user.avatar,
        createdAt: userSnap.exists ? (userSnap.get('createdAt') ?? now) : now,
        updatedAt: now,
      },
      { merge: true }
    );
    // 문서 ID가 "유저ID_스토리ID"라서 같은 스토리를 동시에 2개 진행할 수 없다. 끝난 기록은 덮어쓴다.
    tx.set(refs.session(user.id, storyId), {
      userId: user.id,
      storyId,
      storyTitle: story.title,
      currentSceneId: result.scene.id,
      state: result.state,
      status: finished ? 'finished' : 'active',
      startedAt: now,
      updatedAt: now,
    });
    tx.update(refs.story(storyId), { playCount: FieldValue.increment(1) });
    if (finished) {
      tx.set(
        refs.ending(user.id, storyId),
        { userId: user.id, storyId, endings: { [result.scene.id]: now } },
        { merge: true }
      );
    }

    return { ok: true, story, state: result.state, scene: result.scene, changes: result.changes };
  });
}

/**
 * 선택지 1개를 눌러 진행하고 저장한다.
 * 성공하면 { ok:true, story, state, scene, changes, ending }
 * 실패 code: NO_SESSION, STALE(오래된 버튼), NO_STORY, NO_SCENE, 그 외 엔진 오류(LOCKED 등)
 */
export async function chooseInSession(userId, storyId, turn, choiceIndex) {
  return getDb().runTransaction(async (tx) => {
    const sessionRef = refs.session(userId, storyId);
    const [sessionSnap, storySnap] = await Promise.all([tx.get(sessionRef), tx.get(refs.story(storyId))]);

    if (!sessionSnap.exists || sessionSnap.get('status') !== 'active') return { ok: false, code: 'NO_SESSION' };
    const session = sessionSnap.data();
    // 버튼의 턴과 저장된 턴이 다르면 오래된 버튼 → 거절 (최신 화면으로 갱신하는 건 호출한 쪽)
    if (session.state?.turn !== turn) return { ok: false, code: 'STALE' };
    if (!storySnap.exists) return { ok: false, code: 'NO_STORY', message: '스토리가 삭제되었습니다.' };
    const story = { ...storySnap.data(), id: storySnap.id };

    const loadScene = makeSceneLoader(tx, storyId);
    const current = await loadScene(session.currentSceneId);
    if (!current) return { ok: false, code: 'NO_SCENE', message: '현재 장면을 찾을 수 없습니다.' };

    const result = await advance(story.config ?? {}, session.state, current, choiceIndex, loadScene);
    if (!result.ok) return result;

    const now = Date.now();
    tx.update(sessionRef, {
      currentSceneId: result.scene.id,
      state: result.state,
      status: result.ending ? 'finished' : 'active',
      updatedAt: now,
    });
    // 엔딩 도감: 본 엔딩을 기록 (merge라서 기존 기록은 유지)
    if (result.ending) {
      tx.set(
        refs.ending(userId, storyId),
        { userId, storyId, endings: { [result.scene.id]: now } },
        { merge: true }
      );
    }

    return { ok: true, story, state: result.state, scene: result.scene, changes: result.changes, ending: result.ending };
  });
}

/** 진행 중인 세션의 현재 화면 정보 (이어하기용). 없으면 null */
export async function getSessionView(userId, storyId) {
  const sessionSnap = await refs.session(userId, storyId).get();
  if (!sessionSnap.exists || sessionSnap.get('status') !== 'active') return null;
  const session = sessionSnap.data();

  const [storySnap, scene] = await Promise.all([
    refs.story(storyId).get(),
    makeSceneLoader(directReader, storyId)(session.currentSceneId),
  ]);
  if (!storySnap.exists || !scene) return null;
  return { story: { ...storySnap.data(), id: storySnap.id }, session, scene };
}

/** 진행 중인 세션 목록 (최신순 최대 5개). 목록 버튼이 한 줄 5개라서 5개로 제한 */
export async function listActiveSessions(userId) {
  const snap = await getDb()
    .collection(COL.SESSIONS)
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .limit(25)
    .get();
  return snap.docs
    .map((doc) => doc.data())
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 5)
    .map((data) => ({ storyId: data.storyId, storyTitle: data.storyTitle ?? '제목 없음' }));
}

/** 진행 중인 세션을 포기 처리. 포기했으면 true */
export async function abandonSession(userId, storyId) {
  const ref = refs.session(userId, storyId);
  const snap = await ref.get();
  if (!snap.exists || snap.get('status') !== 'active') return false;
  await ref.update({ status: 'abandoned', updatedAt: Date.now() });
  return true;
}