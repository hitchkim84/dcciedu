# DCCI_EDU 교육센터 홈페이지 (Netlify)

## 1. 개요
대구상공회의소 교육센터 홈페이지(dcciedu.co.kr)입니다. Netlify(Personal 플랜)에서 운영하며, 데이터는 Supabase에 저장합니다.

## 2. 구조
- `public/`: 홈페이지(index.html)와 관리자 페이지(admin.html, 동작 코드는 admin.js) 등 정적 파일
- `netlify/functions/`: 서버리스 함수(`proxy.js`, `config.js`). `exports.handler = async (event, context)` 형태입니다.
- `netlify.toml`: 클라이언트가 호출하는 `/api/*` 경로를 `/.netlify/functions/*`로 연결하는 리다이렉트 설정
- `sql/`: Supabase SQL Editor에서 순서대로 실행하는 DB 설정 스크립트
- `public/vendor/`: 관리자 페이지가 쓰는 Supabase 라이브러리 (외부 CDN 대신 직접 제공, 버전 고정)
- `tests/proxy.test.js`: 서버 함수 테스트(가짜 Supabase 사용). `node --test tests/proxy.test.js`로 실행
- `tests/db/run.sh`: 실제 PostgreSQL 임시 DB에서 접근 규칙·함수 권한·동시 요청 제한·파기 기준 확인. `bash tests/db/run.sh` (PostgreSQL 설치 필요, 운영 DB는 건드리지 않음)
- `sql/check_security.sql`: 운영 DB 보안 상태 확인(읽기 전용, 아무것도 바꾸지 않음)

신청 정보는 Supabase DB에만 저장하며, 서버 코드에서 구글 시트 등 외부로 보내지 않습니다(로봇 확인용 토큰·IP만 Cloudflare로 보냄). 신청자 명단은 관리자 페이지에서 조회하고 CSV로 내려받습니다.

## 3. 실행 명령 및 의존성
- 의존성 설치: `npm install`
- 로컬 테스트 실행: `npm start` (또는 `npx netlify dev`)

## 4. 환경 변수 안내 (.env)
로컬 테스트 및 Netlify 대시보드(Site settings > Environment variables)에 다음 항목을 동일하게 등록해야 합니다.

- SUPABASE_URL: Supabase 프로젝트 URL
- SUPABASE_KEY: Supabase 익명(anon) 퍼블릭 키
- SUPABASE_SERVICE_ROLE_KEY: (필수) Supabase 서버 전용(service_role) 키. 신청 접수·신청 확인 조회·신청 인원 집계에 사용. 절대 외부에 노출 금지.
  Netlify에서 Secret으로 표시하고 Scopes는 Functions, Deploy contexts는 Production만 선택한다(Deploy Preview·Branch deploy에서 쓰지 않게).
- NAVER_CLIENT_ID: 네이버 지도 API 클라이언트 ID
- TURNSTILE_SITE_KEY: (필수) Cloudflare Turnstile 사이트 키 (공개값, 신청서 로봇 확인 위젯)
- TURNSTILE_SECRET: (필수) Cloudflare Turnstile 비밀 키. 없으면 신청을 받지 않는다(확인 없이 통과시키지 않음)
- TURNSTILE_DISABLED: (비상용) `true`로 두면 로봇 확인을 끈다. Cloudflare 장기 장애 등 비상시에만 쓰고 끝나면 지운다
- TURNSTILE_HOSTNAMES: (선택) 로봇 확인 토큰을 받을 사이트 주소. 기본 `dcciedu.co.kr,www.dcciedu.co.kr`

## 5. 테스트 배포와 운영 배포 분리 (GitHub & Netlify 연동)
잦은 코드 수정으로 인한 운영 크레딧 소모를 방지하려면 다음과 같이 환경을 분리하세요.
1. **브랜치 분리**: (현재 운영 배포 브랜치는 `netlify-test`입니다.) GitHub에서 운영용 브랜치와 테스트용 브랜치(dev 또는 staging)를 분리합니다.
2. **Netlify 연동**: Netlify에서 "Import from GitHub"로 저장소를 연결합니다.
3. **환경 분리 세팅**: Netlify 대시보드의 Environment variables에서 "Contexts"를 활용하여, Production 환경에는 실제 운영 DB 정보를, Deploy Previews 및 Branch Deploys에는 테스트용 DB 정보를 입력합니다.
4. **테스트 흐름**: 기능 수정 시 dev 브랜치에 Push하거나 Pull Request를 생성하면 Netlify가 자동으로 임시 주소(Deploy Preview)를 만들어 배포합니다. 이곳에서 테스트 DB로 안전하게 검증을 마친 후 main에 병합(Merge)하여 운영에 반영합니다.

## 6. 관리자 로그인
- 관리자 페이지는 이메일·비밀번호 다음에 인증 앱의 6자리 OTP를 입력해 로그인합니다(처음 한 번 QR 등록). 관리자 역할(`app_metadata.role = 'admin'`)이 있는 계정만 들어갈 수 있습니다.
- 비밀번호 변경은 Supabase SQL Editor에서 합니다. 실제 이메일·비밀번호는 저장소에 적지 않습니다.

## 6-2. 주요 기능과 SQL 파일
- 신청 접수: `atomic_course_apply` (`sql/06`, `sql/10`, `sql/12`) — 정원·마감·입력값 검증, 반복 신청 제한(잠금 후 계산), 서버 키로만 호출. 허니팟 + Turnstile 로봇 확인(호스트·action 확인, 확인 불가 시 거절)
- 신청 확인(신청자용): `lookup_my_applications` (`sql/08`, `sql/12`, `sql/13`) — 성명·휴대폰·이메일 일치 시 과정명·일시만 반환. 본인 인증은 아님(세 가지를 아는 사람은 조회 가능)
- 접근 규칙: `sql/12`가 courses·education_apply 규칙을 모두 지우고 관리자+OTP(aal2) 규칙만 다시 만든다(01·05·07·09의 규칙을 대체)
- 과정 삭제: 신청자가 있으면 삭제 불가(서버 + `sql/12`의 ON DELETE RESTRICT)
- 개인정보 자동 파기: `purge_old_applications` (`sql/12`) — 교육 종료일(`end_date`) + 1년 지난 신청만 삭제, 매월 1일 pg_cron. 종료일이 비어 있는 과정은 지우지 않으므로 관리자 페이지에서 종료일을 입력한다
- 조회 기록 정리: `purge_lookup_log` (`sql/12`) — 하루 지난 조회 기록 삭제, 매일 pg_cron
- 보안 상태 점검: `sql/check_security.sql`(읽기 전용) — 결과의 '확인 필요' 줄을 확인한다. 자동 실행 결과는 `sql/check_cron.sql`(읽기 전용)
- 검색 노출: `public/robots.txt`(관리자·API 제외), `public/sitemap.xml`, 탭 아이콘 `public/favicon.ico`

## 6-3. 디자인 CSS 재생성 (Tailwind)
외부 CDN을 쓰지 않고 `public/tailwind.css`를 미리 만들어 둡니다. HTML에 **새 Tailwind 클래스를 추가했을 때만** `site` 폴더에서 아래를 실행하고 결과 파일을 함께 커밋하세요.
```
npx tailwindcss@3.4.19 --content "public/*.html,public/admin.js" -o public/tailwind.css --minify
```
JS에서 클래스 이름을 문자열로 이어 붙여 만들면(예: 'bg-' + 색) 생성되지 않으니, 클래스 이름은 항상 전체를 그대로 적습니다.

## 6-1. 테스트 가이드
- 별도의 테스트용 Supabase 프로젝트(무료)를 생성한 뒤, 위 '테스트 배포' 환경변수에 연결하여 모의 검증을 진행하는 것을 권장합니다.
- 부득이 실제 DB로 테스트해야 한다면, 운영 중인 신청 내역과 섞이지 않도록 제목에 "[테스트]"가 포함된 가짜 교육을 생성해 진행하세요.

## 7. 월 크레딧 소비 추정 (Netlify Personal 플랜 - 플랜별 제공 크레딧은 Usage & billing에서 확인)
- **운영 배포 횟수**: 성공적인 빌드 1회당 약 10~15 크레딧 소모 (월 5회 미만 권장). PR을 통한 Deploy Preview도 빌드 크레딧을 소모하므로 꼭 필요할 때만 Push하세요.
- **웹 요청 및 대역폭**: 1GB 트래픽 당 약 20 크레딧. 정적 HTML 기반이므로 트래픽 소모는 매우 적습니다. (월 5GB 이하 예상 = 약 100 크레딧)
- **서버 실행(Functions)**: 호출 수 및 실행 시간(GB-s) 기반이나, 현재 규모에서는 무시할 수준입니다.
- **알림 설정**: Netlify 대시보드 > Billing > Team usage & billing에서 남은 크레딧을 확인하고, 80% 소진 시 이메일 알림이 오도록 설정할 수 있습니다. (유료 전환이나 자동 충전은 해제된 상태가 기본입니다.)
