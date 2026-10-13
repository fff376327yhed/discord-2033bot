[사진 업로드 기능 설치 방법]
1) 이 zip 안의 폴더를 프로젝트 맨 위 폴더에 "덮어쓰기" 로 풀기
   (새 파일만 들어 있어서 기존 파일은 지워지지 않아요)
2) 터미널:  npm install @vercel/blob
3) 터미널:  node scripts/apply-upload-patch.mjs     <- 기존 3개 파일에 자동 연결
4) 터미널:  node --test test/uploads.test.js          <- 6개 통과하면 성공
5) Vercel → Storage → Blob 만들기 → 프로젝트 연결
6) git push
