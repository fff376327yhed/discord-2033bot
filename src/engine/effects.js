// 효과 적용: 선택지/장면 진입 시 스탯, 아이템, 플래그를 바꾼다.
// 원본 state는 건드리지 않고 복사본을 수정해서 돌려준다.
import { NUMERIC_BUCKETS, ITEM_MAX, clampValue, isSafeKey, readOwn } from './state.js';
import { labelOf } from './conditions.js';

/**
 * 효과 목록을 순서대로 적용한다.
 * @returns {{ state, changes }}  changes = 화면에 보여줄 변화 목록
 *   [{ type, key, label, from, to }]
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