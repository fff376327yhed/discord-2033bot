// 슬래시 커맨드 정의. 등록 스크립트(npm run register)가 이 목록을 디스코드에 올린다.
const SLASH = 1;   // 슬래시 커맨드 종류
const STRING = 3;  // 문자열 옵션 종류

export const COMMANDS = [
  {
    name: '스토리목록',
    description: '플레이할 수 있는 공개 스토리 목록을 봅니다',
    type: SLASH,
  },
  {
    name: '플레이',
    description: '스토리를 시작합니다 (ID를 비우면 목록을 보여줍니다)',
    type: SLASH,
    options: [
      {
        type: STRING,
        name: '스토리',
        description: '시작할 스토리의 ID',
        required: false,
        max_length: 64,
      },
    ],
  },
  {
    name: '이어하기',
    description: '진행 중인 이야기를 이어서 합니다',
    type: SLASH,
  },
  {
    name: '포기',
    description: '진행 중인 이야기를 포기합니다',
    type: SLASH,
  },
];