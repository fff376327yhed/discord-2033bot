// src/bundle.js 의 engine 부분을 그대로 복사한 "클라이언트용 사본"이다.
// 디스코드/Firestore를 모르는 순수 함수라서 그대로 브라우저에서 돈다.
// ⚠️ 서버(src/bundle.js)의 엔진 로직을 고치면 이 파일도 손으로 같이 맞춰야 한다 (자동 동기화 아님).

export const NUMERIC_BUCKETS = { stat: 'stats', resource: 'resources', faction: 'factions' };
export const HISTORY_MAX = 100;
export const ITEM_MAX = 99;

const DEFAULT_RANGE = { stats: [0, 100], resources: [0, 99], factions: [-100, 100] };
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 40 && !BLOCKED_KEYS.has(key);
}

export function readOwn(obj, key, fallback) {
  if (obj && typeof key === 'string' && Object.hasOwn(obj, key)) return obj[key];
  return fallback;
}

export function clampValue(value, bucket, def = {}) {
  const [defMin, defMax] = DEFAULT_RANGE[bucket] ?? [0, 99];
  const min = Number.isFinite(def.min) ? def.min : defMin;
  const max = Number.isFinite(def.max) ? def.max : defMax;
  return Math.min(max, Math.max(min, value));
}

export function createInitialState(config = {}) {
  const state = { sceneId: null, station: null, stats: {}, resources: {}, factions: {}, inventory: {}, flags: {}, history: [], turn: 0, ending: null };
  for (const bucket of Object.values(NUMERIC_BUCKETS)) {
    for (const [key, def] of Object.entries(config[bucket] ?? {})) {
      if (!isSafeKey(key)) continue;
      state[bucket][key] = clampValue(Number(def.initial) || 0, bucket, def);
    }
  }
  for (const [key, count] of Object.entries(config.startInventory ?? {})) {
    if (isSafeKey(key) && Number(count) > 0) state.inventory[key] = Math.min(ITEM_MAX, Math.trunc(Number(count)));
  }
  return state;
}

const OPS = {
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b,
  '<': (a, b) => a < b, '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};

function compare(actual, op, expected) {
  const fn = OPS[op];
  if (!fn || typeof expected !== 'number' || Number.isNaN(expected)) return false;
  return fn(actual, expected);
}

export function checkCondition(state, cond) {
  if (!cond || typeof cond !== 'object') return false;
  const { type, key } = cond;
  if (type === 'flag') return Boolean(readOwn(state.flags, key, false)) === (cond.value ?? true);
  if (type === 'item') return compare(readOwn(state.inventory, key, 0), cond.op ?? '>=', cond.value ?? 1);
  const bucket = NUMERIC_BUCKETS[type];
  if (bucket) return compare(readOwn(state[bucket], key, 0), cond.op ?? '>=', cond.value);
  return false;
}

export function checkConditions(state, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every((cond) => checkCondition(state, cond));
}

const OP_TEXT = { '>=': '이상', '<=': '이하', '>': '초과', '<': '미만', '==': '이어야 함', '!=': '이면 안 됨' };

export function labelOf(config, type, key) {
  const bucket = NUMERIC_BUCKETS[type];
  let table = null;
  if (bucket) table = config?.[bucket];
  else if (type === 'item') table = config?.items;
  else if (type === 'flag') table = config?.flags;
  return readOwn(readOwn(table, key, null), 'label', key);
}

export function describeCondition(config, cond) {
  const name = labelOf(config, cond.type, cond.key);
  if (cond.type === 'flag') return (cond.value ?? true) ? `${name} 상태 필요` : `${name} 상태가 아니어야 함`;
  if (cond.type === 'item') {
    const op = cond.op ?? '>=';
    const value = cond.value ?? 1;
    if (op === '>=' && value === 1) return `${name} 필요`;
    return `${name} ${value}${OP_TEXT[op] ?? ''}`;
  }
  return `${name} ${cond.value}${OP_TEXT[cond.op ?? '>='] ?? ''}`;
}

export function applyEffects(config, state, effects) {
  const next = structuredClone(state);
  const changes = [];
  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (!effect || !isSafeKey(effect.key)) continue;
      const change = applyOne(config, next, effect);
      if (change) changes.push(change);
    }
  }
  return { state: next, changes };
}

function applyOne(config, next, effect) {
  const { type, key } = effect;
  const label = labelOf(config, type, key);
  const bucket = NUMERIC_BUCKETS[type];
  if (bucket) {
    const def = readOwn(config?.[bucket], key, null);
    if (!def || !Number.isFinite(effect.delta)) return null;
    const from = readOwn(next[bucket], key, 0);
    const to = clampValue(from + Math.trunc(effect.delta), bucket, def);
    next[bucket][key] = to;
    return from === to ? null : { type, key, label, from, to };
  }
  if (type === 'item') {
    if (!readOwn(config?.items, key, null) || !Number.isFinite(effect.delta)) return null;
    const from = readOwn(next.inventory, key, 0);
    const to = Math.min(ITEM_MAX, Math.max(0, from + Math.trunc(effect.delta)));
    if (to === 0) delete next.inventory[key]; else next.inventory[key] = to;
    return from === to ? null : { type, key, label, from, to };
  }
  if (type === 'flag') {
    const to = Boolean(effect.value ?? true);
    const from = Boolean(readOwn(next.flags, key, false));
    if (to) next.flags[key] = true; else delete next.flags[key];
    return from === to ? null : { type, key, label, from, to };
  }
  return null;
}

const MAX_REDIRECTS = 5;
function fail(code, message) { return { ok: false, code, message }; }

export function getAvailableChoices(config, state, scene) {
  if (!scene || scene.isEnding) return [];
  const result = [];
  (scene.choices ?? []).forEach((choice, index) => {
    const unmet = (choice.condition ?? []).filter((cond) => !checkCondition(state, cond));
    const enabled = unmet.length === 0;
    if (!enabled && choice.hideWhenLocked) return;
    result.push({ index, label: choice.label, enabled, lockedReason: enabled ? null : unmet.map((cond) => describeCondition(config, cond)).join(', ') });
  });
  return result;
}

function findZeroRedirect(config, state) {
  for (const [key, def] of Object.entries(config?.stats ?? {})) {
    if (def.onZero && readOwn(state.stats, key, 0) <= (Number.isFinite(def.min) ? def.min : 0)) return def.onZero;
  }
  return null;
}

export function enterScene(config, state, scene) {
  const { state: next, changes } = applyEffects(config, state, scene.onEnter);
  next.sceneId = scene.id;
  if (scene.station) next.station = scene.station;
  let redirectTo = null;
  if (scene.isEnding) {
    next.ending = { sceneId: scene.id, name: scene.endingName ?? scene.id, type: scene.endingType ?? null };
  } else {
    redirectTo = findZeroRedirect(config, next);
  }
  return { state: next, changes, redirectTo };
}

async function settle(config, state, scene, loadScene) {
  let current = state, currentScene = scene;
  const changes = [];
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const entered = enterScene(config, current, currentScene);
    current = entered.state;
    changes.push(...entered.changes);
    if (!entered.redirectTo) return { ok: true, state: current, scene: currentScene, changes };
    const target = await loadScene(entered.redirectTo);
    if (!target) return fail('SCENE_NOT_FOUND', `장면 '${entered.redirectTo}'을(를) 찾을 수 없습니다.`);
    currentScene = target;
  }
  return fail('REDIRECT_LOOP', '스탯 리다이렉트가 끝나지 않습니다. onZero 장면을 확인하세요.');
}

export async function startStory(config, startScene, loadScene) {
  if (!startScene) return fail('SCENE_NOT_FOUND', '시작 장면이 없습니다.');
  return settle(config, createInitialState(config), startScene, loadScene);
}

export async function advance(config, state, scene, choiceIndex, loadScene) {
  if (state.ending) return fail('ALREADY_ENDED', '이미 끝난 이야기입니다.');
  if (!scene || state.sceneId !== scene.id) return fail('SCENE_MISMATCH', '지금 장면의 선택지가 아닙니다.');
  const choice = Number.isInteger(choiceIndex) ? scene.choices?.[choiceIndex] : null;
  if (scene.isEnding || !choice) return fail('INVALID_CHOICE', '존재하지 않는 선택지입니다.');
  if (!checkConditions(state, choice.condition)) return fail('LOCKED', '조건을 만족하지 못해 선택할 수 없습니다.');
  const target = await loadScene(choice.to);
  if (!target) return fail('SCENE_NOT_FOUND', `장면 '${choice.to}'을(를) 찾을 수 없습니다.`);
  const applied = applyEffects(config, state, choice.effects);
  const moved = applied.state;
  moved.turn += 1;
  moved.history.push({ from: scene.id, choice: choiceIndex });
  if (moved.history.length > HISTORY_MAX) moved.history.splice(0, moved.history.length - HISTORY_MAX);
  const settled = await settle(config, moved, target, loadScene);
  if (!settled.ok) return settled;
  return { ok: true, state: settled.state, scene: settled.scene, changes: [...applied.changes, ...settled.changes], ending: settled.state.ending };
}