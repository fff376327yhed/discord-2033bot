// 샘플 스토리: 엔진의 모든 기능(아이템, 스탯, 자원, 파벌, 플래그, 사망 리다이렉트, 3종 엔딩)을 쓴다.
// 이 형식이 그대로 Firestore에 저장되는 스토리 구조의 기준이 된다.
// (Firestore에서는 scenes가 하위 컬렉션이지만, 엔진 테스트에서는 객체 하나로 묶어 쓴다)

export const sampleStory = {
  id: 'sample-001',
  title: '군자역의 새벽',
  description: '방독면 하나와 통조림 몇 개로 지상까지 올라가는 짧은 생존 이야기',
  authorId: 'sample',
  isPublic: true,
  tags: ['생존', '지하철', '샘플'],
  startSceneId: 'start',

  config: {
    stats: {
      hp: { label: '체력', initial: 100, min: 0, max: 100, onZero: 'ending_dead' },
      sanity: { label: '정신력', initial: 80, min: 0, max: 100 },
    },
    resources: {
      food: { label: '식량', initial: 2, min: 0, max: 99 },
      filter: { label: '필터', initial: 1, min: 0, max: 99 },
      ammo: { label: '탄약', initial: 5, min: 0, max: 99 },
    },
    factions: {
      hanse: { label: '한자 동맹', initial: 0, min: -100, max: 100 },
      redline: { label: '레드라인', initial: 0, min: -100, max: 100 },
    },
    items: {
      gasmask: { label: '방독면' },
      keycard: { label: '보안 카드키' },
    },
    flags: {
      traded: { label: '시장 거래 완료' },
    },
  },

  scenes: {
    start: {
      id: 'start',
      body: '군자역 승강장에서 눈을 뜬다. 배낭 옆에 낡은 방독면과 통조림 몇 개가 놓여 있다. 오래 머물 수는 없다.',
      imageUrl: null,
      station: '군자역',
      isEnding: false,
      choices: [
        {
          label: '낡은 방독면을 챙긴다',
          to: 'tunnel',
          effects: [{ type: 'item', key: 'gasmask', delta: 1 }],
        },
        {
          label: '통조림을 챙긴다',
          to: 'tunnel',
          effects: [{ type: 'resource', key: 'food', delta: 2 }],
        },
      ],
    },

    tunnel: {
      id: 'tunnel',
      body: '터널 입구에서 희미한 가스 냄새가 난다. 어둠 속에서 필터 갈리는 소리가 들린다. 시장 쪽 불빛은 아직 따뜻하다.',
      imageUrl: null,
      station: '군자역 터널',
      isEnding: false,
      choices: [
        {
          label: '방독면을 쓰고 터널로 진입한다',
          to: 'tunnel_safe',
          condition: [{ type: 'item', key: 'gasmask' }],
          effects: [{ type: 'resource', key: 'filter', delta: -1 }],
        },
        {
          label: '맨얼굴로 달려간다',
          to: 'tunnel_gas',
          effects: [{ type: 'stat', key: 'hp', delta: -30 }],
        },
        { label: '발길을 돌려 시장으로 간다', to: 'market' },
      ],
    },

    tunnel_gas: {
      id: 'tunnel_gas',
      body: '독가스가 폐를 태운다. 눈앞이 흐려지고 무릎이 꺾인다. 간신히 몸을 돌려 기어 나온다.',
      imageUrl: null,
      station: '군자역 터널',
      isEnding: false,
      onEnter: [{ type: 'stat', key: 'hp', delta: -50 }],
      choices: [{ label: '기어서 시장으로 돌아간다', to: 'market' }],
    },

    market: {
      id: 'market',
      body: '지하 시장. 한자 동맹 상인이 필터를 흔들어 보이고, 한쪽에서는 레드라인 순찰대가 사람들을 훑어본다.',
      imageUrl: null,
      station: '군자역 시장',
      isEnding: false,
      choices: [
        {
          label: '통조림 1개를 주고 필터 2개를 받는다',
          to: 'market',
          condition: [
            { type: 'resource', key: 'food', op: '>=', value: 1 },
            { type: 'flag', key: 'traded', value: false },
          ],
          effects: [
            { type: 'resource', key: 'food', delta: -1 },
            { type: 'resource', key: 'filter', delta: 2 },
            { type: 'faction', key: 'hanse', delta: 10 },
            { type: 'flag', key: 'traded', value: true },
          ],
        },
        {
          label: '레드라인 순찰대에 말을 건다',
          to: 'redline_post',
          effects: [
            { type: 'faction', key: 'redline', delta: 15 },
            { type: 'faction', key: 'hanse', delta: -10 },
          ],
        },
        { label: '터널로 돌아간다', to: 'tunnel' },
      ],
    },

    redline_post: {
      id: 'redline_post',
      body: '순찰대장이 서약서를 내민다. 서명하면 안전과 식량을 보장받지만, 지상은 영영 못 볼 것이다.',
      imageUrl: null,
      station: '레드라인 초소',
      isEnding: false,
      choices: [
        { label: '서약서에 서명한다', to: 'ending_redline' },
        { label: '거절하고 시장으로 돌아간다', to: 'market' },
      ],
    },

    tunnel_safe: {
      id: 'tunnel_safe',
      body: '방독면 너머로 숨소리만 들린다. 터널 끝에 어린이대공원역의 비상등이 붉게 깜빡인다.',
      imageUrl: null,
      station: '어린이대공원역',
      isEnding: false,
      onEnter: [{ type: 'stat', key: 'sanity', delta: -5 }],
      choices: [
        { label: '역 사무실을 살핀다', to: 'office' },
        { label: '곧장 지상 출구로 향한다', to: 'exit' },
      ],
    },

    office: {
      id: 'office',
      body: '먼지 쌓인 사무실 서랍에서 빛바랜 카드키를 찾는다. 어딘가의 보안 문을 열 수 있을지도 모른다.',
      imageUrl: null,
      station: '어린이대공원역 사무실',
      isEnding: false,
      onEnter: [
        { type: 'item', key: 'keycard', delta: 1 },
        { type: 'stat', key: 'sanity', delta: -10 },
      ],
      choices: [{ label: '출구로 향한다', to: 'exit' }],
    },

    exit: {
      id: 'exit',
      body: '지상으로 이어지는 계단 앞. 잠긴 보안 문 하나와, 오래된 일반 출구가 보인다.',
      imageUrl: null,
      station: '어린이대공원역 출구',
      isEnding: false,
      choices: [
        {
          label: '카드키로 보안 문을 연다',
          to: 'ending_hidden',
          condition: [{ type: 'item', key: 'keycard' }],
        },
        {
          label: '한자 동맹 호위 부대와 함께 올라간다',
          to: 'ending_good',
          condition: [{ type: 'faction', key: 'hanse', op: '>=', value: 10 }],
        },
        { label: '홀로 지상으로 올라간다', to: 'ending_bad' },
      ],
    },

    ending_good: {
      id: 'ending_good',
      body: '호위 부대와 함께 계단을 오른다. 새벽빛이 쏟아진다. 당신은 지상에 닿은 첫 사람들 중 하나가 된다.',
      imageUrl: null,
      isEnding: true,
      endingName: '새벽의 호위',
      endingType: 'good',
      choices: [],
    },

    ending_bad: {
      id: 'ending_bad',
      body: '혼자 올라간 지상은 생각보다 훨씬 거칠었다. 이야기는 여기서 끊긴다.',
      imageUrl: null,
      isEnding: true,
      endingName: '홀로 지상으로',
      endingType: 'bad',
      choices: [],
    },

    ending_redline: {
      id: 'ending_redline',
      body: '서약서에 이름을 적는다. 안전한 나날이 이어지지만, 지상의 빛은 끝내 보지 못한다.',
      imageUrl: null,
      isEnding: true,
      endingName: '붉은 선 너머',
      endingType: 'bad',
      choices: [],
    },

    ending_hidden: {
      id: 'ending_hidden',
      body: '보안 문 너머에는 아무도 모르던 비밀 승강장이 있었다. 낡은 열차 한 대가 시동을 걸고 기다린다.',
      imageUrl: null,
      isEnding: true,
      endingName: '지상의 빛',
      endingType: 'hidden',
      choices: [],
    },

    ending_dead: {
      id: 'ending_dead',
      body: '숨이 끊어진다. 가스 속에서 마지막으로 본 것은 군자역의 깜빡이는 형광등이었다.',
      imageUrl: null,
      isEnding: true,
      endingName: '독안개 속에서',
      endingType: 'bad',
      choices: [],
    },
  },
};