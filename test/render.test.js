// 메시지 만들기 테스트: 디스코드 제한(글자수, 버튼 수 등)을 지키는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleStory } from '../src/engine/sample-story.js';
import { startStory, advance } from '../src/engine/index.js';
import { sceneMessage } from '../src/bot/render.js';

const { config } = sampleStory;
const story = { id: sampleStory.id, title: sampleStory.title };
const loadScene = async (id) => sampleStory.scenes[id] ?? null;

async function play(path) {
  let current = await startStory(config, sampleStory.scenes[sampleStory.startSceneId], loadScene);
  for (const index of path) {
    current = await advance(config, current.state, current.scene, index, loadScene);
    assert.ok(current.ok, `진행 실패: ${current.code}`);
  }
  return current;
}

test('시작 장면: 선택지 버튼 2개, custom_id는 규칙과 100자 제한을 지킨다', async () => {
  const { state, scene } = await play([]);
  const message = sceneMessage({ story, scene, state, config });
  const buttons = message.components[0].components;
  assert.equal(buttons.length, 2);
  for (const [i, button] of buttons.entries()) {
    assert.ok(button.custom_id.length <= 100);
    assert.equal(button.custom_id, `c:sample-001:0:${i}`);
  }
});

test('조건 미달 선택지는 비활성화되고 🔒 표시와 사유가 나온다', async () => {
  const { state, scene } = await play([1]); // 방독면 없이 터널 도착
  const message = sceneMessage({ story, scene, state, config });
  const first = message.components[0].components[0];
  assert.equal(first.disabled, true);
  assert.ok(first.label.startsWith('🔒'));
  const lockedField = message.embeds[0].fields.find((field) => field.name === '잠긴 선택지');
  assert.ok(lockedField.value.includes('방독면 필요'));
});

test('엔딩 메시지는 버튼이 없고 엔딩 이름이 제목에 나온다', async () => {
  const { state, scene } = await play([0, 0, 0, 0, 0]); // 히든 엔딩
  const message = sceneMessage({ story, scene, state, config });
  assert.deepEqual(message.components, []);
  assert.ok(message.embeds[0].title.includes('지상의 빛'));
});

test('너무 긴 본문은 임베드 제한(4096자) 안으로 잘린다', async () => {
  const { state, scene } = await play([]);
  const longScene = { ...scene, body: 'ㄱ'.repeat(10000) };
  const message = sceneMessage({ story, scene: longScene, state, config });
  assert.ok(message.embeds[0].description.length <= 4096);
});

test('https가 아닌 이미지 주소는 임베드에 넣지 않는다', async () => {
  const { state, scene } = await play([]);
  const bad = sceneMessage({ story, scene: { ...scene, imageUrl: 'javascript:alert(1)' }, state, config });
  assert.equal(bad.embeds[0].image, undefined);
  const good = sceneMessage({ story, scene: { ...scene, imageUrl: 'https://example.com/a.png' }, state, config });
  assert.equal(good.embeds[0].image.url, 'https://example.com/a.png');
});