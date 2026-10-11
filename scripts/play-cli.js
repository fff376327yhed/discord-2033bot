// 터미널에서 샘플 스토리를 직접 플레이해 본다. (엔진 동작 확인용)
// 실행: npm run play
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { sampleStory } from '../src/engine/sample-story.js';
import { validateStory, startStory, advance, getAvailableChoices } from '../src/engine/index.js';

const { config } = sampleStory;
const loadScene = async (id) => sampleStory.scenes[id] ?? null; // 지금은 메모리에서, 3단계에서는 Firestore에서

// 스탯/자원/파벌/소지품을 한 줄로 보여준다
function statusLine(state) {
  const parts = [];
  for (const bucket of ['stats', 'resources', 'factions']) {
    for (const [key, def] of Object.entries(config[bucket] ?? {})) {
      parts.push(`${def.label} ${state[bucket][key]}`);
    }
  }
  const items = Object.entries(state.inventory).map(([key, n]) => `${config.items?.[key]?.label ?? key}x${n}`);
  return `[${parts.join(' | ')}] 소지품: ${items.length ? items.join(', ') : '없음'}`;
}

// 시작 전에 스토리 검증
const report = validateStory(sampleStory);
console.log(report.ok ? '✅ 스토리 검증 통과' : '❌ 스토리 검증 실패');
report.errors.forEach((msg) => console.log('  오류:', msg));
report.warnings.forEach((msg) => console.log('  경고:', msg));
if (!report.ok) process.exit(1);

const rl = readline.createInterface({ input, output });
let current = await startStory(config, sampleStory.scenes[sampleStory.startSceneId], loadScene);
if (!current.ok) {
  console.log('시작 실패:', current.message);
  process.exit(1);
}

while (true) {
  console.log('\n────────────────────────────');
  if (current.state.station) console.log(`📍 ${current.state.station}`);
  console.log(current.scene.body);
  console.log(statusLine(current.state));

  if (current.state.ending) {
    const { name, type } = current.state.ending;
    console.log(`\n🏁 엔딩 [${type}] ${name}`);
    break;
  }

  const choices = getAvailableChoices(config, current.state, current.scene);
  choices.forEach((c, i) => {
    const lock = c.enabled ? '' : `🔒 `;
    const reason = c.enabled ? '' : ` (${c.lockedReason})`;
    console.log(`  ${i + 1}. ${lock}${c.label}${reason}`);
  });

  const answer = (await rl.question('번호 선택 (q = 종료) > ')).trim();
  if (answer === 'q') break;

  const picked = choices[Number(answer) - 1];
  if (!picked) {
    console.log('올바른 번호를 입력하세요.');
    continue;
  }

  const next = await advance(config, current.state, current.scene, picked.index, loadScene);
  if (!next.ok) {
    console.log(`⚠️ ${next.message}`);
    continue;
  }
  next.changes.forEach((c) => console.log(`   ▸ ${c.label}: ${c.from} → ${c.to}`));
  current = next;
}

rl.close();