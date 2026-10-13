[사진 업로드 기능 설치/업데이트 방법]
1) 이 zip 안의 폴더를 프로젝트 맨 위 폴더에 "덮어쓰기" 로 풀기
   (새 파일만 들어 있어서 기존 파일은 지워지지 않아요)
2) 처음 설치할 때만:  npm install @vercel/blob
3) 처음 설치할 때만:  node scripts/apply-upload-patch.mjs   (이미 했다면 건너뛰어도 됩니다. 다시 해도 안전)
4) 테스트:  node --test test/uploads.test.js   <- 10개 통과하면 성공
5) Vercel 환경 변수: UPLOAD_STORAGE_LIMIT_MB=1024, UPLOAD_MONTHLY_OPS_LIMIT=2000
6) git push
