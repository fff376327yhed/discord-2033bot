// 스토리 검증기: 저장/공개 전에 문제를 찾아낸다. (5단계 에디터에서 그대로 사용)
// story = { startSceneId, config, scenes: { [장면키]: 장면 } }
import { NUMERIC_BUCKETS } from './state.js';

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