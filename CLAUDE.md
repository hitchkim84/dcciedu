# DCCI_EDU 작업 기준

대구상공회의소 교육센터 홈페이지(dcciedu.co.kr). 모든 작업은 아래 우선순위로 판단한다.
기준끼리 충돌하면 번호가 앞선 것을 따른다.

## 1. 보안 (개인정보 탈취, 해커 침입 방지)
- 신청자 개인정보(이름, 연락처, 이메일, 사업자번호 등)는 관리자(`app_metadata.role = 'admin'`)만 조회할 수 있어야 한다. Supabase RLS로 막고, 서버 함수에서도 한 번 더 확인한다.
- 키·비밀번호·실제 관리자 이메일은 코드나 GitHub에 올리지 않는다. 저장소는 public이다. 비밀값은 Netlify 환경변수에만 둔다.
- 관리자 페이지는 이메일·비밀번호 + 2단계 인증(Supabase TOTP OTP)으로 로그인한다(구글 로그인은 2026-10 시도 후 제거). 관리자 비밀번호는 다른 곳에서 쓰지 않는 16자 이상으로 한다.
- 신청자 조회·과정 수정은 관리자 역할과 OTP 통과(aal2)를 화면·서버(`proxy.js`)·DB(RLS, `sql/07`) 세 곳에서 모두 확인한다.
- `SUPABASE_SERVICE_ROLE_KEY`는 서버 함수(`netlify/functions/`)에서만 쓰고, 브라우저로 내려보내지 않는다.
- 사용자 입력은 서버에서 검증하고, 화면에 출력할 때는 이스케이프한다(XSS 방지).
- 변경 후에는 개인정보가 새로 노출되는 경로가 생기지 않았는지 확인한다.
- 신청 정보는 Supabase DB에만 저장한다. 구글 시트 등 외부로 복사하지 않는다(2026-10 연동 제거).
- 입력값 검증은 서버(`proxy.js`)와 DB 함수(`atomic_course_apply`) 양쪽에 같은 기준으로 둔다.

## 2. 홈페이지 안정성
- 운영 배포 브랜치는 `netlify-test`다. 여기에 머지하면 바로 실제 사이트에 배포된다.
- 수정은 작업 브랜치에 모아 두고, 사용자가 확인한 뒤 마지막에 한 번만 배포한다(Netlify 크레딧 절약). PR도 그때 만든다.
- 배포 전에 `site`에서 `node --test tests/proxy.test.js`를 실행해 통과를 확인한다.
- `netlify.toml`이 `site` 안에 있으므로 Netlify Base directory는 `site`이다. 폴더 이름이나 `netlify.toml`을 바꾸면 Netlify 설정도 함께 바꿔야 한다.
- DB 변경은 `site/sql/`에 번호를 붙인 SQL 파일로 남긴다. 여러 번 실행해도 안전하게 작성하고, Supabase SQL Editor에서 직접 실행한다.

## 3. 쉬운 수정
- 구조는 단순하게 유지한다. 정적 HTML(`public/`), 서버 함수(`netlify/functions/`), SQL(`sql/`).
- 새 라이브러리나 빌드 단계를 늘리지 않는다.
- 주석과 문서는 한국어로, 파일 인코딩은 UTF-8로 쓴다.

## 나중에 할 일: 직원과 관리자 페이지 공유 (아직 검토 전)
공유가 필요해지면 아래를 먼저 갖춘다.
- 직원마다 개인 계정 (공용 계정·공용 비밀번호 금지). Supabase 회원가입은 막고 관리자가 초대한다.
- 2단계 인증(OTP) 적용.
- 권한 분리: 직원은 신청자 조회·CSV만, 과정 등록·수정·삭제는 관리자만.

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
