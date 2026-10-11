// 컬렉션 이름, 제한값, ID 규칙을 한 곳에 모아둔다. (오타 방지용)
// 봇, API, 웹 에디터 검증이 모두 이 값을 기준으로 한다.
import { randomUUID } from 'node:crypto';

// ── 컬렉션 이름 ──
export const COL = {
  USERS: 'users',             // users/{디스코드 유저 ID}
  STORIES: 'stories',         // stories/{UUID}
  SCENES: 'scenes',           // stories/{UUID}/scenes/{장면 키}  (하위 컬렉션)
  SESSIONS: 'playSessions',   // playSessions/{유저ID}_{스토리ID}
  ENDINGS: 'endingsSeen',     // endingsSeen/{유저ID}_{스토리ID}
};

// ── 문서 필드 설명 (참고용 주석, 실제 검증은 2단계 이후 추가) ──
//
// users/{id}
//   username: string, avatar: string|null, createdAt: number(ms), updatedAt: number(ms)
//
// stories/{id}
//   authorId: string, title: string, description: string, tags: string[],
//   isPublic: boolean, startSceneId: string|null,
//   config: { initialStats, initialResources, factions }   // 2단계에서 구체화
//   likeCount: number, playCount: number, sceneCount: number,
//   createdAt: number, updatedAt: number
//
// stories/{id}/scenes/{sceneId}
//   body: string, imageUrl: string|null,
//   isEnding: boolean, endingName: string|null, endingType: 'good'|'bad'|'hidden'|null,
//   choices: [{ label, to, condition, effects }],          // 2단계에서 구체화
//   posX: number, posY: number                              // 에디터 노드 위치(5단계)
//
// playSessions/{유저ID}_{스토리ID}
//   userId, storyId, currentSceneId, state: { stats, inventory, flags, history },
//   status: 'active'|'finished'|'abandoned', startedAt, updatedAt
//
// endingsSeen/{유저ID}_{스토리ID}
//   userId, storyId, endings: { [장면키]: 본 시각(ms) }

// ── 입력 제한값 (디스코드 제한: 버튼 문구 80자, 임베드 설명 4096자) ──
export const LIMITS = {
  TITLE: 50,
  DESCRIPTION: 500,
  TAG_COUNT: 5,
  TAG_LENGTH: 20,
  SCENE_BODY: 1800,
  CHOICE_LABEL: 80,
  CHOICES_PER_SCENE: 5,
  SCENES_PER_STORY: 200,
};

// 장면 키는 영문/숫자/_/- 만 허용 (URL, 버튼 custom_id에 안전하게 쓰기 위해)
export const SCENE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

// 새 스토리 ID (추측하기 어려운 UUID)
export function newStoryId() {
  return randomUUID();
}

// 플레이 세션 / 엔딩 도감 문서 ID: 유저+스토리 조합이라 중복 진행이 구조적으로 불가능
export function userStoryKey(userId, storyId) {
  return `${userId}_${storyId}`;
}