// 플레이 상태(state)의 모양과 공용 도구를 정의한다.
// state는 JSON으로 Firestore에 그대로 저장할 수 있는 평범한 객체다.
//
// state = {
//   sceneId,            현재 장면 키
//   station,            현재 역 이름 (장면의 station 값을 따라감)
//   stats, resources, factions,   숫자 값들 { 키: 숫자 }
//   inventory,          소지품 { 아이템키: 개수 }
//   flags,              플래그 { 키: true }  (false는 저장하지 않고 삭제)
//   history,            최근 선택 기록 [{ from, choice }] (최대 HISTORY_MAX개)
//   turn,               진행한 선택 횟수
//   ending,             엔딩에 도달하면 { sceneId, name, type }, 아니면 null
// }

export const HISTORY_MAX = 100;   // 기록이 무한히 커져 Firestore 문서가 터지는 것을 방지
export const ITEM_MAX = 99;       // 아이템 한 종류당 최대 개수

// 조건/효과의 type → config와 state 안의 보관 위치
export const NUMERIC_BUCKETS = {
  stat: 'stats',
  resource: 'resources',
  faction: 'factions',
};

// config에 min/max가 없을 때 쓰는 기본 범위
const DEFAULT_RANGE = {
  stats: [0, 100],
  resources: [0, 99],
  factions: [-100, 100],
};

// 제작자가 입력하는 키(플래그, 아이템 등)가 안전한지 검사한다.
// '__proto__' 같은 키로 객체 구조를 망가뜨리는 공격을 막는다.
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 40 && !BLOCKED_KEYS.has(key);
}

// 객체 "자신의" 값만 읽는다. (상속된 속성을 읽는 실수 방지)
export function readOwn(obj, key, fallback) {
  if (obj && typeof key === 'string' && Object.hasOwn(obj, key)) return obj[key];
  return fallback;
}

// 값을 최소~최대 범위 안으로 맞춘다.
export function clampValue(value, bucket, def = {}) {
  const [defMin, defMax] = DEFAULT_RANGE[bucket] ?? [0, 99];
  const min = Number.isFinite(def.min) ? def.min : defMin;
  const max = Number.isFinite(def.max) ? def.max : defMax;
  return Math.min(max, Math.max(min, value));
}

// 스토리 설정(config)으로 새 게임의 시작 상태를 만든다.
export function createInitialState(config = {}) {
  const state = {
    sceneId: null,
    station: null,
    stats: {},
    resources: {},
    factions: {},
    inventory: {},
    flags: {},
    history: [],
    turn: 0,
    ending: null,
  };

  for (const bucket of Object.values(NUMERIC_BUCKETS)) {
    for (const [key, def] of Object.entries(config[bucket] ?? {})) {
      if (!isSafeKey(key)) continue;
      state[bucket][key] = clampValue(Number(def.initial) || 0, bucket, def);
    }
  }

  for (const [key, count] of Object.entries(config.startInventory ?? {})) {
    if (isSafeKey(key) && Number(count) > 0) {
      state.inventory[key] = Math.min(ITEM_MAX, Math.trunc(Number(count)));
    }
  }

  return state;
}