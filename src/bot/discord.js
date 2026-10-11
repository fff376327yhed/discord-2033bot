// 디스코드 API 상수와 응답 만들기 도구

export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3 };
export const ResponseType = { PONG: 1, CHANNEL_MESSAGE: 4, UPDATE_MESSAGE: 7 };
export const ComponentType = { ACTION_ROW: 1, BUTTON: 2 };
export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };

const EPHEMERAL = 64; // 이 플래그가 있으면 메시지를 누른 본인에게만 보인다

// 모든 응답에 멘션 차단: 제작자가 쓴 @everyone 같은 글이 실제로 울리지 않게 한다
const NO_MENTIONS = { parse: [] };

/** 새 메시지로 응답 (본인에게만 보임) */
export function reply(data) {
  return {
    type: ResponseType.CHANNEL_MESSAGE,
    data: { ...data, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS },
  };
}

/** 버튼이 붙은 기존 메시지를 새 내용으로 교체 */
export function update(data) {
  return {
    type: ResponseType.UPDATE_MESSAGE,
    data: { ...data, allowed_mentions: NO_MENTIONS },
  };
}

/** 오류 안내 (본인에게만 보이는 새 메시지, 기존 메시지는 그대로 둔다) */
export function errorReply(message) {
  return reply({ content: `⚠️ ${message}`, embeds: [], components: [] });
}

/** 기존 메시지를 글자만 남기고 교체 (임베드/버튼 제거) */
export function textUpdate(message) {
  return update({ content: message, embeds: [], components: [] });
}

/** 슬래시 커맨드/버튼을 누른 유저 정보 (서버 안에서는 member.user, DM에서는 user) */
export function getInteractionUser(interaction) {
  const user = interaction.member?.user ?? interaction.user ?? {};
  return {
    id: String(user.id ?? ''),
    username: String(user.global_name ?? user.username ?? '알 수 없음').slice(0, 80),
    avatar: user.avatar ?? null,
  };
}

/** 슬래시 커맨드의 문자열 옵션 값 읽기 */
export function getStringOption(interaction, name) {
  const option = interaction.data?.options?.find((item) => item.name === name);
  return typeof option?.value === 'string' ? option.value : null;
}