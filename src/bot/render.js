// 엔진 결과를 디스코드 메시지(임베드 + 버튼)로 바꾼다.
// 디스코드/Firestore를 호출하지 않는 순수 함수라 테스트하기 쉽다.
import { getAvailableChoices } from '../engine/index.js';
import { ButtonStyle, ComponentType } from './discord.js';

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
export function storyListMessage(stories) {
  if (stories.length === 0) {
    return { content: '아직 공개된 스토리가 없습니다.', embeds: [], components: [] };
  }

  const lines = stories.map((story, i) => {
    const tags = Array.isArray(story.tags) && story.tags.length > 0 ? ` · ${story.tags.slice(0, 3).join(', ')}` : '';
    return (
      `**${i + 1}. ${truncate(story.title, 60)}**\n` +
      `${truncate(story.description || '설명 없음', 100)}\n` +
      `제작자 ${authorText(story.authorId)} · 플레이 ${story.playCount ?? 0}회${tags}`
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