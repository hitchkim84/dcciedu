# DCCI_EDU 작업 기준

대구상공회의소 교육센터 홈페이지(dcciedu.co.kr). 모든 작업은 아래 우선순위로 판단한다.
기준끼리 충돌하면 번호가 앞선 것을 따른다.

## 1. 보안 (개인정보 탈취, 해커 침입 방지)
- 신청자 개인정보(이름, 연락처, 이메일, 사업자번호 등)는 관리자만 조회할 수 있어야 한다. Supabase RLS로 막고, 서버 함수에서도 한 번 더 확인한다.
- 관리자 등급(`app_metadata.role`): `admin` = 슈퍼관리자(모든 기능, OTP 필수), `staff` = 일반관리자(명단 보기·엑셀 다운로드만, OTP 없음 — 2026-10 결정: 직원 수가 적고 조회만 가능). 등급은 화면(`admin.js`)·서버(`proxy.js`)·DB(`sql/14`) 세 곳에서 확인한다.
- 관리자 접속 기록: 명단 조회·엑셀 다운로드·삭제·과정 변경을 서버가 `admin_access_log`에 남긴다(서버 키로만 쓰기, 2년 보관 후 자동 삭제, `sql/14`). 기록에 실패하면 엑셀 다운로드를 막는다.
- 키·비밀번호·실제 관리자 이메일은 코드나 GitHub에 올리지 않는다. 저장소는 public이다. 비밀값은 Netlify 환경변수에만 둔다.
- 관리자 페이지는 아이디·비밀번호로 로그인한다(구글 로그인은 2026-10 시도 후 제거). 슈퍼관리자는 이메일 + 2단계 인증(Supabase TOTP OTP), 일반관리자는 아이디(`아이디@staff.dcciedu.co.kr` 계정)만. 슈퍼관리자 비밀번호는 다른 곳에서 쓰지 않는 16자 이상, 일반관리자는 12자 이상으로 한다.
- 과정 등록·수정·삭제와 신청 삭제(개별·일괄)는 슈퍼관리자 + OTP 통과(aal2)만, 명단 조회는 슈퍼관리자(aal2) 또는 일반관리자. 화면·서버(`proxy.js`)·DB(RLS, `sql/12`·`sql/14`) 세 곳에서 모두 확인한다. 운영 DB 상태는 `sql/check_security.sql`(읽기 전용)로 점검한다.
- 공개 뷰(`public_courses`)는 읽기만 허용한다. 뷰는 소유자 권한으로 동작해 RLS를 거치지 않으므로 새 뷰를 만들면 쓰기 권한을 회수한다.
- SECURITY DEFINER 함수는 `SET search_path = ''`로 만들고 표는 `public.`을 붙여 쓴다. 실행 권한은 필요한 역할(service_role)에만 준다.
- `SUPABASE_SERVICE_ROLE_KEY`는 서버 함수(`netlify/functions/`)에서만 쓰고, 브라우저로 내려보내지 않는다.
- 사용자 입력은 서버에서 검증하고, 화면에 출력할 때는 이스케이프한다(XSS 방지).
- 변경 후에는 개인정보가 새로 노출되는 경로가 생기지 않았는지 확인한다.
- 신청 정보는 Supabase DB에만 저장한다. 구글 시트 등 외부로 복사하지 않는다(2026-10 연동 제거).
- 입력값 검증은 서버(`proxy.js`)와 DB 함수(`atomic_course_apply`) 양쪽에 같은 기준으로 둔다.
- 가짜 신청 방지: 허니팟 칸 + Cloudflare Turnstile(`TURNSTILE_SITE_KEY`·`TURNSTILE_SECRET`). 키가 없거나 Cloudflare 확인이 안 되면 신청을 거절한다(비상시에만 `TURNSTILE_DISABLED=true`). 토큰의 호스트(dcciedu.co.kr)와 action(`apply`)도 확인한다. Cloudflare에는 확인 토큰·IP만 보내고 신청 내용은 보내지 않는다. 신청·조회 함수는 서버 키로만 호출(`sql/10`, `sql/13`).
- 신청 확인(홈페이지 '신청 확인'): 성명·휴대폰·이메일 3가지가 모두 일치할 때만 과정명·교육일시·신청일시를 보여준다. 본인 인증이 아니므로(세 가지를 아는 사람은 조회 가능) 개인정보는 돌려주지 않고, 틀려도 같은 답을 준다. 반복 조회 제한과 일치 확인은 DB 함수 `lookup_my_applications`(`sql/12`)에서 잠금 후 한다.
- 신청 삭제(관리자 명단의 '삭제'·체크 후 '선택 삭제'): 슈퍼관리자(OTP 통과)만, 화면 확인 창 → 서버(일괄은 최대 100건) → DB 규칙 순서로 확인한다. 삭제는 되돌릴 수 없다.
- 과정 삭제: 신청자가 있는 과정은 삭제할 수 없다(서버 확인 + DB `ON DELETE RESTRICT`, `sql/12`).
- 개인정보 파기: 교육 종료일(`courses.end_date`) + 1년이 지난 신청은 `purge_old_applications()`가 매월 자동 삭제(`sql/12`, pg_cron). 종료일이 없는 과정은 지우지 않으므로 관리자가 종료일을 입력한다. 자동 실행 성공 여부는 `sql/check_cron.sql`(읽기 전용)로 확인한다. 삭제 테스트는 운영 DB가 아닌 임시 DB(`tests/db/run.sh`)에서 한다.
- 외부 스크립트 금지: 디자인은 `public/tailwind.css`(미리 생성)만 쓴다. 관리자 페이지는 CSP로 외부·인라인 스크립트를 모두 막는다(코드는 `public/admin.js`, 버튼은 `data-action`으로 연결, onclick 금지). 홈페이지도 CSP로 허용한 외부 주소(Cloudflare·네이버 지도·글꼴)만 쓴다. 새 외부 주소가 필요하면 `netlify.toml` CSP에 추가.
- 관리자 로그인 정보는 브라우저 탭 안(sessionStorage)에만 두고, 30분 동안 조작이 없으면 자동 로그아웃한다.
- `SUPABASE_SERVICE_ROLE_KEY`·`TURNSTILE_SECRET`은 Netlify에서 Production 배포에만 쓰이게 한다(Deploy Preview 제외). 공개 저장소라 외부인의 PR 미리보기가 비밀값을 읽을 수 있기 때문.
- API CORS는 `https://dcciedu.co.kr`만 허용한다.

## 2. 홈페이지 안정성
- 운영 배포 브랜치는 `netlify-test`다. 여기에 머지하면 바로 실제 사이트에 배포된다.
- 수정은 작업 브랜치에 모아 두고, 사용자가 확인한 뒤 마지막에 한 번만 배포한다(Netlify 크레딧 절약). PR도 그때 만든다.
- 배포 전에 `site`에서 `node --test tests/proxy.test.js`를 실행해 통과를 확인한다. SQL을 바꿨으면 `bash tests/db/run.sh`(실제 PostgreSQL 임시 DB)도 통과해야 한다. 가짜 DB 테스트 결과만으로 실제 차단을 주장하지 않는다.
- `netlify.toml`이 `site` 안에 있으므로 Netlify Base directory는 `site`이다. 폴더 이름이나 `netlify.toml`을 바꾸면 Netlify 설정도 함께 바꿔야 한다.
- DB 변경은 `site/sql/`에 번호를 붙인 SQL 파일로 남긴다. 여러 번 실행해도 안전하게 작성하고, Supabase SQL Editor에서 직접 실행한다.

## 3. 쉬운 수정
- 구조는 단순하게 유지한다. 정적 HTML(`public/`), 서버 함수(`netlify/functions/`), SQL(`sql/`).
- 새 라이브러리나 빌드 단계를 늘리지 않는다.
- 주석과 문서는 한국어로, 파일 인코딩은 UTF-8로 쓴다.

## 직원 계정(일반관리자) 관리
- 직원마다 개인 계정(공용 계정·공용 비밀번호 금지). Supabase 회원가입은 막고 슈퍼관리자가 만든다.
- 만들기: Supabase → Authentication → Users → Add user(이메일 `아이디@staff.dcciedu.co.kr`, Auto Confirm) → SQL Editor에서 `UPDATE auth.users SET raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"staff"}'::jsonb WHERE email = '아이디@staff.dcciedu.co.kr';` (실행 후 쿼리 삭제)
- 퇴사·이동 시 바로 Delete user. 접속 기록은 SQL Editor에서 `SELECT * FROM admin_access_log ORDER BY created_at DESC LIMIT 100;`로 월 1회 확인한다.

## 계정·소유 구조와 업무 인계 (비밀번호 등 실제 값은 적지 않는다)
| 구성 | 소유 | 로그인 |
|---|---|---|
| 코드 (GitHub `hitchkim84/dcciedu`) | 개인 | 개인 GitHub |
| 배포 (Netlify `dcciedu.co.kr`) | 회사 | 회사 구글 계정 |
| DB (Supabase 조직 `DCCI_EDU`) | 개인 + 회사 공동 Owner | 각자 GitHub (회사 Supabase는 회사 GitHub로 로그인) |
| 관리자 페이지 | 회사 | 회사 이메일 + 관리자 비밀번호 |

- 모든 계정은 2단계 인증을 켠다. 회사 일은 회사 전용 크롬 프로필에서만 한다(개인·회사 GitHub 혼동 방지).

인계할 때 순서
1. 관리자 페이지 OTP: 기존 인증 수단을 지우고 새 담당자 휴대폰으로 다시 등록. Supabase SQL Editor에서 `DELETE FROM auth.mfa_factors WHERE user_id = (SELECT id FROM auth.users WHERE raw_app_meta_data ->> 'role' = 'admin');` 실행 후 관리자 페이지에 다시 로그인하면 QR 등록 화면이 나온다. (휴대폰 분실 때도 같은 방법)
2. 회사 구글 계정: 비밀번호 변경 → 2단계 인증 기기를 새 담당자 휴대폰으로 변경 → 백업 코드 재발급 후 회사가 관리하는 곳에 보관 → 옛 기기 로그아웃.
3. 회사 GitHub 계정: 비밀번호 변경 → 2단계 인증 기기 변경 → 복구 코드 재발급.
4. 관리자 페이지 비밀번호 변경 (Supabase SQL Editor, 실행 후 쿼리 삭제).
5. Supabase `DCCI_EDU`: 새 담당자 확인 후 개인 계정 Owner 제외.
6. 코드: 회사 쪽 GitHub에 사본을 만들고 Netlify 연결을 그쪽으로 바꾼다(개인 저장소는 넘기지 않음).
7. 도메인(dcciedu.co.kr)과 Netlify 결제 수단이 회사 명의인지 확인.
