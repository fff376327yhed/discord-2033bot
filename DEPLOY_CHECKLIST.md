# 해정2033 배포 점검 체크리스트 (7-6)

> 먼저 컴퓨터가 대신 확인해 주는 명령부터 돌리고, 컴퓨터가 못 보는 것(디스코드 포털 등)만 눈으로 확인하세요.

## 0. 자동 점검 (윈도우 cmd, 프로젝트 루트)

```
chcp 65001
npm test
node scripts/cli.js preflight
```

- `preflight` 는 **내 PC의 .env** 를 점검합니다. 개발용 값(localhost)은 정상이라 경고가 조금 나와도 괜찮습니다.
- 운영 값을 점검하려면 Vercel 대시보드의 값을 보고 `.env.production.local` 파일을 만든 뒤:

```
node scripts/cli.js preflight --prod --file .env.production.local
```

- (선택) Vercel CLI가 있으면 `vercel env pull .env.production.local --environment=production` 으로 받을 수 있습니다.
  "Sensitive"로 저장한 값은 비어서 올 수 있습니다. (확인 필요)
- `.env.production.local` 은 **비밀이 들어 있으니 GitHub에 올리지 마세요.** (.gitignore 에 `.env*` 가 있는지 확인)
- 결과의 `❌` 가 0개가 될 때까지 고칩니다. 비밀 값 자체는 화면에 출력되지 않습니다.

## 1. Vercel 환경 변수 (Settings → Environment Variables → Production)

| 이름 | 올바른 모양 |
| --- | --- |
| SITE_URL | `https://배포도메인` (끝에 `/` 없이) |
| JWT_SECRET | 32자 이상 무작위 글자 |
| DISCORD_APPLICATION_ID | 숫자 17~20자리 |
| DISCORD_CLIENT_SECRET | 디스코드 포털 OAuth2 의 Client Secret |
| DISCORD_PUBLIC_KEY | 16진수 64자 (슬래시 커맨드 서명 검증) |
| FIREBASE_SERVICE_ACCOUNT_BASE64 | 서비스 계정 JSON 을 base64 로 만든 한 줄 |
| CRON_SECRET | 16자 이상 무작위 글자 (예약 정리용) |
| ADMIN_DISCORD_IDS | 운영자 디스코드 숫자 ID, 여러 명이면 쉼표로 |
| DISCORD_ALLOWED_CHANNEL_IDS | (선택) 봇을 쓸 수 있는 채널 ID, 여러 개면 쉼표로. 비우면 모든 채널 |
| DISCORD_EPHEMERAL | (선택) `true`로 두면 봇 메시지가 본인에게만 보임. 비우면 모두에게 보임 |

환경 변수를 바꾼 뒤에는 **다시 배포(Redeploy)** 해야 적용됩니다.

## 2. 디스코드 개발자 포털 (직접 확인)

- OAuth2 → Redirects 에 아래 주소가 **글자 하나 다르지 않게** 들어 있어야 합니다.
  - `https://배포도메인/api/auth/callback`
  - `http://localhost:5173/api/auth/callback` (로컬 개발용)
- General Information → Interactions Endpoint URL: `https://배포도메인/api/interactions`

## 3. vercel.json 예약 정리 (직접 확인)

`vercel.json` 에 아래 항목이 있어야 합니다. (preflight 가 확인해 줍니다)

```json
"crons": [{ "path": "/api/cron/cleanup", "schedule": "0 18 * * *" }]
```

- 시간은 UTC 입니다. Hobby 요금제는 하루 1번까지로 알고 있습니다. (공식 문서 확인 필요)
- 크론이 안 돌아도 `node scripts/cli.js cleanup` 으로 손으로 정리할 수 있습니다.

## 4. Firestore (직접 확인)

### 4-1. 검색 확장용 복합 인덱스 3개 (7-5)

인덱스가 없으면 검색은 **옛날 방식(최신 200개 안에서만)** 으로 조용히 동작합니다. 오류로 멈추지는 않습니다.

가장 쉬운 방법:
1. 배포한 사이트의 둘러보기에서 태그를 눌러 보고, 검색어를 넣어 보고, 인기순을 눌러 봅니다.
2. Vercel → Logs 에서 `[검색 확장 실패 ...]` 가 나오면, 그 오류 메시지 안의 **링크**를 누르면 Firebase 콘솔에서 인덱스가 자동으로 채워집니다. "만들기"를 누르고 몇 분 기다립니다.

파일 `firestore.indexes.json` 에 같은 3개가 적혀 있습니다. (Firebase CLI 를 쓰는 분만 필요, 안 써도 됩니다.)
주의: `firebase deploy --only firestore:indexes` 는 이 파일에 없는 기존 인덱스를 지우자고 물어볼 수 있으니, 기존 인덱스(isPublic + createdAt 등)를 파일에 합친 뒤에만 쓰세요.

### 4-2. 이미 있던 스토리에 검색 열쇠 채우기 (7-5, 한 번만)

```
node scripts/cli.js reindex --dry
node scripts/cli.js reindex
```

- `--dry` 는 "몇 개를 고쳐야 하는지"만 보여 줍니다. 여러 번 실행해도 안전합니다.
- 새로 만든 스토리와 제목/태그를 고친 스토리는 자동으로 열쇠가 저장됩니다.

### 4-3. (선택) 속도제한 카운터 자동 삭제 TTL

Firestore → TTL → 정책 만들기: 컬렉션 그룹 `rateLimits`, 필드 `expireAt`.
안 켜도 됩니다. 하루 1번 정리(크론)가 만료된 카운터를 지웁니다.

## 5. 요청 크기 한도 (7-6)

- Vercel 함수는 요청 본문이 **4.5MB** 를 넘으면 우리 코드에 닿기 전에 413 으로 막습니다. (공식 문서 확인함)
- 우리 서버 한도: 일반 200KB, 장면 전체 저장 1.5MB. (`REQUEST_LIMITS`, 테스트가 4.5MB보다 작은지 검사함)
- 한글은 글자당 3바이트라서 장면이 아주 많은 스토리는 1.5MB 에 닿을 수 있습니다. 그때 사용자는 "요청이 너무 큽니다"(413)를 봅니다.

## 6. 배포 후 눈으로 확인

- [ ] `https://배포도메인/api/health` → `{"ok":true,"firestore":"connected"}`
- [ ] 디스코드 로그인 → 돌아오기 → 내 이름이 보임, 로그아웃 → 로그아웃됨
- [ ] 스토리 만들기 → 공개 → 둘러보기에 보임 → 디스코드에서 `/스토리목록` 에 보임
- [ ] 둘러보기에서 태그/검색어/인기순이 동작함
- [ ] 스토리 삭제 → 응답의 `cleanup` 이 `complete` (또는 `partial` 이면 크론/cli 정리 확인)
- [ ] 운영자 계정으로 신고 목록(`/api/admin/reports`)이 열림, 일반 계정은 404
- [ ] 폰으로 접속해서 에디터 모바일 모드(900px 이하)와 `web/index.html` 의 viewport 메타 확인
