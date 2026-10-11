// 조건 검사: 선택지를 누를 수 있는지 판단한다.
import { NUMERIC_BUCKETS, readOwn } from './state.js';

// 비교 연산자 모음
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

// ── 잠금 사유를 사람이 읽는 문장으로 만드는 도구 ──

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