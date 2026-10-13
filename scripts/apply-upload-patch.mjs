// 사진 업로드 기능을 기존 파일 3개에 "자동으로" 연결해 주는 스크립트.
// 사용법(프로젝트 맨 위 폴더에서):  node scripts/apply-upload-patch.mjs
// - 바꾸기 전에 원본을 *.bak-upload 로 복사해 둔다. (문제가 생기면 이 파일로 되돌리면 된다)
// - 이미 적용했으면 건너뛴다. 두 번 실행해도 안전하다.
// - 끼워 넣을 자리를 못 찾으면 그 파일은 건드리지 않고 "손으로 하는 방법"을 알려준다.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const targets = [
  {
    file: 'src/bundle.js',
    edits: [
      {
        name: 'import 한 줄 추가',
        done: "from './uploads.js'",
        re: /^(import \{ getFirestore, FieldValue \} from 'firebase-admin\/firestore';)\n/m,
        to: "$1\nimport { registerUploadRoutes } from './uploads.js';\n",
        manual: "맨 위 import 들 끝에  import { registerUploadRoutes } from './uploads.js';  한 줄 추가",
      },
      {
        name: 'createWebRouter 끝에 업로드 주소 연결',
        done: 'registerUploadRoutes({',
        re: /(\n)  return router;\n\}\n\n(?=\/\/ ═+\n\/\/ 7-6:)/,
        to: "$1  // 사진 업로드 (Vercel Blob). 일반 유저는 제한, 운영자는 무제한 + 사용량 보기\n  registerUploadRoutes({ router, requireAuth, requireAdmin, writeLimiter, getDb, isAdminId, HttpError, wrap, FieldValue });\n\n  return router;\n}\n\n",
        manual: 'createWebRouter 함수 맨 끝 "return router;" 바로 위에  registerUploadRoutes({ router, requireAuth, requireAdmin, writeLimiter, getDb, isAdminId, HttpError, wrap, FieldValue });  추가',
      },
    ],
  },
  {
    file: 'web/src/Editor.jsx',
    edits: [
      {
        name: 'ImageUploader import 추가',
        done: "from './ImageUploader.jsx'",
        re: /^(import \{[^}]*\} from '\.\/lib\.js';)\n/m,
        to: "$1\nimport ImageUploader from './ImageUploader.jsx';\n",
        manual: "맨 위 import 들 끝에  import ImageUploader from './ImageUploader.jsx';  추가",
      },
      {
        name: '이미지 주소 입력칸을 업로더로 교체',
        done: '<ImageUploader',
        re: /( *)<div className="field">\n\s*<label>이미지 주소[^\n]*<\/label>\n\s*<input value=\{scene\.imageUrl[^\n]*\n\s*<\/div>\n/,
        to: '$1<ImageUploader value={scene.imageUrl} onChange={(url) => onChange({ imageUrl: url })} />\n',
        manual: '"이미지 주소" label 이 있는 <div className="field"> ... </div> 덩어리를  <ImageUploader value={scene.imageUrl} onChange={(url) => onChange({ imageUrl: url })} />  한 줄로 교체',
      },
    ],
  },
  {
    file: 'web/src/App.jsx',
    edits: [
      {
        name: 'StorageMonitor import 추가',
        done: "from './StorageMonitor.jsx'",
        re: /^(import Editor from '\.\/Editor\.jsx';)\n/m,
        to: "$1\nimport StorageMonitor from './StorageMonitor.jsx';\n",
        manual: "맨 위 import 들 끝에  import StorageMonitor from './StorageMonitor.jsx';  추가",
      },
      {
        name: '관리자 화면 맨 위에 사용량 카드 넣기',
        done: '<StorageMonitor',
        re: /(function AdminPanel\([^)]*\) \{[\s\S]*?\n  return \(\n    <div className="story-list">\n)(?=      <div style=\{\{ display: 'flex', gap: 8)/,
        to: '$1      <StorageMonitor />\n',
        manual: 'AdminPanel 의 return ( <div className="story-list"> 바로 아래에  <StorageMonitor />  추가',
      },
    ],
  },
];

let failed = 0;
for (const { file, edits } of targets) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.log(`❌ ${file}: 파일이 없습니다. (프로젝트 맨 위 폴더에서 실행했는지 확인하세요)`);
    failed += 1;
    continue;
  }
  const original = fs.readFileSync(full, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n'; // 윈도우(CRLF) 줄바꿈을 그대로 지킨다
  let text = original.replace(/\r\n/g, '\n');
  const problems = [];
  let changed = false;

  for (const edit of edits) {
    if (text.includes(edit.done)) { console.log(`⏭️  ${file}: ${edit.name} (이미 되어 있음)`); continue; }
    const matches = text.match(new RegExp(edit.re.source, edit.re.flags.replace('g', '') + 'g')) ?? [];
    if (matches.length !== 1) { problems.push(edit); continue; }
    text = text.replace(edit.re, edit.to);
    changed = true;
    console.log(`✅ ${file}: ${edit.name}`);
  }

  if (problems.length) {
    failed += 1;
    console.log(`⚠️  ${file}: 자동으로 못 끼운 곳이 있어서 이 파일은 바꾸지 않았어요. 손으로 하려면:`);
    problems.forEach((p) => console.log(`    - ${p.manual}`));
    continue;
  }
  if (changed) {
    fs.writeFileSync(`${full}.bak-upload`, original);
    fs.writeFileSync(full, text.replace(/\n/g, eol));
  }
}
console.log(failed ? '\n일부 파일은 손이 필요합니다. 위 안내를 확인하세요.' : '\n끝! 이제 npm install @vercel/blob 을 실행하세요.');
process.exit(failed ? 1 : 0);
