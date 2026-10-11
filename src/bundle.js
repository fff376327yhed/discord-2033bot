// 해정2033 통합 모듈. src/bundle.js 로 두고 사용한다.
// 합친 파일: lib/collections, lib/firebase, engine/{state,conditions,effects,engine,validate,sample-story},
//           bot/{commands,discord,verify,render,store,handlers}, web(4단계: 로그인/JWT/스토리 API)
// 다른 코드는 이 파일에서만 import 한다. 예) import { handleInteraction, createWebRouter } from '../src/bundle.js';

import 'dotenv/config'; // 로컬에서는 .env를 읽고, Vercel에서는 대시보드 환경 변수가 이미 들어 있음
import { randomUUID, randomBytes, createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ═════════════════════════════════════════════
// lib/collections: 컬렉션 이름, 제한값, ID 규칙
// ═════════════════════════════════════════════

export const COL = {
  USERS: 'users',             // users/{디스코드 유저 ID}
  STORIES: 'stories',         // stories/{UUID}
  SCENES: 'scenes',           // stories/{UUID}/scenes/{장면 키}  (하위 컬렉션)
  SESSIONS: 'playSessions',   // playSessions/{유저ID}_{스토리ID}
  ENDINGS: 'endingsSeen',     // endingsSeen/{유저ID}_{스토리ID}
  LIKES: 'likes',             // likes/{유저ID}_{스토리ID}  (6단계: 문서 ID가 곧 중복 방지)
};

// 필드 설명은 원본 collections.js 주석 참고 (users, stories, scenes, playSessions, endingsSeen)

// 입력 제한값 (디스코드 제한: 버튼 문구 80자, 임베드 설명 4096자)
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

// ═════════════════════════════════════════════
// lib/firebase: Firestore 연결 (서버 전용, 브라우저 코드에서 import 금지)
// ═════════════════════════════════════════════

// 환경 변수에서 서비스 계정 JSON을 복원한다.
function loadServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!b64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 환경 변수가 없습니다. .env를 확인하세요.');
  }
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

let firestoreDb = null;

// Firestore 인스턴스를 가져온다. 처음 호출할 때만 초기화하고 이후엔 재사용한다.
export function getDb() {
  if (firestoreDb) return firestoreDb;
  if (!getApps().length) {
    initializeApp({ credential: cert(loadServiceAccount()) });
  }
  firestoreDb = getFirestore();
  // undefined 값이 있는 필드는 저장하지 않고 무시 (없으면 저장 시 에러가 남)
  firestoreDb.settings({ ignoreUndefinedProperties: true });
  return firestoreDb;
}

// ═════════════════════════════════════════════
// engine/state: 플레이 상태의 모양과 공용 도구
// state = { sceneId, station, stats, resources, factions, inventory, flags, history, turn, ending }
// ═════════════════════════════════════════════

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

// 제작자가 입력하는 키가 안전한지 검사 ('__proto__' 같은 키 공격 방지)
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

// ═════════════════════════════════════════════
// engine/conditions: 선택지를 누를 수 있는지 판단
// ═════════════════════════════════════════════

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

function compare(actual, op, expected) {
  const fn = OPS[op];
  // 알 수 없는 연산자나 숫자가 아닌 값은 "불통과"로 처리 (안전한 쪽으로 잠금)
  if (!fn || typeof expected !== 'number' || Number.isNaN(expected)) return false;
  return fn(actual, expected);
}

/** 조건 1개 검사 → true/false */
export function checkCondition(state, cond) {
  if (!cond || typeof cond !== 'object') return false;
  const { type, key } = cond;

  if (type === 'flag') {
    const has = Boolean(readOwn(state.flags, key, false));
    return has === (cond.value ?? true);
  }

  if (type === 'item') {
    const count = readOwn(state.inventory, key, 0);
    return compare(count, cond.op ?? '>=', cond.value ?? 1);
  }

  const bucket = NUMERIC_BUCKETS[type];
  if (bucket) {
    return compare(readOwn(state[bucket], key, 0), cond.op ?? '>=', cond.value);
  }

  return false; // 알 수 없는 종류
}

/** 조건 배열 전체 검사 (전부 만족해야 true, 비어 있으면 true) */
export function checkConditions(state, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every((cond) => checkCondition(state, cond));
}

const OP_TEXT = {
  '>=': '이상',
  '<=': '이하',
  '>': '초과',
  '<': '미만',
  '==': '이어야 함',
  '!=': '이면 안 됨',
};

/** 조건/효과의 대상 이름(label)을 config에서 찾는다. 없으면 키를 그대로 사용 */
export function labelOf(config, type, key) {
  const bucket = NUMERIC_BUCKETS[type];
  let table = null;
  if (bucket) table = config?.[bucket];
  else if (type === 'item') table = config?.items;
  else if (type === 'flag') table = config?.flags;
  return readOwn(readOwn(table, key, null), 'label', key);
}

/** 조건 1개를 "방독면 필요", "한자 동맹 10 이상" 같은 문장으로 */
export function describeCondition(config, cond) {
  const name = labelOf(config, cond.type, cond.key);

  if (cond.type === 'flag') {
    return (cond.value ?? true) ? `${name} 상태 필요` : `${name} 상태가 아니어야 함`;
  }

  if (cond.type === 'item') {
    const op = cond.op ?? '>=';
    const value = cond.value ?? 1;
    if (op === '>=' && value === 1) return `${name} 필요`;
    return `${name} ${value}${OP_TEXT[op] ?? ''}`;
  }

  return `${name} ${cond.value}${OP_TEXT[cond.op ?? '>='] ?? ''}`;
}

// ═════════════════════════════════════════════
// engine/effects: 스탯, 아이템, 플래그 변경 (원본 state는 건드리지 않음)
// ═════════════════════════════════════════════

/**
 * 효과 목록을 순서대로 적용한다.
 * @returns {{ state, changes }}  changes = [{ type, key, label, from, to }]
 */
export function applyEffects(config, state, effects) {
  const next = structuredClone(state); // 깊은 복사: 원본 보호
  const changes = [];

  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (!effect || !isSafeKey(effect.key)) continue; // 위험한 키는 무시
      const change = applyOne(config, next, effect);
      if (change) changes.push(change);
    }
  }
  return { state: next, changes };
}

// 효과 1개 적용 (next를 직접 수정). 바뀐 게 없으면 null
function applyOne(config, next, effect) {
  const { type, key } = effect;
  const label = labelOf(config, type, key);

  // 숫자 값 (스탯/자원/파벌)
  const bucket = NUMERIC_BUCKETS[type];
  if (bucket) {
    const def = readOwn(config?.[bucket], key, null);
    // config에 정의되지 않은 값이나 숫자가 아닌 delta는 무시 (검증기가 경고함)
    if (!def || !Number.isFinite(effect.delta)) return null;
    const from = readOwn(next[bucket], key, 0);
    const to = clampValue(from + Math.trunc(effect.delta), bucket, def);
    next[bucket][key] = to;
    return from === to ? null : { type, key, label, from, to };
  }

  // 아이템 (개수 증감)
  if (type === 'item') {
    if (!readOwn(config?.items, key, null) || !Number.isFinite(effect.delta)) return null;
    const from = readOwn(next.inventory, key, 0);
    const to = Math.min(ITEM_MAX, Math.max(0, from + Math.trunc(effect.delta)));
    if (to === 0) delete next.inventory[key]; // 0개면 목록에서 제거
    else next.inventory[key] = to;
    return from === to ? null : { type, key, label, from, to };
  }

  // 플래그 (켜기/끄기)
  if (type === 'flag') {
    const to = Boolean(effect.value ?? true);
    const from = Boolean(readOwn(next.flags, key, false));
    if (to) next.flags[key] = true;
    else delete next.flags[key]; // false는 저장하지 않음 (상태를 작게 유지)
    return from === to ? null : { type, key, label, from, to };
  }

  return null; // 알 수 없는 종류
}

// ═════════════════════════════════════════════
// engine/engine: 시작, 선택지 목록, 선택 진행, 엔딩 처리
// 디스코드/Firestore를 모른다. 장면은 loadScene(id) 콜백으로만 받는다.
// ═════════════════════════════════════════════

const MAX_REDIRECTS = 5; // 스탯 0 리다이렉트가 무한 반복되는 것을 막는 안전장치

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * 현재 장면에서 보여줄 선택지 목록.
 * index는 scene.choices 안의 원래 번호다. (버튼에 이 번호를 담아 보낸다)
 * @returns {{ index, label, enabled, lockedReason }[]}
 */
export function getAvailableChoices(config, state, scene) {
  if (!scene || scene.isEnding) return [];
  const result = [];

  (scene.choices ?? []).forEach((choice, index) => {
    const unmet = (choice.condition ?? []).filter((cond) => !checkCondition(state, cond));
    const enabled = unmet.length === 0;
    if (!enabled && choice.hideWhenLocked) return; // 잠기면 숨기는 선택지
    result.push({
      index,
      label: choice.label,
      enabled,
      lockedReason: enabled ? null : unmet.map((cond) => describeCondition(config, cond)).join(', '),
    });
  });
  return result;
}

// 스탯이 최소값 이하가 되었을 때 보낼 장면 키를 찾는다. 없으면 null
function findZeroRedirect(config, state) {
  for (const [key, def] of Object.entries(config?.stats ?? {})) {
    if (def.onZero && readOwn(state.stats, key, 0) <= (Number.isFinite(def.min) ? def.min : 0)) {
      return def.onZero;
    }
  }
  return null;
}

/** 장면에 "들어간다": 진입 효과 적용, 위치 갱신, 엔딩 기록. */
export function enterScene(config, state, scene) {
  const { state: next, changes } = applyEffects(config, state, scene.onEnter);
  next.sceneId = scene.id;
  if (scene.station) next.station = scene.station;

  let redirectTo = null;
  if (scene.isEnding) {
    next.ending = {
      sceneId: scene.id,
      name: scene.endingName ?? scene.id,
      type: scene.endingType ?? null,
    };
  } else {
    redirectTo = findZeroRedirect(config, next); // 예: 체력 0 → 사망 엔딩
  }
  return { state: next, changes, redirectTo };
}

// 장면에 들어가고, 스탯 0 리다이렉트가 있으면 따라간다.
async function settle(config, state, scene, loadScene) {
  let current = state;
  let currentScene = scene;
  const changes = [];

  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const entered = enterScene(config, current, currentScene);
    current = entered.state;
    changes.push(...entered.changes);

    if (!entered.redirectTo) {
      return { ok: true, state: current, scene: currentScene, changes };
    }
    const target = await loadScene(entered.redirectTo);
    if (!target) return fail('SCENE_NOT_FOUND', `장면 '${entered.redirectTo}'을(를) 찾을 수 없습니다.`);
    currentScene = target;
  }
  return fail('REDIRECT_LOOP', '스탯 리다이렉트가 끝나지 않습니다. onZero 장면을 확인하세요.');
}

/**
 * 새 게임 시작.
 * @param startScene 시작 장면 객체
 * @param loadScene  async (sceneId) => 장면 객체 | null
 */
export async function startStory(config, startScene, loadScene) {
  if (!startScene) return fail('SCENE_NOT_FOUND', '시작 장면이 없습니다.');
  return settle(config, createInitialState(config), startScene, loadScene);
}

/**
 * 선택지 1개를 골라 다음 장면으로 진행한다. 실패해도 넘겨받은 state는 바뀌지 않는다.
 * 실패 code: ALREADY_ENDED, SCENE_MISMATCH, INVALID_CHOICE, LOCKED, SCENE_NOT_FOUND, REDIRECT_LOOP
 */
export async function advance(config, state, scene, choiceIndex, loadScene) {
  if (state.ending) return fail('ALREADY_ENDED', '이미 끝난 이야기입니다.');

  // 오래된 버튼(예전 메시지, 중복 클릭) 방지
  if (!scene || state.sceneId !== scene.id) {
    return fail('SCENE_MISMATCH', '지금 장면의 선택지가 아닙니다. 최신 메시지의 버튼을 눌러주세요.');
  }

  const choice = Number.isInteger(choiceIndex) ? scene.choices?.[choiceIndex] : null;
  if (scene.isEnding || !choice) return fail('INVALID_CHOICE', '존재하지 않는 선택지입니다.');

  if (!checkConditions(state, choice.condition)) {
    return fail('LOCKED', '조건을 만족하지 못해 선택할 수 없습니다.');
  }

  const target = await loadScene(choice.to);
  if (!target) return fail('SCENE_NOT_FOUND', `장면 '${choice.to}'을(를) 찾을 수 없습니다.`);

  // 1) 선택지의 효과 적용
  const applied = applyEffects(config, state, choice.effects);
  const moved = applied.state;

  // 2) 진행 기록 갱신 (오래된 기록은 잘라냄)
  moved.turn += 1;
  moved.history.push({ from: scene.id, choice: choiceIndex });
  if (moved.history.length > HISTORY_MAX) {
    moved.history.splice(0, moved.history.length - HISTORY_MAX);
  }

  // 3) 다음 장면에 진입 (진입 효과, 엔딩, 스탯 0 리다이렉트 포함)
  const settled = await settle(config, moved, target, loadScene);
  if (!settled.ok) return settled;

  return {
    ok: true,
    state: settled.state,
    scene: settled.scene,
    changes: [...applied.changes, ...settled.changes],
    ending: settled.state.ending, // 엔딩이면 { sceneId, name, type }, 아니면 null
  };
}

// ═════════════════════════════════════════════
// engine/validate: 스토리 검증기 (저장/공개 전에 문제를 찾아낸다)
// ═════════════════════════════════════════════

const KNOWN_TYPES = ['stat', 'resource', 'faction', 'item', 'flag'];

// 조건/효과가 config에 정의된 대상을 가리키는지 검사
function checkRef(config, entry, where, warnings) {
  if (!entry || !KNOWN_TYPES.includes(entry.type)) {
    warnings.push(`${where}: 알 수 없는 종류 '${entry?.type}'`);
    return;
  }
  const bucket = NUMERIC_BUCKETS[entry.type];
  let table = null;
  if (bucket) table = config[bucket];
  else if (entry.type === 'item') table = config.items;
  else return; // 플래그는 자유롭게 만들 수 있음
  if (!Object.hasOwn(table ?? {}, entry.key)) {
    warnings.push(`${where}: 정의되지 않은 ${entry.type} '${entry.key}' (효과/조건이 무시됩니다)`);
  }
}

/**
 * @returns {{ ok, errors, warnings }}
 *   errors   = 반드시 고쳐야 함 (끊긴 분기, 막다른 길, 엔딩 없음 등)
 *   warnings = 고치는 걸 권장 (도달 불가 장면, 엔딩에 못 가는 경로 등)
 */
export function validateStory(story) {
  const errors = [];
  const warnings = [];
  const scenes = story?.scenes ?? {};
  const config = story?.config ?? {};
  const ids = Object.keys(scenes);
  const has = (id) => typeof id === 'string' && Object.hasOwn(scenes, id);
  const done = () => ({ ok: errors.length === 0, errors, warnings });

  if (ids.length === 0) {
    errors.push('장면이 하나도 없습니다.');
    return done();
  }
  if (!has(story.startSceneId)) errors.push(`시작 장면 '${story.startSceneId}'이(가) 없습니다.`);

  // 스탯 0 리다이렉트 대상 장면 확인
  const zeroTargets = Object.values(config.stats ?? {}).map((def) => def.onZero).filter(Boolean);
  for (const target of zeroTargets) {
    if (!has(target)) errors.push(`스탯 onZero 장면 '${target}'이(가) 없습니다.`);
  }

  // 장면별 검사 + 이동 가능한 연결(edges) 수집
  const edges = {};
  for (const id of ids) {
    const scene = scenes[id];
    edges[id] = [];

    if (scene.id !== id) errors.push(`장면 키 '${id}'와 장면 내부 id '${scene.id}'가 다릅니다.`);
    if (!String(scene.body ?? '').trim()) warnings.push(`'${id}': 본문이 비어 있습니다.`);
    (scene.onEnter ?? []).forEach((effect) => checkRef(config, effect, `'${id}' 진입 효과`, warnings));

    const choices = scene.choices ?? [];
    if (scene.isEnding) {
      if (!scene.endingName) warnings.push(`엔딩 '${id}': 엔딩 이름이 없습니다.`);
      if (!['good', 'bad', 'hidden'].includes(scene.endingType)) {
        warnings.push(`엔딩 '${id}': 종류(good/bad/hidden)가 올바르지 않습니다.`);
      }
      if (choices.length > 0) warnings.push(`엔딩 '${id}': 선택지가 있지만 무시됩니다.`);
      continue;
    }

    if (choices.length === 0) errors.push(`'${id}': 엔딩이 아닌데 선택지가 없습니다 (막다른 길).`);

    choices.forEach((choice, i) => {
      const where = `'${id}'의 선택지 ${i + 1}`;
      if (!String(choice.label ?? '').trim()) errors.push(`${where}: 버튼 문구가 비어 있습니다.`);
      if (has(choice.to)) edges[id].push(choice.to);
      else errors.push(`${where}('${choice.label}'): 없는 장면 '${choice.to}'을(를) 가리킵니다 (끊긴 분기).`);
      (choice.condition ?? []).forEach((cond) => checkRef(config, cond, `${where} 조건`, warnings));
      (choice.effects ?? []).forEach((effect) => checkRef(config, effect, `${where} 효과`, warnings));
    });
  }

  // 시작 장면(과 사망 리다이렉트 장면)에서 도달 가능한 장면 찾기
  const reachable = new Set();
  const queue = [story.startSceneId, ...zeroTargets].filter(has);
  while (queue.length > 0) {
    const id = queue.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...edges[id]);
  }
  for (const id of ids) {
    if (!reachable.has(id)) warnings.push(`'${id}': 어떤 경로로도 도달할 수 없는 장면입니다.`);
  }

  // 엔딩 검사
  const endings = ids.filter((id) => scenes[id].isEnding);
  if (endings.length === 0) errors.push('엔딩이 하나도 없습니다.');
  else if (!endings.some((id) => reachable.has(id))) errors.push('시작 장면에서 도달할 수 있는 엔딩이 없습니다.');

  // "엔딩 없는 경로": 엔딩에서 거꾸로 거슬러 올라가며 엔딩에 닿을 수 있는 장면을 모은다
  const canEnd = new Set(endings);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of ids) {
      if (!canEnd.has(id) && edges[id].some((to) => canEnd.has(to))) {
        canEnd.add(id);
        changed = true;
      }
    }
  }
  for (const id of reachable) {
    if (!canEnd.has(id)) warnings.push(`'${id}': 이 장면에서는 어떤 선택을 해도 엔딩에 도달할 수 없습니다.`);
  }

  return done();
}

// ═════════════════════════════════════════════
// engine/sample-story: 샘플 스토리 (Firestore에 저장되는 스토리 구조의 기준)
// ═════════════════════════════════════════════

export const sampleStory = {
  id: 'sample-001',
  title: '군자역의 새벽',
  description: '방독면 하나와 통조림 몇 개로 지상까지 올라가는 짧은 생존 이야기',
  authorId: 'sample',
  isPublic: true,
  tags: ['생존', '지하철', '샘플'],
  startSceneId: 'start',

  config: {
    stats: {
      hp: { label: '체력', initial: 100, min: 0, max: 100, onZero: 'ending_dead' },
      sanity: { label: '정신력', initial: 80, min: 0, max: 100 },
    },
    resources: {
      food: { label: '식량', initial: 2, min: 0, max: 99 },
      filter: { label: '필터', initial: 1, min: 0, max: 99 },
      ammo: { label: '탄약', initial: 5, min: 0, max: 99 },
    },
    factions: {
      hanse: { label: '한자 동맹', initial: 0, min: -100, max: 100 },
      redline: { label: '레드라인', initial: 0, min: -100, max: 100 },
    },
    items: {
      gasmask: { label: '방독면' },
      keycard: { label: '보안 카드키' },
    },
    flags: {
      traded: { label: '시장 거래 완료' },
    },
  },

  scenes: {
    start: {
      id: 'start',
      body: '군자역 승강장에서 눈을 뜬다. 배낭 옆에 낡은 방독면과 통조림 몇 개가 놓여 있다. 오래 머물 수는 없다.',
      imageUrl: null,
      station: '군자역',
      isEnding: false,
      choices: [
        {
          label: '낡은 방독면을 챙긴다',
          to: 'tunnel',
          effects: [{ type: 'item', key: 'gasmask', delta: 1 }],
        },
        {
          label: '통조림을 챙긴다',
          to: 'tunnel',
          effects: [{ type: 'resource', key: 'food', delta: 2 }],
        },
      ],
    },

    tunnel: {
      id: 'tunnel',
      body: '터널 입구에서 희미한 가스 냄새가 난다. 어둠 속에서 필터 갈리는 소리가 들린다. 시장 쪽 불빛은 아직 따뜻하다.',
      imageUrl: null,
      station: '군자역 터널',
      isEnding: false,
      choices: [
        {
          label: '방독면을 쓰고 터널로 진입한다',
          to: 'tunnel_safe',
          condition: [{ type: 'item', key: 'gasmask' }],
          effects: [{ type: 'resource', key: 'filter', delta: -1 }],
        },
        {
          label: '맨얼굴로 달려간다',
          to: 'tunnel_gas',
          effects: [{ type: 'stat', key: 'hp', delta: -30 }],
        },
        { label: '발길을 돌려 시장으로 간다', to: 'market' },
      ],
    },

    tunnel_gas: {
      id: 'tunnel_gas',
      body: '독가스가 폐를 태운다. 눈앞이 흐려지고 무릎이 꺾인다. 간신히 몸을 돌려 기어 나온다.',
      imageUrl: null,
      station: '군자역 터널',
      isEnding: false,
      onEnter: [{ type: 'stat', key: 'hp', delta: -50 }],
      choices: [{ label: '기어서 시장으로 돌아간다', to: 'market' }],
    },

    market: {
      id: 'market',
      body: '지하 시장. 한자 동맹 상인이 필터를 흔들어 보이고, 한쪽에서는 레드라인 순찰대가 사람들을 훑어본다.',
      imageUrl: null,
      station: '군자역 시장',
      isEnding: false,
      choices: [
        {
          label: '통조림 1개를 주고 필터 2개를 받는다',
          to: 'market',
          condition: [
            { type: 'resource', key: 'food', op: '>=', value: 1 },
            { type: 'flag', key: 'traded', value: false },
          ],
          effects: [
            { type: 'resource', key: 'food', delta: -1 },
            { type: 'resource', key: 'filter', delta: 2 },
            { type: 'faction', key: 'hanse', delta: 10 },
            { type: 'flag', key: 'traded', value: true },
          ],
        },
        {
          label: '레드라인 순찰대에 말을 건다',
          to: 'redline_post',
          effects: [
            { type: 'faction', key: 'redline', delta: 15 },
            { type: 'faction', key: 'hanse', delta: -10 },
          ],
        },
        { label: '터널로 돌아간다', to: 'tunnel' },
      ],
    },

    redline_post: {
      id: 'redline_post',
      body: '순찰대장이 서약서를 내민다. 서명하면 안전과 식량을 보장받지만, 지상은 영영 못 볼 것이다.',
      imageUrl: null,
      station: '레드라인 초소',
      isEnding: false,
      choices: [
        { label: '서약서에 서명한다', to: 'ending_redline' },
        { label: '거절하고 시장으로 돌아간다', to: 'market' },
      ],
    },

    tunnel_safe: {
      id: 'tunnel_safe',
      body: '방독면 너머로 숨소리만 들린다. 터널 끝에 어린이대공원역의 비상등이 붉게 깜빡인다.',
      imageUrl: null,
      station: '어린이대공원역',
      isEnding: false,
      onEnter: [{ type: 'stat', key: 'sanity', delta: -5 }],
      choices: [
        { label: '역 사무실을 살핀다', to: 'office' },
        { label: '곧장 지상 출구로 향한다', to: 'exit' },
      ],
    },

    office: {
      id: 'office',
      body: '먼지 쌓인 사무실 서랍에서 빛바랜 카드키를 찾는다. 어딘가의 보안 문을 열 수 있을지도 모른다.',
      imageUrl: null,
      station: '어린이대공원역 사무실',
      isEnding: false,
      onEnter: [
        { type: 'item', key: 'keycard', delta: 1 },
        { type: 'stat', key: 'sanity', delta: -10 },
      ],
      choices: [{ label: '출구로 향한다', to: 'exit' }],
    },

    exit: {
      id: 'exit',
      body: '지상으로 이어지는 계단 앞. 잠긴 보안 문 하나와, 오래된 일반 출구가 보인다.',
      imageUrl: null,
      station: '어린이대공원역 출구',
      isEnding: false,
      choices: [
        {
          label: '카드키로 보안 문을 연다',
          to: 'ending_hidden',
          condition: [{ type: 'item', key: 'keycard' }],
        },
        {
          label: '한자 동맹 호위 부대와 함께 올라간다',
          to: 'ending_good',
          condition: [{ type: 'faction', key: 'hanse', op: '>=', value: 10 }],
        },
        { label: '홀로 지상으로 올라간다', to: 'ending_bad' },
      ],
    },

    ending_good: {
      id: 'ending_good',
      body: '호위 부대와 함께 계단을 오른다. 새벽빛이 쏟아진다. 당신은 지상에 닿은 첫 사람들 중 하나가 된다.',
      imageUrl: null,
      isEnding: true,
      endingName: '새벽의 호위',
      endingType: 'good',
      choices: [],
    },

    ending_bad: {
      id: 'ending_bad',
      body: '혼자 올라간 지상은 생각보다 훨씬 거칠었다. 이야기는 여기서 끊긴다.',
      imageUrl: null,
      isEnding: true,
      endingName: '홀로 지상으로',
      endingType: 'bad',
      choices: [],
    },

    ending_redline: {
      id: 'ending_redline',
      body: '서약서에 이름을 적는다. 안전한 나날이 이어지지만, 지상의 빛은 끝내 보지 못한다.',
      imageUrl: null,
      isEnding: true,
      endingName: '붉은 선 너머',
      endingType: 'bad',
      choices: [],
    },

    ending_hidden: {
      id: 'ending_hidden',
      body: '보안 문 너머에는 아무도 모르던 비밀 승강장이 있었다. 낡은 열차 한 대가 시동을 걸고 기다린다.',
      imageUrl: null,
      isEnding: true,
      endingName: '지상의 빛',
      endingType: 'hidden',
      choices: [],
    },

    ending_dead: {
      id: 'ending_dead',
      body: '숨이 끊어진다. 가스 속에서 마지막으로 본 것은 군자역의 깜빡이는 형광등이었다.',
      imageUrl: null,
      isEnding: true,
      endingName: '독안개 속에서',
      endingType: 'bad',
      choices: [],
    },
  },
};

// ═════════════════════════════════════════════
// bot/commands: 슬래시 커맨드 정의 (npm run register가 디스코드에 올린다)
// ═════════════════════════════════════════════

const SLASH = 1;   // 슬래시 커맨드 종류
const STRING = 3;  // 문자열 옵션 종류

export const COMMANDS = [
  {
    name: '스토리목록',
    description: '플레이할 수 있는 공개 스토리 목록을 봅니다 (검색어로 찾을 수도 있어요)',
    type: SLASH,
    options: [
      {
        type: STRING,
        name: '검색어',
        description: '제목, 설명, 태그에서 찾습니다',
        required: false,
        max_length: 50,
      },
    ],
  },
  {
    name: '플레이',
    description: '스토리를 시작합니다 (ID를 비우면 목록을 보여줍니다)',
    type: SLASH,
    options: [
      {
        type: STRING,
        name: '스토리',
        description: '시작할 스토리의 ID',
        required: false,
        max_length: 64,
      },
    ],
  },
  {
    name: '이어하기',
    description: '진행 중인 이야기를 이어서 합니다',
    type: SLASH,
  },
  {
    name: '포기',
    description: '진행 중인 이야기를 포기합니다',
    type: SLASH,
  },
];

// ═════════════════════════════════════════════
// bot/discord: 디스코드 API 상수와 응답 만들기 도구
// ═════════════════════════════════════════════

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 };
export const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, UPDATE_MESSAGE: 7 };
export const ComponentType = { ACTION_ROW: 1, BUTTON: 2 };
export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };

const EPHEMERAL = 64; // 이 플래그가 있으면 메시지를 누른 본인에게만 보인다

// 모든 응답에 멘션 차단: 제작자가 쓴 @everyone 같은 글이 실제로 울리지 않게 한다
const NO_MENTIONS = { parse: [] };

/** 새 메시지로 응답 (본인에게만 보임) */
export function reply(data) {
  return {
    type: ResponseType.CHANNEL_MESSAGE,
    data: { ...data, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS },
  };
}

/** 버튼이 붙은 기존 메시지를 새 내용으로 교체 */
export function update(data) {
  return {
    type: ResponseType.UPDATE_MESSAGE,
    data: { ...data, allowed_mentions: NO_MENTIONS },
  };
}

/** 오류 안내 (본인에게만 보이는 새 메시지, 기존 메시지는 그대로 둔다) */
export function errorReply(message) {
  return reply({ content: `⚠️ ${message}`, embeds: [], components: [] });
}

/** 기존 메시지를 글자만 남기고 교체 (임베드/버튼 제거) */
export function textUpdate(message) {
  return update({ content: message, embeds: [], components: [] });
}

/** 슬래시 커맨드/버튼을 누른 유저 정보 (서버 안에서는 member.user, DM에서는 user) */
export function getInteractionUser(interaction) {
  const user = interaction.member?.user ?? interaction.user ?? {};
  return {
    id: String(user.id ?? ''),
    username: String(user.global_name ?? user.username ?? '알 수 없음').slice(0, 80),
    avatar: user.avatar ?? null,
  };
}

/** 슬래시 커맨드의 문자열 옵션 값 읽기 */
export function getStringOption(interaction, name) {
  const option = interaction.data?.options?.find((item) => item.name === name);
  return typeof option?.value === 'string' ? option.value : null;
}

// ═════════════════════════════════════════════
// bot/verify: 디스코드 요청 서명 검증 (Ed25519, Node 내장 crypto만 사용)
// ═════════════════════════════════════════════

// Ed25519 공개키(32바이트)를 Node가 읽을 수 있는 DER 형식으로 감싸는 고정 머리말
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * @param {string} rawBody      가공하지 않은 요청 본문 문자열
 * @param {string} signature    x-signature-ed25519 헤더 (hex)
 * @param {string} timestamp    x-signature-timestamp 헤더
 * @param {string} publicKeyHex 디스코드 개발자 포털의 Public Key (hex)
 * @returns {boolean}
 */
export function verifyDiscordSignature(rawBody, signature, timestamp, publicKeyHex) {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return cryptoVerify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signature, 'hex'));
  } catch {
    return false; // 형식이 이상한 값은 전부 "가짜 요청"으로 처리
  }
}

// ═════════════════════════════════════════════
// bot/render: 엔진 결과를 디스코드 메시지(임베드 + 버튼)로 바꾼다. (순수 함수)
// ═════════════════════════════════════════════

const COLORS = { normal: 0x5865f2, good: 0x57f287, bad: 0xed4245, hidden: 0xfee75c };
const ENDING_LABEL = { good: '굿 엔딩', bad: '배드 엔딩', hidden: '히든 엔딩' };
const MAX_BUTTONS = 5; // 버튼 한 줄 최대 5개

/** 디스코드 글자수 제한에 맞춰 자른다 */
export function truncate(text, max) {
  const str = String(text ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

// 이미지는 https 주소만 허용 (javascript: 같은 위험한 주소 차단)
function safeImageUrl(url) {
  if (typeof url !== 'string' || url.length > 500) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// 제작자 표시: 디스코드 유저 ID면 멘션, 아니면(샘플 등) 글자로
function authorText(authorId) {
  return /^\d{5,25}$/.test(String(authorId)) ? `<@${authorId}>` : '운영자';
}

// 스탯/자원/파벌/소지품 필드 만들기
function stateFields(config, state) {
  const fields = [];
  const groups = [['stats', '상태'], ['resources', '자원'], ['factions', '파벌']];
  for (const [bucket, title] of groups) {
    const parts = Object.entries(config?.[bucket] ?? {}).map(
      ([key, def]) => `**${truncate(def.label ?? key, 20)}** ${state[bucket]?.[key] ?? 0}`
    );
    if (parts.length > 0) fields.push({ name: title, value: truncate(parts.join(' · '), 1024), inline: false });
  }
  const items = Object.entries(state.inventory ?? {}).map(
    ([key, count]) => `${truncate(config?.items?.[key]?.label ?? key, 20)} ×${count}`
  );
  fields.push({ name: '소지품', value: truncate(items.length ? items.join(', ') : '없음', 1024), inline: false });
  return fields;
}

/**
 * 장면 1개를 메시지로 만든다.
 * 버튼 custom_id = c:<스토리ID>:<턴>:<선택지번호>  (100자 제한 안에 들어간다)
 * 턴 번호 덕분에 예전 메시지의 버튼이나 더블클릭을 걸러낼 수 있다.
 */
export function sceneMessage({ story, scene, state, config = {}, changes = [] }) {
  const ending = state.ending;
  const choices = getAvailableChoices(config, state, scene);

  const embed = {
    title: truncate(ending ? `🏁 ${ENDING_LABEL[ending.type] ?? '엔딩'}: ${ending.name}` : story.title, 256),
    description: truncate(scene.body || '(본문 없음)', 3800),
    color: ending ? (COLORS[ending.type] ?? COLORS.normal) : COLORS.normal,
    fields: [],
    footer: {
      text: truncate(
        [state.station ? `📍 ${state.station}` : null, `${state.turn}턴`, ending ? story.title : null]
          .filter(Boolean)
          .join(' · '),
        2000
      ),
    },
  };

  const image = safeImageUrl(scene.imageUrl);
  if (image) embed.image = { url: image };

  // 방금 일어난 변화 (플래그는 스포일러가 될 수 있어 숨긴다)
  const changeLines = changes
    .filter((change) => change.type !== 'flag')
    .slice(0, 10)
    .map((change) => `${truncate(change.label, 30)} ${change.from} → ${change.to}`);
  if (changeLines.length > 0) {
    embed.fields.push({ name: '변화', value: truncate(changeLines.join('\n'), 1024), inline: false });
  }

  embed.fields.push(...stateFields(config, state));

  // 잠긴 선택지의 사유
  const locked = choices.filter((choice) => !choice.enabled);
  if (locked.length > 0) {
    const lines = locked.map((choice) => `🔒 ${truncate(choice.label, 40)} — ${choice.lockedReason}`);
    embed.fields.push({ name: '잠긴 선택지', value: truncate(lines.join('\n'), 1024), inline: false });
  }

  // 엔딩이면 버튼을 모두 제거
  if (ending) return { content: '', embeds: [embed], components: [] };

  if (choices.length === 0) {
    embed.description += '\n\n⚠️ 이 장면에는 선택지가 없습니다. /포기 로 나갈 수 있습니다.';
  }

  const buttons = choices.slice(0, MAX_BUTTONS).map((choice) => ({
    type: ComponentType.BUTTON,
    style: choice.enabled ? ButtonStyle.PRIMARY : ButtonStyle.SECONDARY,
    label: truncate(`${choice.enabled ? '' : '🔒 '}${choice.label || '(선택)'}`, 80),
    custom_id: `c:${story.id}:${state.turn}:${choice.index}`,
    disabled: !choice.enabled,
  }));

  return {
    content: '',
    embeds: [embed],
    components: buttons.length > 0 ? [{ type: ComponentType.ACTION_ROW, components: buttons }] : [],
  };
}

/** 공개 스토리 목록 (최대 5개, 각 스토리마다 시작 버튼) */
export function storyListMessage(stories, query = '') {
  if (stories.length === 0) {
    const content = query
      ? `'${truncate(query, 30)}' 검색 결과가 없습니다.`
      : '아직 공개된 스토리가 없습니다.';
    return { content, embeds: [], components: [] };
  }

  const lines = stories.map((story, i) => {
    const tags = Array.isArray(story.tags) && story.tags.length > 0 ? ` · ${story.tags.slice(0, 3).join(', ')}` : '';
    return (
      `**${i + 1}. ${truncate(story.title, 60)}**\n` +
      `${truncate(story.description || '설명 없음', 100)}\n` +
      `제작자 ${authorText(story.authorId)} · 플레이 ${story.playCount ?? 0}회 · ❤️ ${story.likeCount ?? 0}${tags}`
    );
  });

  const buttons = stories.slice(0, MAX_BUTTONS).map((story, i) => ({
    type: ComponentType.BUTTON,
    style: ButtonStyle.SUCCESS,
    label: truncate(`▶ ${i + 1}. ${story.title}`, 80),
    custom_id: `s:${story.id}`,
  }));

  return {
    content: '',
    embeds: [{ title: '📚 스토리 목록', description: truncate(lines.join('\n\n'), 4000), color: COLORS.normal }],
    components: [{ type: ComponentType.ACTION_ROW, components: buttons }],
  };
}

/**
 * 진행 중인 세션 목록. mode = 'resume'(이어하기) | 'abandon'(포기)
 * items = [{ storyId, storyTitle }]
 */
export function sessionListMessage(items, mode) {
  const isResume = mode === 'resume';
  const lines = items.map((item, i) => `${i + 1}. ${truncate(item.storyTitle, 60)}`);
  const buttons = items.slice(0, MAX_BUTTONS).map((item, i) => ({
    type: ComponentType.BUTTON,
    style: isResume ? ButtonStyle.PRIMARY : ButtonStyle.DANGER,
    label: truncate(`${isResume ? '▶' : '❌'} ${i + 1}. ${item.storyTitle}`, 80),
    custom_id: `${isResume ? 'r' : 'x'}:${item.storyId}`,
  }));

  return {
    content: '',
    embeds: [
      {
        title: isResume ? '▶ 이어서 할 이야기를 고르세요' : '❌ 포기할 이야기를 고르세요',
        description: truncate(lines.join('\n'), 4000),
        color: isResume ? COLORS.normal : COLORS.bad,
      },
    ],
    components: [{ type: ComponentType.ACTION_ROW, components: buttons }],
  };
}

/** 이미 진행 중인 스토리를 다시 시작하려 할 때: 이어하기 버튼을 안내 */
export function resumeOfferMessage(story) {
  return {
    content: `이미 **${truncate(story.title, 60)}** 을(를) 플레이 중입니다. 이어서 하시겠어요?\n(처음부터 다시 하려면 /포기 후 다시 시작하세요)`,
    embeds: [],
    components: [
      {
        type: ComponentType.ACTION_ROW,
        components: [
          { type: ComponentType.BUTTON, style: ButtonStyle.PRIMARY, label: '▶ 이어하기', custom_id: `r:${story.id}` },
        ],
      },
    ],
  };
}

// ═════════════════════════════════════════════
// bot/store: Firestore 읽기/쓰기. 상태 변경은 트랜잭션으로 처리한다.
// ═════════════════════════════════════════════

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

// ─────────────────────────────────────────────
// 6단계: 공개 스토리 검색 / 좋아요 / 엔딩 도감
// ─────────────────────────────────────────────

export const BROWSE = {
  FETCH_MAX: 200,   // 한 번에 읽어 오는 최신 공개 스토리 수 (검색 대상 범위)
  PAGE_SIZE: 20,    // 웹 한 페이지에 보여줄 개수
  CACHE_MS: 60_000, // 서버 메모리 캐시 유지 시간 (Firestore 읽기 비용 절약)
  QUERY_MAX: 50,    // 검색어 최대 길이
  TAGS_MAX: 30,     // 태그 필터 목록에 보여줄 최대 개수
};

// 인스턴스(서버리스 실행 환경) 메모리 안의 캐시
let publicCache = { at: 0, stories: null };

/** 캐시를 비운다. (좋아요 직후 호출해서 숫자가 바로 반영되게 한다) */
export function clearPublicCache() {
  publicCache = { at: 0, stories: null };
}

// 최신 공개 스토리 N개를 읽는다. (기존 인덱스 isPublic + createdAt desc 를 그대로 사용)
async function loadPublicStories() {
  const now = Date.now();
  if (publicCache.stories && now - publicCache.at < BROWSE.CACHE_MS) return publicCache.stories;

  const snap = await getDb()
    .collection(COL.STORIES)
    .where('isPublic', '==', true)
    .orderBy('createdAt', 'desc')
    .limit(BROWSE.FETCH_MAX)
    .get();
  const stories = snap.docs.map((doc) => summarize(doc.id, doc.data()));
  publicCache = { at: now, stories };
  return stories;
}

/**
 * 순수 함수: 목록에서 검색어/태그로 거르고, 정렬하고, 페이지를 자른다. (테스트하기 쉽게 DB와 분리)
 * @returns {{ stories, total, tags }}  tags = [{ tag, count }] 많이 쓰인 순
 */
export function filterPublicStories(all, { q = '', tag = '', sort = 'latest', offset = 0, limit = BROWSE.PAGE_SIZE } = {}) {
  const needle = String(q).trim().toLowerCase();
  const tagNeedle = String(tag).trim().toLowerCase();
  const text = (value) => String(value ?? '').toLowerCase();

  let list = all.filter((story) => {
    const tags = Array.isArray(story.tags) ? story.tags : [];
    if (tagNeedle && !tags.some((t) => text(t) === tagNeedle)) return false;
    if (!needle) return true;
    return text(story.title).includes(needle) || text(story.description).includes(needle) || tags.some((t) => text(t).includes(needle));
  });

  if (sort === 'popular') {
    // 좋아요 → 플레이 수 → 최신 순
    list = [...list].sort(
      (a, b) => (b.likeCount ?? 0) - (a.likeCount ?? 0) || (b.playCount ?? 0) - (a.playCount ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );
  }

  // 태그 목록은 "검색 전체 범위" 기준으로 센다 (필터를 걸어도 다른 태그를 고를 수 있게)
  const counts = new Map();
  for (const story of all) {
    for (const t of Array.isArray(story.tags) ? story.tags : []) {
      const key = text(t);
      const prev = counts.get(key) ?? { tag: t, count: 0 };
      counts.set(key, { tag: prev.tag, count: prev.count + 1 });
    }
  }
  const tags = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, BROWSE.TAGS_MAX);

  return { stories: list.slice(offset, offset + limit), total: list.length, tags };
}

/** 공개 스토리 검색 (웹 둘러보기 + 디스코드 /스토리목록 공용) */
export async function searchPublicStories(options = {}) {
  return filterPublicStories(await loadPublicStories(), options);
}

/** 좋아요 켜기/끄기. 이미 그 상태면 아무것도 바꾸지 않는다. (여러 번 눌러도 안전) */
export async function setLike(userId, storyId, liked) {
  const db = getDb();
  const likeRef = db.collection(COL.LIKES).doc(userStoryKey(userId, storyId)); // 문서 ID = 유저+스토리 → 중복 불가능

  return db.runTransaction(async (tx) => {
    const [storySnap, likeSnap] = await Promise.all([tx.get(refs.story(storyId)), tx.get(likeRef)]);
    // 없는 스토리와 비공개 스토리는 똑같이 "없음"으로 처리 (존재 여부 숨김)
    if (!storySnap.exists || !storySnap.get('isPublic')) return { ok: false, code: 'NO_STORY' };

    let likeCount = storySnap.get('likeCount') ?? 0;
    if (liked && !likeSnap.exists) {
      tx.set(likeRef, { userId, storyId, createdAt: Date.now() });
      tx.update(refs.story(storyId), { likeCount: FieldValue.increment(1) });
      likeCount += 1;
    } else if (!liked && likeSnap.exists) {
      tx.delete(likeRef);
      tx.update(refs.story(storyId), { likeCount: FieldValue.increment(-1) });
      likeCount = Math.max(0, likeCount - 1);
    }
    return { ok: true, liked, likeCount };
  });
}

/** 이 유저가 좋아요한 스토리 ID 모음 (목록 한 페이지분을 한 번에 조회) */
export async function getLikedSet(userId, storyIds) {
  if (!userId || storyIds.length === 0) return new Set();
  const db = getDb();
  const snaps = await db.getAll(...storyIds.map((id) => db.collection(COL.LIKES).doc(userStoryKey(userId, id))));
  return new Set(snaps.filter((snap) => snap.exists).map((snap) => snap.get('storyId')));
}

/** 제작자 이름 조회 (users 문서). 없는 사람은 맵에 안 들어간다 */
export async function getUserNames(userIds) {
  const ids = [...new Set(userIds)].filter((id) => /^\d{5,25}$/.test(String(id)));
  if (ids.length === 0) return new Map();
  const db = getDb();
  const snaps = await db.getAll(...ids.map((id) => db.collection(COL.USERS).doc(id)));
  return new Map(snaps.filter((snap) => snap.exists).map((snap) => [snap.id, snap.get('username')]));
}

/**
 * 스토리 1개의 엔딩 도감. 못 본 엔딩의 이름/종류는 스포일러라서 내려주지 않고 "개수"만 알려준다.
 * 스토리가 없거나 볼 권한이 없으면 null
 */
export async function getEndingBook(userId, storyId) {
  const storySnap = await refs.story(storyId).get();
  if (!storySnap.exists) return null;
  const story = storySnap.data();
  if (!story.isPublic && story.authorId !== userId) return null;

  const [endingScenes, seenSnap] = await Promise.all([
    refs.story(storyId).collection(COL.SCENES).where('isEnding', '==', true).select('endingName', 'endingType').get(),
    refs.ending(userId, storyId).get(),
  ]);
  const seenMap = seenSnap.exists ? (seenSnap.get('endings') ?? {}) : {};

  const seen = [];
  for (const doc of endingScenes.docs) {
    if (!Object.hasOwn(seenMap, doc.id)) continue; // 지금도 존재하는 엔딩만 센다 (삭제된 장면은 제외)
    seen.push({
      sceneId: doc.id,
      name: doc.get('endingName') ?? doc.id,
      type: doc.get('endingType') ?? null,
      seenAt: Number(seenMap[doc.id]) || 0,
    });
  }
  seen.sort((a, b) => b.seenAt - a.seenAt);

  return { storyId, title: story.title, total: endingScenes.size, seenCount: seen.length, seen };
}

/** 내가 엔딩을 본 적 있는 스토리들의 도감 (최대 max개. 스토리마다 읽기가 늘어서 제한) */
export async function listMyEndingBooks(userId, max = 20) {
  const snap = await getDb().collection(COL.ENDINGS).where('userId', '==', userId).limit(max).get();
  const books = await Promise.all(snap.docs.map((doc) => getEndingBook(userId, doc.get('storyId'))));
  return books.filter(Boolean).sort((a, b) => b.seenCount - a.seenCount);
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
    // 버튼의 턴과 저장된 턴이 다르면 오래된 버튼 → 거절
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

// ═════════════════════════════════════════════
// bot/handlers: 디스코드 상호작용(슬래시 커맨드, 버튼) 처리
// 버튼 custom_id 규칙:
//   s:<스토리ID>               목록에서 시작
//   c:<스토리ID>:<턴>:<번호>   선택지 선택
//   r:<스토리ID>               이어하기
//   x:<스토리ID>               포기
// ═════════════════════════════════════════════

// 스토리 ID로 허용하는 글자 (Firestore 문서 ID와 custom_id에 안전한 문자만)
const STORY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const START_ERRORS = {
  NO_STORY: '스토리를 찾을 수 없습니다.',
  FORBIDDEN: '비공개 스토리입니다.',
  NO_START: '이 스토리는 시작 장면이 없어 플레이할 수 없습니다.',
};

/** 진입점: 상호작용 종류에 따라 나눠서 처리 */
export async function handleInteraction(interaction) {
  if (interaction.type === InteractionType.APPLICATION_COMMAND) return handleCommand(interaction);
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) return handleComponent(interaction);
  return errorReply('지원하지 않는 요청입니다.');
}

// respond = reply(새 메시지) 또는 update(기존 메시지 교체)
async function startFlow(user, storyId, respond) {
  const result = await startSession(user, storyId);
  if (result.code === 'ALREADY_ACTIVE') return respond(resumeOfferMessage(result.story));
  if (!result.ok) return errorReply(START_ERRORS[result.code] ?? result.message ?? '시작하지 못했습니다.');
  return respond(
    sceneMessage({
      story: result.story,
      scene: result.scene,
      state: result.state,
      config: result.story.config,
      changes: result.changes,
    })
  );
}

async function resumeFlow(user, storyId, respond) {
  const view = await getSessionView(user.id, storyId);
  if (!view) return errorReply('진행 중인 이야기를 찾을 수 없습니다. /스토리목록 으로 새로 시작하세요.');
  return respond(
    sceneMessage({
      story: view.story,
      scene: view.scene,
      state: view.session.state,
      config: view.story.config,
    })
  );
}

async function handleCommand(interaction) {
  const user = getInteractionUser(interaction);
  if (!user.id) return errorReply('유저 정보를 확인할 수 없습니다.');

  switch (interaction.data?.name) {
    case '스토리목록': {
      const query = (getStringOption(interaction, '검색어') ?? '').trim().slice(0, BROWSE.QUERY_MAX);
      const { stories } = await searchPublicStories({ q: query, limit: 5 }); // 버튼이 한 줄 5개라서 5개
      return reply(storyListMessage(stories, query));
    }

    case '플레이': {
      const storyId = getStringOption(interaction, '스토리')?.trim();
      if (!storyId) return reply(storyListMessage((await searchPublicStories({ limit: 5 })).stories));
      if (!STORY_ID_PATTERN.test(storyId)) return errorReply('올바르지 않은 스토리 ID입니다.');
      return startFlow(user, storyId, reply);
    }

    case '이어하기': {
      const sessions = await listActiveSessions(user.id);
      if (sessions.length === 0) return errorReply('진행 중인 이야기가 없습니다. /스토리목록 으로 시작해 보세요.');
      if (sessions.length === 1) return resumeFlow(user, sessions[0].storyId, reply);
      return reply(sessionListMessage(sessions, 'resume'));
    }

    case '포기': {
      const sessions = await listActiveSessions(user.id);
      if (sessions.length === 0) return errorReply('포기할 이야기가 없습니다.');
      // 목록의 버튼을 누르는 것이 곧 확인 절차
      return reply(sessionListMessage(sessions, 'abandon'));
    }

    default:
      return errorReply('알 수 없는 명령어입니다.');
  }
}

async function handleComponent(interaction) {
  const user = getInteractionUser(interaction);
  if (!user.id) return errorReply('유저 정보를 확인할 수 없습니다.');

  const parts = String(interaction.data?.custom_id ?? '').split(':');
  const kind = parts[0];
  const storyId = parts[1] ?? '';
  if (!STORY_ID_PATTERN.test(storyId)) return errorReply('올바르지 않은 버튼입니다.');

  switch (kind) {
    case 's':
      return startFlow(user, storyId, update);

    case 'r':
      return resumeFlow(user, storyId, update);

    case 'x': {
      const done = await abandonSession(user.id, storyId);
      return textUpdate(done ? '🏳️ 포기했습니다. /스토리목록 으로 다른 이야기를 시작해 보세요.' : '이미 끝났거나 진행 중인 이야기가 아닙니다.');
    }

    case 'c': {
      const turn = Number(parts[2]);
      const index = Number(parts[3]);
      if (!Number.isInteger(turn) || !Number.isInteger(index)) return errorReply('올바르지 않은 버튼입니다.');

      const result = await chooseInSession(user.id, storyId, turn, index);
      if (result.ok) {
        return update(
          sceneMessage({
            story: result.story,
            scene: result.scene,
            state: result.state,
            config: result.story.config,
            changes: result.changes,
          })
        );
      }
      // 오래된 버튼: 오류를 띄우지 않고 최신 장면으로 메시지를 갱신
      if (result.code === 'STALE') return resumeFlow(user, storyId, update);
      if (result.code === 'NO_SESSION') {
        return textUpdate('진행 중인 이야기가 없습니다. /스토리목록 으로 새로 시작하세요.');
      }
      return errorReply(result.message ?? '선택을 처리하지 못했습니다.');
    }

    default:
      return errorReply('알 수 없는 버튼입니다.');
  }
}

// ═════════════════════════════════════════════════════════════════════════
// web (4단계): 디스코드 OAuth2 로그인, JWT 쿠키, 스토리/장면 CRUD, 입력 검증, 공개 전환, 삭제 정리
// api/index.js 가 createWebRouter() 를 불러 Express 앱에 붙인다. (함수 개수를 늘리지 않기 위해)
// 새 패키지는 필요 없다. (JWT, 쿠키 해석은 Node 내장 crypto로 직접 구현)
// ═════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════
// 설정값
// ═════════════════════════════════════════════

export const WEB = {
  SESSION_COOKIE: 'h2033_session', // 로그인 유지용 JWT 쿠키
  STATE_COOKIE: 'h2033_state',     // 로그인 도중에만 쓰는 CSRF 방지용 임시 쿠키
  SESSION_DAYS: 7,                 // 로그인 유지 기간
  MAX_STORIES_PER_USER: 30,        // 한 사람이 만들 수 있는 스토리 수 (서버 비용 폭주 방지)
  CSRF_HEADER: 'x-requested-with', // 쓰기 요청에 반드시 붙여야 하는 헤더 이름
  CSRF_VALUE: 'haejung',           // 위 헤더의 값
};

// STORY_ID_PATTERN 은 bot/handlers 에서 선언한 것을 그대로 쓴다.
const KEY_PATTERN = SCENE_ID_PATTERN;             // 스탯/아이템/플래그 키도 장면 키와 같은 규칙
const DISCORD_ID_PATTERN = /^\d{5,25}$/;

// 입력 제한값 (디스코드 표시 제한과 Firestore 문서 크기를 고려한 값)
const MAX = {
  LABEL: 20,        // 스탯/아이템/플래그 이름 (봇이 20자로 자름)
  STATION: 40,      // 역 이름
  ENDING_NAME: 50,  // 엔딩 이름
  IMAGE_URL: 500,   // 이미지 주소
  ENTRIES: 10,      // 장면 진입 효과 / 선택지 조건 / 선택지 효과 개수
  BUCKET: 20,       // 스탯, 자원, 파벌 각각의 최대 종류 수
  DEFS: 50,         // 아이템, 플래그 최대 종류 수
  NUMBER: 100000,   // 숫자 값의 절대값 상한
  POSITION: 100000, // 에디터 노드 좌표 상한
};

// 새 스토리의 기본 설정 (체력 하나만 있는 가장 단순한 상태)
const DEFAULT_CONFIG = {
  stats: { hp: { label: '체력', initial: 100, min: 0, max: 100 } },
};

// DEFAULT_RANGE 는 engine/state 에서 선언한 것을 그대로 쓴다. (min/max 생략 시 엔진과 같은 기본 범위)

const ENTRY_TYPES = ['stat', 'resource', 'faction', 'item', 'flag'];
const COND_OPS = ['>=', '<=', '>', '<', '==', '!='];
const ENDING_TYPES = ['good', 'bad', 'hidden'];

// ═════════════════════════════════════════════
// 작은 도구들: 오류 클래스, 쿠키 해석, 상수 시간 비교
// ═════════════════════════════════════════════

// 라우트 안에서 throw 하면 wrap()이 알맞은 HTTP 응답으로 바꿔준다.
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// async 라우트의 오류를 Express로 넘겨주는 감싸개 (Express 4/5 모두 안전)
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...err.extra });
    }
    next(err);
  }
};

/** Cookie 헤더 문자열을 { 이름: 값 } 으로 바꾼다. (cookie-parser 없이 직접 구현) */
export function parseCookies(header) {
  const out = Object.create(null); // __proto__ 같은 이름의 쿠키가 와도 안전
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (!name || name in out) continue; // 같은 이름이 여러 개면 첫 번째만 사용
    let value = part.slice(idx + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // 해석 실패 시 원문 그대로 사용
    }
    out[name] = value;
  }
  return out;
}

// 두 문자열을 같은 시간에 비교 (비교 시간 차이로 값을 추측하는 공격 방지)
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ═════════════════════════════════════════════
// JWT (HS256): 서명된 로그인 토큰. 서버가 세션을 저장하지 않아도 되는 서버리스용 방식
// ═════════════════════════════════════════════

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET 환경 변수가 없거나 32자보다 짧습니다. .env를 확인하세요.');
  }
  return secret;
}

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');

/** 토큰을 만든다. exp(만료 시각)는 자동으로 넣는다. */
export function signJwt(payload, ttlSec = WEB.SESSION_DAYS * 86400, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat, exp: iat + ttlSec }));
  const sig = createHmac('sha256', getSecret()).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** 토큰을 검사한다. 올바르면 payload, 아니면(위조/만료/형식 오류) null */
export function verifyJwt(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const secret = getSecret();

  try {
    // alg가 HS256이 아닌 토큰(예: "none")은 무조건 거절
    if (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════
// 입력 검증/정리(sanitize): 서버는 클라이언트를 믿지 않는다.
// - 모양과 길이를 검사하고, 알려진 필드만 뽑아서 새 객체로 만든다. (모르는 필드는 버림)
// - 오류는 errors 배열에 한국어 문장으로 모은다. (한 번에 여러 개를 알려주기 위해)
// - XSS 방지: 서버는 글자를 "그대로" 저장하고, 화면(5단계)에서는 반드시 textContent/React로 출력한다.
//   (저장할 때 HTML 이스케이프를 하면 이중 변환이 생기므로 출력 쪽에서 막는 것이 원칙)
// ═════════════════════════════════════════════

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 제어문자, 글자 방향을 뒤집는 문자(제목 위장에 쓰임), BOM 제거
const STRIP_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩﻿]/g;

// 글자 값 정리. 길이를 넘으면 errors에 기록한다.
function cleanText(value, max, path, errors, { required = false, multiline = false } = {}) {
  if (value === undefined || value === null) {
    if (required) errors.push(`${path}: 필수 항목입니다.`);
    return '';
  }
  if (typeof value !== 'string') {
    errors.push(`${path}: 글자여야 합니다.`);
    return '';
  }
  let text = value.replace(STRIP_CHARS, '').replace(/\r\n?/g, '\n');
  if (!multiline) text = text.replace(/\n/g, ' '); // 한 줄짜리 항목은 줄바꿈을 공백으로
  text = text.trim();
  if (required && !text) errors.push(`${path}: 비어 있을 수 없습니다.`);
  if (text.length > max) {
    errors.push(`${path}: ${max}자를 넘을 수 없습니다.`);
    return text.slice(0, max);
  }
  return text;
}

// 숫자 값 검사 (NaN, Infinity, 문자열 숫자 거절)
function cleanNumber(value, min, max, path, errors, { int = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${path}: 숫자여야 합니다.`);
    return null;
  }
  if (int && !Number.isInteger(value)) {
    errors.push(`${path}: 정수여야 합니다.`);
    return null;
  }
  if (value < min || value > max) {
    errors.push(`${path}: ${min} ~ ${max} 사이여야 합니다.`);
    return null;
  }
  return value;
}

// 키(스탯/아이템/플래그/장면 이름)가 안전한 형식인지
const isValidKey = (key) => typeof key === 'string' && isSafeKey(key) && KEY_PATTERN.test(key);

// 이미지 주소: 비어 있으면 null, 값이 있으면 https만 허용
function cleanImageUrl(value, path, errors) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX.IMAGE_URL) {
    errors.push(`${path}: ${MAX.IMAGE_URL}자 이하의 주소여야 합니다.`);
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') throw new Error('not https');
    if (url.username || url.password) throw new Error('credentials');
    if (url.href.length > MAX.IMAGE_URL) throw new Error('too long');
    return url.href;
  } catch {
    errors.push(`${path}: https:// 로 시작하는 올바른 주소여야 합니다.`);
    return null;
  }
}

// 배열 정리 도우미: 없으면 빈 배열, 너무 길면 오류
function cleanList(value, max, path, errors, cleaner) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path}: 목록이어야 합니다.`);
    return [];
  }
  if (value.length > max) {
    errors.push(`${path}: 최대 ${max}개까지 가능합니다.`);
    return [];
  }
  return value.map((item, i) => cleaner(item, `${path}[${i + 1}]`, errors)).filter(Boolean);
}

// 선택지 조건 1개. 예) { type:'item', key:'gasmask' }, { type:'stat', key:'hp', op:'>=', value:30 }
function cleanCondition(cond, path, errors) {
  if (!isPlainObject(cond)) return void errors.push(`${path}: 객체여야 합니다.`);
  if (!ENTRY_TYPES.includes(cond.type)) return void errors.push(`${path}.type: ${ENTRY_TYPES.join('/')} 중 하나여야 합니다.`);
  if (!isValidKey(cond.key)) return void errors.push(`${path}.key: 영문/숫자/_/- 40자 이하여야 합니다.`);

  if (cond.type === 'flag') {
    if (cond.value !== undefined && typeof cond.value !== 'boolean') errors.push(`${path}.value: true/false여야 합니다.`);
    return { type: 'flag', key: cond.key, value: cond.value !== false };
  }

  const op = cond.op ?? '>=';
  if (!COND_OPS.includes(op)) errors.push(`${path}.op: ${COND_OPS.join(' ')} 중 하나여야 합니다.`);
  // 아이템은 value를 생략하면 "1개 이상"으로 본다 (엔진 규칙과 동일)
  const raw = cond.type === 'item' && cond.value === undefined ? 1 : cond.value;
  const value = cleanNumber(raw, -MAX.NUMBER, MAX.NUMBER, `${path}.value`, errors);
  return { type: cond.type, key: cond.key, op, value };
}

// 효과 1개. 예) { type:'resource', key:'food', delta:-1 }, { type:'flag', key:'traded', value:true }
function cleanEffect(effect, path, errors) {
  if (!isPlainObject(effect)) return void errors.push(`${path}: 객체여야 합니다.`);
  if (!ENTRY_TYPES.includes(effect.type)) return void errors.push(`${path}.type: ${ENTRY_TYPES.join('/')} 중 하나여야 합니다.`);
  if (!isValidKey(effect.key)) return void errors.push(`${path}.key: 영문/숫자/_/- 40자 이하여야 합니다.`);

  if (effect.type === 'flag') {
    if (effect.value !== undefined && typeof effect.value !== 'boolean') errors.push(`${path}.value: true/false여야 합니다.`);
    return { type: 'flag', key: effect.key, value: effect.value !== false };
  }
  const delta = cleanNumber(effect.delta, -MAX.NUMBER, MAX.NUMBER, `${path}.delta`, errors, { int: true });
  return { type: effect.type, key: effect.key, delta };
}

/** config(스탯/자원/파벌/아이템/플래그/시작 소지품)를 검증하고 새 객체로 만든다. */
export function sanitizeConfig(input, errors, path = 'config') {
  const out = { stats: {}, resources: {}, factions: {}, items: {}, flags: {}, startInventory: {} };
  if (input === undefined || input === null) return out;
  if (!isPlainObject(input)) {
    errors.push(`${path}: 객체여야 합니다.`);
    return out;
  }

  // 숫자 항목 (스탯, 자원, 파벌)
  for (const bucket of ['stats', 'resources', 'factions']) {
    const source = input[bucket];
    if (source === undefined || source === null) continue;
    if (!isPlainObject(source)) {
      errors.push(`${path}.${bucket}: 객체여야 합니다.`);
      continue;
    }
    const entries = Object.entries(source);
    if (entries.length > MAX.BUCKET) {
      errors.push(`${path}.${bucket}: 최대 ${MAX.BUCKET}종류까지 가능합니다.`);
      continue;
    }
    const [defMin, defMax] = DEFAULT_RANGE[bucket];

    for (const [key, def] of entries) {
      const where = `${path}.${bucket}.${String(key).slice(0, 40)}`;
      if (!isValidKey(key)) {
        errors.push(`${where}: 키는 영문/숫자/_/- 40자 이하여야 합니다.`);
        continue;
      }
      if (!isPlainObject(def)) {
        errors.push(`${where}: 객체여야 합니다.`);
        continue;
      }
      const label = cleanText(def.label ?? key, MAX.LABEL, `${where}.label`, errors, { required: true });
      const min = def.min === undefined ? defMin : cleanNumber(def.min, -MAX.NUMBER, MAX.NUMBER, `${where}.min`, errors);
      const max = def.max === undefined ? defMax : cleanNumber(def.max, -MAX.NUMBER, MAX.NUMBER, `${where}.max`, errors);
      const initial = cleanNumber(def.initial ?? 0, -MAX.NUMBER, MAX.NUMBER, `${where}.initial`, errors);

      if (min !== null && max !== null) {
        if (min > max) errors.push(`${where}: 최소값이 최대값보다 클 수 없습니다.`);
        else if (initial !== null && (initial < min || initial > max)) {
          errors.push(`${where}.initial: 최소~최대 범위 안이어야 합니다.`);
        }
      }

      const entry = { label, initial, min, max };
      // onZero: 이 스탯이 최소값 이하가 되면 이동할 장면 (스탯에만 허용)
      if (bucket === 'stats' && def.onZero !== undefined && def.onZero !== null && def.onZero !== '') {
        if (typeof def.onZero === 'string' && SCENE_ID_PATTERN.test(def.onZero)) entry.onZero = def.onZero;
        else errors.push(`${where}.onZero: 올바른 장면 키여야 합니다.`);
      }
      out[bucket][key] = entry;
    }
  }

  // 이름만 있는 항목 (아이템, 플래그)
  for (const bucket of ['items', 'flags']) {
    const source = input[bucket];
    if (source === undefined || source === null) continue;
    if (!isPlainObject(source)) {
      errors.push(`${path}.${bucket}: 객체여야 합니다.`);
      continue;
    }
    const entries = Object.entries(source);
    if (entries.length > MAX.DEFS) {
      errors.push(`${path}.${bucket}: 최대 ${MAX.DEFS}종류까지 가능합니다.`);
      continue;
    }
    for (const [key, def] of entries) {
      const where = `${path}.${bucket}.${String(key).slice(0, 40)}`;
      if (!isValidKey(key)) {
        errors.push(`${where}: 키는 영문/숫자/_/- 40자 이하여야 합니다.`);
        continue;
      }
      const label = cleanText(isPlainObject(def) ? (def.label ?? key) : key, MAX.LABEL, `${where}.label`, errors, { required: true });
      out[bucket][key] = { label };
    }
  }

  // 시작 소지품: 정의된 아이템만, 1~99개
  const inventory = input.startInventory;
  if (inventory !== undefined && inventory !== null) {
    if (!isPlainObject(inventory)) {
      errors.push(`${path}.startInventory: 객체여야 합니다.`);
    } else {
      for (const [key, count] of Object.entries(inventory)) {
        const where = `${path}.startInventory.${String(key).slice(0, 40)}`;
        if (!isValidKey(key) || !Object.hasOwn(out.items, key)) {
          errors.push(`${where}: items에 정의된 아이템이어야 합니다.`);
          continue;
        }
        const n = cleanNumber(count, 1, 99, where, errors, { int: true });
        if (n !== null) out.startInventory[key] = n;
      }
    }
  }
  return out;
}

// 장면 1개 정리
function sanitizeScene(scene, path, errors) {
  if (!isPlainObject(scene)) return void errors.push(`${path}: 객체여야 합니다.`);

  if (scene.isEnding !== undefined && typeof scene.isEnding !== 'boolean') errors.push(`${path}.isEnding: true/false여야 합니다.`);
  const isEnding = scene.isEnding === true;

  const clean = {
    body: cleanText(scene.body ?? '', LIMITS.SCENE_BODY, `${path}.body`, errors, { multiline: true }),
    imageUrl: cleanImageUrl(scene.imageUrl, `${path}.imageUrl`, errors),
    station: cleanText(scene.station ?? '', MAX.STATION, `${path}.station`, errors) || null,
    isEnding,
    endingName: null,
    endingType: null,
    onEnter: cleanList(scene.onEnter, MAX.ENTRIES, `${path}.onEnter`, errors, cleanEffect),
    choices: [],
    posX: 0,
    posY: 0,
  };

  // 에디터 노드 위치 (없으면 0)
  for (const axis of ['posX', 'posY']) {
    if (scene[axis] !== undefined) {
      clean[axis] = cleanNumber(scene[axis], -MAX.POSITION, MAX.POSITION, `${path}.${axis}`, errors) ?? 0;
    }
  }

  if (isEnding) {
    // 엔딩 장면: 이름/종류를 저장하고, 선택지는 항상 비운다
    clean.endingName = cleanText(scene.endingName ?? '', MAX.ENDING_NAME, `${path}.endingName`, errors) || null;
    if (scene.endingType !== undefined && scene.endingType !== null) {
      if (ENDING_TYPES.includes(scene.endingType)) clean.endingType = scene.endingType;
      else errors.push(`${path}.endingType: ${ENDING_TYPES.join('/')} 중 하나여야 합니다.`);
    }
    return clean;
  }

  clean.choices = cleanList(scene.choices, LIMITS.CHOICES_PER_SCENE, `${path}.choices`, errors, (choice, where) => {
    if (!isPlainObject(choice)) return void errors.push(`${where}: 객체여야 합니다.`);
    // to는 작성 중에는 비어 있을 수 있다. (끊긴 분기는 공개 전 validateStory가 오류로 잡는다)
    let to = '';
    if (choice.to !== undefined && choice.to !== null && choice.to !== '') {
      if (typeof choice.to === 'string' && SCENE_ID_PATTERN.test(choice.to)) to = choice.to;
      else errors.push(`${where}.to: 올바른 장면 키여야 합니다.`);
    }
    if (choice.hideWhenLocked !== undefined && typeof choice.hideWhenLocked !== 'boolean') {
      errors.push(`${where}.hideWhenLocked: true/false여야 합니다.`);
    }
    return {
      label: cleanText(choice.label ?? '', LIMITS.CHOICE_LABEL, `${where}.label`, errors),
      to,
      condition: cleanList(choice.condition, MAX.ENTRIES, `${where}.condition`, errors, cleanCondition),
      effects: cleanList(choice.effects, MAX.ENTRIES, `${where}.effects`, errors, cleanEffect),
      hideWhenLocked: choice.hideWhenLocked === true,
    };
  });
  return clean;
}

/** scenes 객체 전체({ 장면키: 장면 })를 검증하고 새 객체로 만든다. */
export function sanitizeScenes(input, errors, path = 'scenes') {
  const out = {};
  if (!isPlainObject(input)) {
    errors.push(`${path}: 객체여야 합니다.`);
    return out;
  }
  const entries = Object.entries(input);
  if (entries.length === 0) errors.push(`${path}: 장면이 하나 이상 필요합니다.`);
  if (entries.length > LIMITS.SCENES_PER_STORY) {
    errors.push(`${path}: 장면은 최대 ${LIMITS.SCENES_PER_STORY}개까지 가능합니다.`);
    return out;
  }
  for (const [key, scene] of entries) {
    const where = `${path}.${String(key).slice(0, 40)}`;
    if (!isValidKey(key)) {
      errors.push(`${where}: 장면 키는 영문/숫자/_/- 40자 이하여야 합니다.`);
      continue;
    }
    const clean = sanitizeScene(scene, where, errors);
    if (clean) out[key] = clean;
  }
  return out;
}

// 태그 정리: 개수/길이 제한, 중복 제거
function sanitizeTags(input, errors) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    errors.push('tags: 목록이어야 합니다.');
    return [];
  }
  if (input.length > LIMITS.TAG_COUNT) errors.push(`tags: 최대 ${LIMITS.TAG_COUNT}개까지 가능합니다.`);

  const seen = new Set();
  const out = [];
  for (const raw of input.slice(0, LIMITS.TAG_COUNT)) {
    const tag = cleanText(raw, LIMITS.TAG_LENGTH, 'tags', errors, { required: true });
    const lower = tag.toLowerCase();
    if (tag && !seen.has(lower)) {
      seen.add(lower);
      out.push(tag);
    }
  }
  return out;
}

/** 제목/설명/태그 정리. partial=true 면 "보낸 필드만" 결과에 넣는다. (수정용) */
export function sanitizeMeta(body, errors, { partial = false } = {}) {
  const out = {};
  if (!partial || body.title !== undefined) {
    out.title = cleanText(body.title, LIMITS.TITLE, 'title', errors, { required: true });
  }
  if (!partial || body.description !== undefined) {
    out.description = cleanText(body.description ?? '', LIMITS.DESCRIPTION, 'description', errors);
  }
  if (!partial || body.tags !== undefined) {
    out.tags = sanitizeTags(body.tags, errors);
  }
  return out;
}

// 장면 맵에 id를 채워서 validateStory 에 넘길 수 있는 모양으로 만든다
function withIds(scenes) {
  const out = {};
  for (const [key, scene] of Object.entries(scenes)) out[key] = { ...scene, id: key };
  return out;
}

// ═════════════════════════════════════════════
// Firestore 도우미
// ═════════════════════════════════════════════

const storyRef = (id) => getDb().collection(COL.STORIES).doc(id);
const scenesRef = (id) => storyRef(id).collection(COL.SCENES);
const plainReader = { get: (ref) => ref.get() }; // 트랜잭션 없이 읽을 때 (tx.get 과 같은 모양)

// 목록/요약에 내려줄 필드만 뽑는다 (config, scenes 제외)
function summarize(id, data) {
  return {
    id,
    authorId: data.authorId,
    title: data.title,
    description: data.description ?? '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    isPublic: Boolean(data.isPublic),
    startSceneId: data.startSceneId ?? null,
    sceneCount: data.sceneCount ?? 0,
    playCount: data.playCount ?? 0,
    likeCount: data.likeCount ?? 0,
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
  };
}

// 장면 스냅샷 → { 장면키: {...장면, id} }
function scenesFromSnap(snap) {
  const out = {};
  for (const doc of snap.docs) out[doc.id] = { ...doc.data(), id: doc.id };
  return out;
}

/**
 * 스토리를 읽고 "내 스토리인지" 확인한다. (읽기 전용. 트랜잭션 안에서도, 밖에서도 사용)
 * withScenes: 'never' | 'always' | 'ifPublic'
 * 실패하면 HttpError(404/403)를 던진다.
 */
async function readOwned(reader, storyId, userId, { withScenes = 'never' } = {}) {
  const ref = storyRef(storyId);
  const snap = await reader.get(ref);
  if (!snap.exists) throw new HttpError(404, '스토리를 찾을 수 없습니다.');
  const data = snap.data();
  if (data.authorId !== userId) {
    // 비공개 스토리는 존재 자체를 숨기고(404), 공개 스토리는 "권한 없음"(403)
    throw data.isPublic ? new HttpError(403, '본인이 만든 스토리만 수정할 수 있습니다.') : new HttpError(404, '스토리를 찾을 수 없습니다.');
  }
  const story = { ...data, id: snap.id };

  let scenesSnap = null;
  if (withScenes === 'always' || (withScenes === 'ifPublic' && story.isPublic)) {
    scenesSnap = await reader.get(scenesRef(storyId));
  }
  return {
    ref,
    story,
    scenes: scenesSnap ? scenesFromSnap(scenesSnap) : null,
    sceneRefs: scenesSnap ? scenesSnap.docs.map((doc) => doc.ref) : [],
  };
}

// 에디터가 불러온 시각(baseUpdatedAt)과 저장된 시각이 다르면 "다른 곳에서 먼저 수정됨" 오류
function checkBaseVersion(baseUpdatedAt, story) {
  if (baseUpdatedAt !== undefined && baseUpdatedAt !== story.updatedAt) {
    throw new HttpError(409, '다른 곳에서 먼저 수정되었습니다. 새로고침한 뒤 다시 저장하세요.', {
      currentUpdatedAt: story.updatedAt,
    });
  }
}

// 입력 오류가 있으면 400으로 응답
function failIfInvalid(errors) {
  if (errors.length > 0) throw new HttpError(400, '입력값이 올바르지 않습니다.', { details: errors });
}

function requireStoryId(req) {
  const id = req.params.id;
  if (!STORY_ID_PATTERN.test(id)) throw new HttpError(400, '올바르지 않은 스토리 ID입니다.');
  return id;
}

// 스토리 삭제 후 정리: 해당 스토리의 플레이 세션/엔딩 도감을 400개씩 지운다.
// 서버리스 실행 시간 제한을 고려해 최대 5번(2000개)까지만 처리하고, 남으면 false를 돌려준다.
async function deleteByStoryId(db, collection, storyId) {
  const PAGE = 400;
  for (let page = 0; page < 5; page += 1) {
    const snap = await db.collection(collection).where('storyId', '==', storyId).limit(PAGE).get();
    if (snap.empty) return true;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < PAGE) return true;
  }
  return false; // 아직 남았을 수 있음 (7단계 정리 작업에서 처리)
}

// ═════════════════════════════════════════════
// 디스코드 OAuth2 도우미
// ═════════════════════════════════════════════

const siteUrl = () => (process.env.SITE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const redirectUri = () => `${siteUrl()}/api/auth/callback`;

// 쿠키 공통 옵션: JS에서 못 읽고(httpOnly), 다른 사이트 요청에는 안 붙고(lax), HTTPS에서만 전송(secure)
const cookieBase = () => ({ httpOnly: true, sameSite: 'lax', secure: siteUrl().startsWith('https://') });

async function discordFetch(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(8000) }); // 8초 안에 응답 없으면 포기
}

// ═════════════════════════════════════════════
// 라우터
// ═════════════════════════════════════════════

export function createWebRouter() {
  const router = express.Router();

  // 로그인 관련 요청은 더 엄격하게 제한 (IP당 1분 20회)
  const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  // 쓰기 요청은 "사용자별" 1분 30회 (로그인 후에만 쓰이므로 req.user가 항상 있다)
  const writeLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `user:${req.user.id}`,
  });

  // 모든 API 응답은 캐시하지 않는다 (로그인 상태가 섞이는 것을 방지)
  router.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // CSRF 2차 방어: 글을 바꾸는 요청(POST/PUT/PATCH/DELETE)에는 직접 만든 헤더가 있어야 한다.
  // 다른 사이트의 폼/이미지는 이 헤더를 붙일 수 없고, fetch로 붙이려면 CORS 사전 확인을 통과해야 하는데
  // 이 서버는 CORS를 허용하지 않으므로 막힌다. (쿠키의 SameSite=Lax 와 함께 이중 방어)
  router.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get(WEB.CSRF_HEADER) !== WEB.CSRF_VALUE) {
      return res.status(403).json({ error: '잘못된 요청입니다.' });
    }
    next();
  });

  // 로그인 쿠키(JWT)를 읽어 req.user 를 채운다. 유효하지 않으면 null
  function readUser(req) {
    const token = parseCookies(req.headers.cookie)[WEB.SESSION_COOKIE];
    const payload = token ? verifyJwt(token) : null;
    if (!payload || !DISCORD_ID_PATTERN.test(String(payload.sub))) return null;
    return {
      id: String(payload.sub),
      username: String(payload.name ?? '').slice(0, 80),
      avatar: typeof payload.avatar === 'string' ? payload.avatar : null,
    };
  }

  const optionalAuth = (req, res, next) => {
    req.user = readUser(req);
    next();
  };

  const requireAuth = (req, res, next) => {
    req.user = readUser(req);
    if (!req.user) return res.status(401).json({ error: '로그인이 필요합니다.' });
    next();
  };

  // ───────────── 로그인 / 로그아웃 ─────────────

  // 1) 디스코드 로그인 화면으로 보낸다. state(무작위 값)를 쿠키에도 저장해 두었다가 돌아올 때 대조한다.
  router.get('/api/auth/login', authLimiter, (req, res) => {
    const clientId = process.env.DISCORD_APPLICATION_ID;
    if (!clientId || !process.env.DISCORD_CLIENT_SECRET) {
      console.error('[auth] DISCORD_APPLICATION_ID 또는 DISCORD_CLIENT_SECRET 환경 변수가 없습니다.');
      return res.status(500).json({ error: '서버 설정 오류' });
    }
    const state = randomBytes(24).toString('hex');
    res.cookie(WEB.STATE_COOKIE, state, { ...cookieBase(), maxAge: 10 * 60 * 1000, path: '/api/auth' });

    const url = new URL('https://discord.com/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: 'identify', // 유저 ID/이름/아바타만 요청 (이메일 등은 요청하지 않음)
      state,
      prompt: 'none', // 이미 승인했다면 승인 화면을 건너뜀
    }).toString();
    res.redirect(302, url.toString());
  });

  // 2) 디스코드가 되돌려 보내는 주소: state 검증 → 코드 교환 → 유저 확인 → 내 쿠키 발급
  router.get(
    '/api/auth/callback',
    authLimiter,
    wrap(async (req, res) => {
      const { code, state, error } = req.query;
      const saved = parseCookies(req.headers.cookie)[WEB.STATE_COOKIE];
      res.clearCookie(WEB.STATE_COOKIE, { ...cookieBase(), path: '/api/auth' }); // state는 한 번만 쓴다

      if (error) return res.redirect(302, '/?login=cancelled'); // 사용자가 취소
      // state 불일치 = 내가 시작하지 않은 로그인 (CSRF 의심)
      if (typeof code !== 'string' || typeof state !== 'string' || !saved || !safeEqual(state, saved)) {
        return res.redirect(302, '/?login=failed');
      }

      const tokenRes = await discordFetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_APPLICATION_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
        }),
      });
      if (!tokenRes.ok) {
        console.error('[auth] 토큰 교환 실패', tokenRes.status); // 응답 본문/비밀 값은 로그에 남기지 않음
        return res.redirect(302, '/?login=failed');
      }
      const token = await tokenRes.json();
      if (typeof token.access_token !== 'string') return res.redirect(302, '/?login=failed');

      const meRes = await discordFetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${token.access_token}` },
      });
      if (!meRes.ok) return res.redirect(302, '/?login=failed');
      const me = await meRes.json();
      if (!DISCORD_ID_PATTERN.test(String(me.id))) return res.redirect(302, '/?login=failed');

      const user = {
        id: String(me.id),
        username: String(me.global_name ?? me.username ?? '이름 없음').slice(0, 80),
        avatar: typeof me.avatar === 'string' ? me.avatar : null,
      };

      // users/{ID} 저장 (처음이면 createdAt 기록). 디스코드 액세스 토큰은 저장하지 않는다.
      const userRef = getDb().collection(COL.USERS).doc(user.id);
      const existing = await userRef.get();
      const now = Date.now();
      await userRef.set(
        { username: user.username, avatar: user.avatar, updatedAt: now, ...(existing.exists ? {} : { createdAt: now }) },
        { merge: true }
      );

      const jwt = signJwt({ sub: user.id, name: user.username, avatar: user.avatar });
      res.cookie(WEB.SESSION_COOKIE, jwt, { ...cookieBase(), maxAge: WEB.SESSION_DAYS * 86400 * 1000, path: '/' });
      res.redirect(302, '/');
    })
  );

  // 지금 로그인한 사람 (로그인 안 했으면 user: null)
  router.get('/api/auth/me', optionalAuth, (req, res) => {
    res.json({ user: req.user });
  });

  // 로그아웃: 쿠키를 지운다. (JWT는 서버에 저장하지 않으므로 만료 전까지 "유효한 토큰"이 남아 있을 수 있다. 7단계에서 보강)
  router.post('/api/auth/logout', (req, res) => {
    res.clearCookie(WEB.SESSION_COOKIE, { ...cookieBase(), path: '/' });
    res.json({ ok: true });
  });

  // ───────────── 스토리 목록 / 생성 ─────────────

  // 내 스토리 목록 (최신 수정순). 단일 필드 조건이라 복합 인덱스가 필요 없다.
  router.get(
    '/api/stories/mine',
    requireAuth,
    wrap(async (req, res) => {
      const snap = await getDb()
        .collection(COL.STORIES)
        .where('authorId', '==', req.user.id)
        .limit(WEB.MAX_STORIES_PER_USER + 20)
        .get();
      const stories = snap.docs
        .map((doc) => summarize(doc.id, doc.data()))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({ stories });
    })
  );

  // 새 스토리 만들기: 비공개 + 시작 장면 1개로 시작한다.
  router.post(
    '/api/stories',
    requireAuth,
    writeLimiter,
    wrap(async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const errors = [];
      const meta = sanitizeMeta(body, errors);
      const config = sanitizeConfig(body.config ?? DEFAULT_CONFIG, errors);
      failIfInvalid(errors);

      const db = getDb();
      const owned = await db
        .collection(COL.STORIES)
        .where('authorId', '==', req.user.id)
        .select() // 문서 내용 없이 개수만 필요
        .limit(WEB.MAX_STORIES_PER_USER + 1)
        .get();
      if (owned.size >= WEB.MAX_STORIES_PER_USER) {
        throw new HttpError(403, `스토리는 최대 ${WEB.MAX_STORIES_PER_USER}개까지 만들 수 있습니다.`);
      }

      const id = newStoryId();
      const now = Date.now();
      const startScene = {
        body: '여기에 이야기를 시작하세요.',
        imageUrl: null,
        station: null,
        isEnding: false,
        endingName: null,
        endingType: null,
        onEnter: [],
        choices: [],
        posX: 0,
        posY: 0,
      };
      const story = {
        authorId: req.user.id,
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        isPublic: false, // 새 스토리는 항상 비공개 (검증 통과 후 공개)
        startSceneId: 'start',
        config,
        likeCount: 0,
        playCount: 0,
        sceneCount: 1,
        createdAt: now,
        updatedAt: now,
      };

      const batch = db.batch();
      batch.set(storyRef(id), story);
      batch.set(scenesRef(id).doc('start'), startScene);
      await batch.commit();

      res.status(201).json({ story: { ...summarize(id, story), config }, scenes: { start: { ...startScene, id: 'start' } } });
    })
  );

  // 저장하지 않은 초안을 검증만 해본다. (에디터의 "유효성 검사" 버튼용. DB는 건드리지 않음)
  router.post(
    '/api/validate',
    requireAuth,
    writeLimiter,
    wrap(async (req, res) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const errors = [];
      const config = sanitizeConfig(body.config, errors);
      const scenes = sanitizeScenes(body.scenes, errors);
      if (typeof body.startSceneId !== 'string' || !SCENE_ID_PATTERN.test(body.startSceneId)) {
        errors.push('startSceneId: 올바른 장면 키여야 합니다.');
      }
      failIfInvalid(errors);
      res.json(validateStory({ startSceneId: body.startSceneId, config, scenes: withIds(scenes) }));
    })
  );

  // ───────────── 스토리 조회 / 수정 / 삭제 ─────────────

  // 스토리 1개 조회. 제작자 본인은 config와 장면 전체, 다른 사람은 공개 스토리의 요약만 볼 수 있다.
  router.get(
    '/api/stories/:id',
    optionalAuth,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const snap = await storyRef(id).get();
      if (!snap.exists) throw new HttpError(404, '스토리를 찾을 수 없습니다.');
      const data = snap.data();
      const isAuthor = req.user?.id === data.authorId;
      if (!data.isPublic && !isAuthor) throw new HttpError(404, '스토리를 찾을 수 없습니다.');

      if (!isAuthor) return res.json({ story: summarize(id, data) }); // 스포일러/설정 노출 방지

      const scenes = scenesFromSnap(await scenesRef(id).get());
      res.json({ story: { ...summarize(id, data), config: data.config ?? {} }, scenes });
    })
  );

  // 제목/설명/태그/설정/시작 장면 수정 (보낸 필드만 바꾼다)
  router.put(
    '/api/stories/:id',
    requireAuth,
    writeLimiter,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const body = isPlainObject(req.body) ? req.body : {};
      const errors = [];
      const changes = sanitizeMeta(body, errors, { partial: true });
      if (body.config !== undefined) changes.config = sanitizeConfig(body.config, errors);
      if (body.startSceneId !== undefined) {
        if (typeof body.startSceneId === 'string' && SCENE_ID_PATTERN.test(body.startSceneId)) changes.startSceneId = body.startSceneId;
        else errors.push('startSceneId: 올바른 장면 키여야 합니다.');
      }
      failIfInvalid(errors);
      if (Object.keys(changes).length === 0) throw new HttpError(400, '바꿀 내용이 없습니다.');

      const updatedAt = await getDb().runTransaction(async (tx) => {
        const { ref, story, scenes } = await readOwned(tx, id, req.user.id, { withScenes: 'ifPublic' });
        checkBaseVersion(body.baseUpdatedAt, story);

        // 공개 중인 스토리는 항상 "오류 없는 상태"를 유지해야 한다.
        if (story.isPublic) {
          const report = validateStory({ ...story, ...changes, scenes });
          if (!report.ok) {
            throw new HttpError(422, '공개 중인 스토리는 오류가 없어야 저장할 수 있습니다. 비공개로 바꾼 뒤 수정하세요.', { validation: report });
          }
        }
        const now = Date.now();
        tx.update(ref, { ...changes, updatedAt: now });
        return now;
      });
      res.json({ ok: true, updatedAt });
    })
  );

  // 장면 전체 저장 (에디터의 "저장" 버튼). 보낸 장면 목록이 곧 최종본이다: 없는 장면은 삭제된다.
  // config, startSceneId 도 함께 보낼 수 있다.
  router.put(
    '/api/stories/:id/scenes',
    requireAuth,
    writeLimiter,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const body = isPlainObject(req.body) ? req.body : {};
      const errors = [];
      const scenes = sanitizeScenes(body.scenes, errors);
      const config = body.config !== undefined ? sanitizeConfig(body.config, errors) : undefined;
      let startSceneId;
      if (body.startSceneId !== undefined) {
        if (typeof body.startSceneId === 'string' && SCENE_ID_PATTERN.test(body.startSceneId)) startSceneId = body.startSceneId;
        else errors.push('startSceneId: 올바른 장면 키여야 합니다.');
      }
      failIfInvalid(errors);

      const result = await getDb().runTransaction(async (tx) => {
        const { ref, story, sceneRefs } = await readOwned(tx, id, req.user.id, { withScenes: 'always' });
        checkBaseVersion(body.baseUpdatedAt, story);

        const next = {
          ...story,
          config: config ?? story.config,
          startSceneId: startSceneId ?? story.startSceneId,
          scenes: withIds(scenes),
        };
        const report = validateStory(next);
        if (story.isPublic && !report.ok) {
          throw new HttpError(422, '공개 중인 스토리는 오류가 없어야 저장할 수 있습니다. 비공개로 바꾼 뒤 수정하세요.', { validation: report });
        }

        // 보낸 장면은 통째로 덮어쓰고, 빠진 장면은 지운다. (최대 200 + 200 + 1 = 401건이라 한 번에 가능)
        for (const [key, scene] of Object.entries(scenes)) tx.set(scenesRef(id).doc(key), scene);
        for (const oldRef of sceneRefs) {
          if (!Object.hasOwn(scenes, oldRef.id)) tx.delete(oldRef);
        }
        const now = Date.now();
        tx.update(ref, {
          sceneCount: Object.keys(scenes).length,
          startSceneId: next.startSceneId,
          ...(config ? { config } : {}),
          updatedAt: now,
        });
        return { updatedAt: now, sceneCount: Object.keys(scenes).length, validation: report };
      });
      res.json({ ok: true, ...result });
    })
  );

  // 이미 저장된 내 스토리를 검사해서 결과(오류/경고)를 돌려준다.
  router.get(
    '/api/stories/:id/validate',
    requireAuth,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const { story, scenes } = await readOwned(plainReader, id, req.user.id, { withScenes: 'always' });
      res.json(validateStory({ ...story, scenes }));
    })
  );

  // 공개/비공개 전환. 공개하려면 validateStory 오류가 0개여야 한다.
  router.patch(
    '/api/stories/:id/visibility',
    requireAuth,
    writeLimiter,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const isPublic = isPlainObject(req.body) ? req.body.isPublic : undefined;
      if (typeof isPublic !== 'boolean') throw new HttpError(400, 'isPublic은 true/false여야 합니다.');

      const result = await getDb().runTransaction(async (tx) => {
        const { ref, story, scenes } = await readOwned(tx, id, req.user.id, { withScenes: isPublic ? 'always' : 'never' });
        let report = null;
        if (isPublic) {
          report = validateStory({ ...story, scenes });
          if (!report.ok) throw new HttpError(422, '오류를 모두 고친 뒤에 공개할 수 있습니다.', { validation: report });
        }
        const now = Date.now();
        tx.update(ref, { isPublic, updatedAt: now });
        return { isPublic, updatedAt: now, validation: report };
      });
      res.json({ ok: true, ...result });
    })
  );

  // 삭제 방침:
  //  1) 스토리 문서와 하위 장면(scenes)을 한 트랜잭션으로 삭제 → 새 플레이 시작이 즉시 막힌다.
  //  2) 그 스토리의 플레이 세션과 엔딩 도감 기록도 함께 삭제한다. (스토리가 없으면 의미가 없고 개인정보 정리 차원)
  //  3) 서버리스 시간 제한 때문에 한 번에 2000건까지만 정리한다. 남으면 cleanup:'partial'로 알리고,
  //     남은 세션은 플레이어가 /포기 로 정리할 수 있다. (일괄 정리는 7단계에서 보강)
  router.delete(
    '/api/stories/:id',
    requireAuth,
    writeLimiter,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const db = getDb();

      await db.runTransaction(async (tx) => {
        const { ref, sceneRefs } = await readOwned(tx, id, req.user.id, { withScenes: 'always' });
        sceneRefs.forEach((sceneRef) => tx.delete(sceneRef));
        tx.delete(ref);
      });

      const sessionsDone = await deleteByStoryId(db, COL.SESSIONS, id);
      const endingsDone = await deleteByStoryId(db, COL.ENDINGS, id);
      const likesDone = await deleteByStoryId(db, COL.LIKES, id); // 6단계: 좋아요 기록도 함께 정리
      clearPublicCache();
      res.json({ ok: true, cleanup: sessionsDone && endingsDone && likesDone ? 'complete' : 'partial' });
    })
  );

  // ───────────── 6단계: 둘러보기 / 좋아요 / 엔딩 도감 ─────────────

  // 둘러보기는 로그인 없이도 볼 수 있어서 IP당 1분 60회로 제한한다.
  const browseLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  // 쿼리스트링의 숫자를 안전하게 정수로 (이상한 값이면 기본값)
  const toInt = (value, min, max, fallback) => {
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  // ?q=a&q=b 처럼 배열로 오는 값은 무시한다
  const queryText = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

  // 공개 스토리 목록: ?q=검색어&tag=태그&sort=latest|popular&offset=0
  router.get(
    '/api/browse',
    browseLimiter,
    optionalAuth,
    wrap(async (req, res) => {
      const offset = toInt(req.query.offset, 0, BROWSE.FETCH_MAX, 0);
      const result = await searchPublicStories({
        q: queryText(req.query.q, BROWSE.QUERY_MAX),
        tag: queryText(req.query.tag, LIMITS.TAG_LENGTH),
        sort: req.query.sort === 'popular' ? 'popular' : 'latest',
        offset,
        limit: BROWSE.PAGE_SIZE,
      });

      const [liked, names] = await Promise.all([
        getLikedSet(req.user?.id, result.stories.map((story) => story.id)),
        getUserNames(result.stories.map((story) => story.authorId)),
      ]);

      res.json({
        stories: result.stories.map((story) => ({
          ...story,
          authorName: names.get(story.authorId) ?? null, // 없으면 화면에서 "운영자"로 표시
          liked: liked.has(story.id),
        })),
        total: result.total,
        tags: result.tags,
        offset,
        pageSize: BROWSE.PAGE_SIZE,
        hasMore: offset + result.stories.length < result.total,
      });
    })
  );

  // 좋아요 켜기/끄기: body { liked: true | false }. 같은 요청을 몇 번 보내도 결과가 같다.
  router.put(
    '/api/stories/:id/like',
    requireAuth,
    writeLimiter,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const liked = isPlainObject(req.body) ? req.body.liked : undefined;
      if (typeof liked !== 'boolean') throw new HttpError(400, 'liked는 true/false여야 합니다.');

      const result = await setLike(req.user.id, id, liked);
      if (!result.ok) throw new HttpError(404, '스토리를 찾을 수 없습니다.');
      clearPublicCache(); // 이 인스턴스의 목록 캐시를 비워 숫자가 바로 보이게 한다
      res.json({ ok: true, liked: result.liked, likeCount: result.likeCount });
    })
  );

  // 스토리 1개의 내 엔딩 도감
  router.get(
    '/api/stories/:id/endings',
    requireAuth,
    wrap(async (req, res) => {
      const id = requireStoryId(req);
      const book = await getEndingBook(req.user.id, id);
      if (!book) throw new HttpError(404, '스토리를 찾을 수 없습니다.');
      res.json(book);
    })
  );

  // 내가 엔딩을 본 모든 스토리의 도감 (최대 20개)
  router.get(
    '/api/me/endings',
    requireAuth,
    wrap(async (req, res) => {
      res.json({ books: await listMyEndingBooks(req.user.id, 20) });
    })
  );

  return router;
}