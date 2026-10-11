// 스토리 엔진 본체: 시작, 선택지 목록, 선택 진행, 엔딩 처리.
// 디스코드/Firestore를 전혀 모른다. 장면은 loadScene(id) 콜백으로만 받는다.
import { checkCondition, checkConditions, describeCondition } from './conditions.js';
import { applyEffects } from './effects.js';
import { createInitialState, HISTORY_MAX, readOwn } from './state.js';

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

/**
 * 장면에 "들어간다": 진입 효과 적용, 위치 갱신, 엔딩 기록.
 * redirectTo가 있으면 호출한 쪽에서 그 장면으로 다시 들어가야 한다. (settle이 처리)
 */
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
 * @returns {{ ok, state, scene, changes }} 또는 {{ ok:false, code, message }}
 */
export async function startStory(config, startScene, loadScene) {
  if (!startScene) return fail('SCENE_NOT_FOUND', '시작 장면이 없습니다.');
  return settle(config, createInitialState(config), startScene, loadScene);
}

/**
 * 선택지 1개를 골라 다음 장면으로 진행한다.
 * 실패해도 넘겨받은 state는 절대 바뀌지 않는다.
 * 실패 code: ALREADY_ENDED, SCENE_MISMATCH, INVALID_CHOICE, LOCKED, SCENE_NOT_FOUND, REDIRECT_LOOP
 */
export async function advance(config, state, scene, choiceIndex, loadScene) {
  if (state.ending) return fail('ALREADY_ENDED', '이미 끝난 이야기입니다.');

  // 오래된 버튼(예전 메시지, 중복 클릭) 방지: 현재 장면과 버튼의 장면이 달라야 거절
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