# 서울 2033 창작마당 — 스토리 데이터 스펙 (봇 공용)

이 문서는 어떤 봇이든(디스코드 봇, 스크립트, 사람이 직접 등) 이 포맷대로 JSON을 만들면
`api.createStory` → `api.saveScenes` 호출로 그대로 스토리를 업로드할 수 있도록,
클라이언트 엔진(`lib.js`)이 실제로 검사하는 규칙만 정리한 것입니다.

## 1. 전체 구조

```
Story
├── title: string (<=50자)
├── description: string (<=500자)
├── tags: string[] (최대 5개, 각 <=20자)
├── startSceneId: string           // scenes의 키 중 하나
├── config: Config
└── scenes: { [sceneKey: string]: Scene }
```

`sceneKey`는 "안전한 키" 규칙(`isSafeKey`)을 따라야 합니다:
문자열, 1~40자, `__proto__` / `constructor` / `prototype` 금지.
(config의 stats/resources/factions/items/flags 키도 동일 규칙)

## 2. config

```
Config
├── stats:     { [key]: NumericDef }   // onZero 지원
├── resources: { [key]: NumericDef }
├── factions:  { [key]: NumericDef }   // = 세력 호감도
├── items:     { [key]: { label: string } }
├── flags:     { [key]: { label: string } }
└── startInventory: { [itemKey]: number }  // 시작 소지품 개수 (1~99)
```

`NumericDef`:
```
{
  label: string,          // 화면에 보일 이름
  initial: number,        // 시작값
  min: number,            // 생략 시 버킷별 기본값
  max: number,            // 생략 시 버킷별 기본값
  onZero?: string         // stats 전용. 이 값이 min 이하가 되면
                           // 자동으로 이동할 scene 키 (예: 사망 엔딩)
}
```

버킷별 **기본 범위**(min/max를 안 주면 적용):
| 버킷 | 기본 min~max | 의미 |
|---|---|---|
| stats | 0 ~ 100 | 체력·정신력 등. 0 되면 onZero로 강제 이동 가능 |
| resources | 0 ~ 99 | 식량·필터 등 소모품 수치 |
| factions | -100 ~ 100 | 세력과의 **호감도**. 보통 0에서 시작 |

아이템은 `inventory`에 개수로 저장되며 0~99 사이로 클램프되고, 0이 되면 자동으로 삭제됩니다.
플래그는 켜짐/꺼짐(boolean)만 저장하는 스위치입니다 (1회성 이벤트용).

## 3. scenes

```
Scene
├── body: string (<=1800자)         // 본문
├── imageUrl?: string (<=500자, https만)
├── station?: string (<=40자)       // 화면 표시용 "역 이름" 같은 배지
├── isEnding: boolean
├── endingName?: string (<=50자)    // isEnding=true일 때
├── endingType?: "good" | "bad" | "hidden"
├── onEnter?: Effect[]              // 이 장면 진입 시 자동 적용 (최대 10개)
└── choices?: Choice[]              // isEnding=false일 때만, 최대 5개
```

`Choice`:
```
{
  label: string (<=80자),
  to: string,                 // 이동할 scene 키 (존재해야 함)
  condition?: Condition[],    // 최대 10개, 전부 만족해야 선택 가능
  effects?: Effect[],         // 최대 10개, 선택 시 적용
  hideWhenLocked?: boolean    // true면 조건 미충족 시 아예 숨김
                               // false(기본)면 🔒 잠금 상태로 보여줌
}
```

## 4. Condition / Effect 항목 (entry)

둘 다 `{ type, key, ... }` 형태이며 `type`은 `"stat" | "resource" | "faction" | "item" | "flag"`.

**Condition**:
- 수치형(stat/resource/faction)·아이템: `{ type, key, op, value }`
  - `op`: `">=" "<=" ">" "<" "==" "!="`  (값 비교)
- 플래그: `{ type: "flag", key, value: true|false }`

**Effect**:
- 수치형·아이템: `{ type, key, delta }`  (증감값, 음수 가능. 결과는 버킷 범위로 클램프)
- 플래그: `{ type: "flag", key, value: true|false }`  (켜거나 끔)

## 5. 유효성 규칙 (공개하려면 반드시 통과해야 함)

- `startSceneId`는 `scenes`에 실제로 존재해야 함
- 엔딩이 아닌 장면은 **선택지가 1개 이상** 있어야 함 (막다른 길 금지)
- 모든 `choice.to`는 존재하는 scene 키여야 함 (끊긴 분기 금지)
- `stats`에 `onZero`를 넣었다면 그 대상 scene도 존재해야 함
- 리다이렉트(onZero 연쇄)는 최대 5단계까지만 허용 (무한루프 방지)

## 6. 업로드 순서 (봇 → API)

디스코드 로그인 세션 쿠키가 있는 주체(= 그 계정으로 로그인한 상태)만 호출 가능.
모든 변경 요청(GET/HEAD 제외)에는 헤더 `x-requested-with: haejung` 필요(CSRF 방지).

```
1) POST /api/stories                body: { title }
   → { story: { id, ... } }

2) PUT  /api/stories/:id/scenes     body: { scenes, config, startSceneId, baseUpdatedAt }
   → { updatedAt, validation: { ok, errors[], warnings[] } }

3) (선택) PUT /api/stories/:id      body: { title, description, tags, baseUpdatedAt }

4) (선택) PATCH /api/stories/:id/visibility   body: { isPublic: true }
   → 422면 validation 오류가 남아있다는 뜻. 먼저 다 고쳐야 공개 가능.
```

`baseUpdatedAt`은 동시수정 충돌 방지용 — 방금 받은 응답의 `updatedAt`을 다음 요청에 그대로 넣으면 됩니다.
