# DCCI_EDU Netlify Migration V7

## 1. 개요
대구상공회의소 교육센터 홈페이지를 Vercel에서 Netlify(Free 플랜)로 이전하기 위한 프로젝트입니다. 본 버전은 최신 보안 로직(V6 - 신청조회, 암호화, Rate Limit, 충돌 방지 등)이 모두 포함된 상태에서 Netlify 환경에 맞게 서버리스 함수가 재작성되었습니다.

## 2. 주요 변경 사항 (Vercel -> Netlify)
- **서버리스 함수 이동 및 문법 수정**: Vercel의 pi/config.js, pi/proxy.js를 
etlify/functions/ 디렉토리로 이동하고, Netlify Functions (AWS Lambda 형태) 문법인 exports.handler = async (event, context) 구조로 전면 개편했습니다.
- **경로 리다이렉트**: 기존 클라이언트(HTML)에서 호출하던 /api/proxy 경로를 그대로 유지하기 위해 
etlify.toml 파일에 리다이렉트 룰을 추가했습니다.
- **의존성 추가**: 로컬 테스트를 위해 
etlify-cli를 devDependencies에 추가했습니다.

## 3. 실행 명령 및 의존성
- 의존성 설치: 
pm install
- 로컬 테스트 실행: 
pm start (또는 
px netlify dev)

## 4. 환경 변수 안내 (.env)
로컬 테스트 및 Netlify 대시보드(Site settings > Environment variables)에 다음 항목을 동일하게 등록해야 합니다.

- SUPABASE_URL: Supabase 프로젝트 URL
- SUPABASE_KEY: Supabase 익명(anon) 퍼블릭 키
- SUPABASE_SERVICE_ROLE_KEY: Supabase 관리자(service_role) 키 (내부 권한 검증 및 조회용, 절대 외부에 노출 금지)
- ADMIN_EMAIL: 관리자용 이메일
- GOOGLE_SCRIPT_URL: 구글 Apps Script 배포 주소
- APPS_SCRIPT_SECRET: 구글 Apps Script 통신 시 사용할 암호 키

## 5. 테스트 배포와 운영 배포 분리 (GitHub & Netlify 연동)
잦은 코드 수정으로 인한 운영 크레딧 소모를 방지하려면 다음과 같이 환경을 분리하세요.
1. **브랜치 분리**: GitHub에서 main 브랜치는 실제 운영용으로, dev 또는 staging 브랜치는 테스트용으로 사용합니다.
2. **Netlify 연동**: Netlify에서 "Import from GitHub"로 저장소를 연결합니다.
3. **환경 분리 세팅**: Netlify 대시보드의 Environment variables에서 "Contexts"를 활용하여, Production 환경에는 실제 운영 DB 정보를, Deploy Previews 및 Branch Deploys에는 테스트용 DB 정보를 입력합니다.
4. **테스트 흐름**: 기능 수정 시 dev 브랜치에 Push하거나 Pull Request를 생성하면 Netlify가 자동으로 임시 주소(Deploy Preview)를 만들어 배포합니다. 이곳에서 테스트 DB로 안전하게 검증을 마친 후 main에 병합(Merge)하여 운영에 반영합니다.

## 6. 테스트 가이드
- 별도의 테스트용 Supabase 프로젝트(무료)와 테스트용 구글 시트를 생성한 뒤, 위 '테스트 배포' 환경변수에 연결하여 모의 검증을 진행하는 것을 권장합니다.
- 부득이 실제 DB로 테스트해야 한다면, 운영 중인 신청 내역과 섞이지 않도록 제목에 "[테스트]"가 포함된 가짜 교육을 생성해 진행하세요.

## 7. 월 크레딧 소비 추정 (Netlify Free 플랜 - 300 크레딧/월)
- **운영 배포 횟수**: 성공적인 빌드 1회당 약 10~15 크레딧 소모 (월 5회 미만 권장). PR을 통한 Deploy Preview도 빌드 크레딧을 소모하므로 꼭 필요할 때만 Push하세요.
- **웹 요청 및 대역폭**: 1GB 트래픽 당 약 20 크레딧. 정적 HTML 기반이므로 트래픽 소모는 매우 적습니다. (월 5GB 이하 예상 = 약 100 크레딧)
- **서버 실행(Functions)**: 호출 수 및 실행 시간(GB-s) 기반이나, 현재 규모에서는 무시할 수준입니다.
- **알림 설정**: Netlify 대시보드 > Billing > Team usage & billing에서 남은 크레딧을 확인하고, 80% 소진 시 이메일 알림이 오도록 설정할 수 있습니다. (유료 전환이나 자동 충전은 해제된 상태가 기본입니다.)

## 8. 도메인 전환 순서 (가비아 DNS)
테스트가 완료되면 다음 순서로 도메인을 Netlify로 전환합니다. (현재 Vercel 프로젝트는 유지)
1. Netlify 대시보드 > Domain management에서 Custom domain으로 기존 가비아 도메인을 추가합니다.
2. 가비아 DNS 설정 페이지에 접속합니다.
3. 기존 Vercel로 연결된 레코드(A 레코드 76.76.21.21 또는 CNAME cname.vercel-dns.com)를 삭제합니다.
4. Netlify용 레코드를 추가합니다:
   - A 레코드: @ (호스트) -> 75.2.60.5
   - CNAME 레코드: www (호스트) -> [본인사이트이름].netlify.app
5. 메일 관련 레코드(MX, TXT 등)는 **절대 건드리지 말고 보존**합니다.
6. DNS 전파(최대 24시간) 후 Netlify 대시보드 하단에서 'Verify DNS'를 클릭해 SSL(HTTPS) 인증서를 자동 발급받습니다. 문제가 생길 시 Vercel 레코드로 롤백하면 복구됩니다.
