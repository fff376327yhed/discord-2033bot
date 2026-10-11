// 엔진 테스트. 실행: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleStory } from '../src/engine/sample-story.js';
import {
  createInitialState,
  startStory,
  advance,
  applyEffects,
  getAvailableChoices,
  validateStory,
} from '../src/engine/index.js';

const { config } = sampleStory;
const loadScene = async (id) => sampleStory.scenes[id] ?? null;

// 시작 장면에 진입한 상태를 만든다
async function begin() {
  const result = await startStory(config, sampleStory.scenes[sampleStory.startSceneId], loadScene);
  assert.ok(result.ok, '시작 실패');
  return result;
}

// 선택지 번호를 순서대로 눌러 진행한다
async function play(path) {
  let current = await begin();
  for (const index of path) {
    current = await advance(config, current.state, current.scene, index, loadScene);
    assert.ok(current.ok, `진행 실패: ${current.code}`);
  }
  return current;
}

test('샘플 스토리는 검증을 통과하고 경고도 없다', () => {
  const report = validateStory(sampleStory);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
});

test('시작 상태는 config의 초기값을 따른다', async () => {
  const { state } = await begin();
  assert.equal(state.sceneId, 'start');
  assert.equal(state.stats.hp, 100);
  assert.equal(state.resources.food, 2);
  assert.equal(state.station, '군자역');
  assert.equal(state.ending, null);
});

test('방독면이 없으면 해당 선택지가 잠기고 진행도 거절된다', async () => {
  const current = await play([1]); // 통조림만 챙김 → tunnel
  const choices = getAvailableChoices(config, current.state, current.scene);
  assert.equal(choices[0].enabled, false);
  assert.equal(choices[0].lockedReason, '방독면 필요');

  const result = await advance(config, current.state, current.scene, 0, loadScene);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOCKED');
});

test('효과는 최대/최소 범위로 보정된다', () => {
  const state = createInitialState(config);
  const up = applyEffects(config, state, [{ type: 'resource', key: 'food', delta: 500 }]);
  assert.equal(up.state.resources.food, 99);
  const down = applyEffects(config, state, [{ type: 'stat', key: 'hp', delta: -999 }]);
  assert.equal(down.state.stats.hp, 0);
});

test('위험한 키와 정의되지 않은 값은 무시된다', () => {
  const state = createInitialState(config);
  const { state: next } = applyEffects(config, state, [
    { type: 'flag', key: '__proto__', value: true },
    { type: 'stat', key: 'unknown', delta: 5 },
    { type: 'item', key: 'unknown_item', delta: 1 },
  ]);
  assert.deepEqual(next.flags, {});
  assert.deepEqual(next.inventory, {});
  assert.equal(Object.hasOwn(next.stats, 'unknown'), false);
});

test('오래된 버튼(다른 장면의 선택지)은 거절된다', async () => {
  const atTunnel = await play([0]); // start → tunnel
  const atStart = await begin();
  // 상태는 tunnel인데 start 장면의 버튼을 누른 상황
  const result = await advance(config, atTunnel.state, atStart.scene, 0, loadScene);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCENE_MISMATCH');
});

test('진행해도 원본 상태는 바뀌지 않는다', async () => {
  const current = await begin();
  const snapshot = structuredClone(current.state);
  await advance(config, current.state, current.scene, 1, loadScene);
  assert.deepEqual(current.state, snapshot);
});

test('플래그 조건: 거래는 한 번만 가능하다', async () => {
  // start(방독면) → tunnel(시장) → market(거래)
  const current = await play([0, 2, 0]);
  assert.equal(current.state.flags.traded, true);
  assert.equal(current.state.resources.food, 1);
  assert.equal(current.state.factions.hanse, 10);
  const choices = getAvailableChoices(config, current.state, current.scene);
  assert.equal(choices[0].enabled, false); // 거래 선택지 잠김
});

test('체력이 0이 되면 사망 엔딩으로 자동 이동한다', async () => {
  // 맨얼굴로 터널을 두 번 진입: 100 → 20 → 0
  const current = await play([1, 1, 0, 2, 1]);
  assert.equal(current.scene.id, 'ending_dead');
  assert.equal(current.state.ending.name, '독안개 속에서');
  assert.equal(current.state.ending.type, 'bad');
});

test('굿 엔딩: 시장에서 거래해 호감도를 쌓고 호위와 함께 탈출', async () => {
  const current = await play([0, 2, 0, 2, 0, 1, 1]);
  assert.equal(current.state.ending.type, 'good');
  assert.equal(current.ending.name, '새벽의 호위');
});

test('히든 엔딩: 사무실에서 카드키를 얻어 보안 문을 연다', async () => {
  const current = await play([0, 0, 0, 0, 0]);
  assert.equal(current.state.ending.type, 'hidden');
  assert.equal(current.state.inventory.keycard, 1);
});

test('엔딩 이후에는 더 진행할 수 없다', async () => {
  const ended = await play([0, 0, 1, 2]); // start → tunnel → tunnel_safe → exit → ending_bad
  assert.equal(ended.state.ending.type, 'bad');
  const result = await advance(config, ended.state, ended.scene, 0, loadScene);
  assert.equal(result.code, 'ALREADY_ENDED');
});

test('검증기가 끊긴 분기와 막다른 길을 찾아낸다', () => {
  const broken = structuredClone(sampleStory);
  broken.scenes.start.choices[0].to = 'nowhere';
  broken.scenes.office.choices = [];
  const report = validateStory(broken);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((msg) => msg.includes('끊긴 분기')));
  assert.ok(report.errors.some((msg) => msg.includes('막다른 길')));
});