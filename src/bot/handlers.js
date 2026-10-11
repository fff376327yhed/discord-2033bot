// 디스코드 상호작용(슬래시 커맨드, 버튼)을 처리하는 곳.
// 버튼 custom_id 규칙:
//   s:<스토리ID>               목록에서 시작
//   c:<스토리ID>:<턴>:<번호>   선택지 선택
//   r:<스토리ID>               이어하기
//   x:<스토리ID>               포기
import {
  InteractionType,
  reply,
  update,
  errorReply,
  textUpdate,
  getInteractionUser,
  getStringOption,
} from './discord.js';
import { sceneMessage, storyListMessage, sessionListMessage, resumeOfferMessage } from './render.js';
import {
  getPublicStories,
  startSession,
  getSessionView,
  chooseInSession,
  listActiveSessions,
  abandonSession,
} from './store.js';

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
    case '스토리목록':
      return reply(storyListMessage(await getPublicStories(5)));

    case '플레이': {
      const storyId = getStringOption(interaction, '스토리')?.trim();
      if (!storyId) return reply(storyListMessage(await getPublicStories(5)));
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