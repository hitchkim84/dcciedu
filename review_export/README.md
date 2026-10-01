# 대구상공회의소 교육센터 홈페이지 (코드 검토용본 v2)

본 저장소는 대구상공회의소 교육센터 홈페이지의 외부 코드 검토(Code Review)를 위해 준비된 프로젝트입니다.

## 📁 프로젝트 구조
- `public/`: 프론트엔드 정적 파일 (HTML, CSS, JS, 이미지)
- `api/`: Vercel Serverless Functions (백엔드 로직)
- `.env.example`: 프로젝트 구동에 필요한 환경 변수 목록

## ⚠️ 미포함 항목 및 수동 추가 가이드 (필수)
외부 코드 검토를 완벽하게 수행하기 위해, 프로젝트 소스코드 외부에 존재하는 데이터베이스 및 외부 스크립트 정보가 추가로 필요합니다. 
아래 절차에 따라 자료를 직접 복사하여 이 폴더에 추가해 주시기 바랍니다.

### 1. Supabase DB 구조 및 접근 권한 (SQL 및 RLS)
해당 자료는 로컬 소스코드에 존재하지 않으므로 직접 추출하셔야 합니다.
**[추출 방법]**
1. [Supabase 대시보드](https://app.supabase.com/)에 로그인하여 프로젝트를 선택합니다.
2. 왼쪽 메뉴에서 **SQL Editor**를 클릭하고 **New Query**를 엽니다.
3. 스키마 및 권한(RLS) 추출을 위해 우측 상단의 템플릿 중 백업 관련 스크립트를 사용하거나, 왼쪽 메뉴 **Table Editor**와 **Authentication > Policies** 화면을 직접 캡처/복사합니다.
4. **특히 확인할 화면:**
   - Database > Tables: 테이블 제약조건, 트리거
   - Authentication > Policies: `education_apply`, `courses` 테이블의 RLS 활성화 여부 및 구체적인 Policy (anon/authenticated 권한)
5. 추출한 내용을 텍스트 파일(예: `supabase_schema_rls.sql`)로 만들어 본 ZIP 폴더에 추가해 주세요. (개인정보는 절대 포함하지 마세요)

### 2. 구글 Apps Script 코드
`GOOGLE_SCRIPT_URL`에 연결된 백엔드 로직은 구글 서버에 있으므로 직접 코드를 복사하셔야 합니다.
**[추출 방법]**
1. 연동된 **구글 스프레드시트**를 엽니다.
2. 상단 메뉴에서 **확장 프로그램 > Apps Script**를 클릭합니다.
3. 열리는 편집기(Code.gs) 화면의 모든 코드를 복사합니다.
4. 이 코드를 `google_apps_script.js` 라는 파일로 만들어 이 폴더에 추가해 주세요.
*(주의: 코드 내에 비밀번호나 인증 토큰이 하드코딩되어 있다면 해당 부분만 `REVIEW_REDACTED`로 글자를 수정해서 저장해 주세요.)*

### 3. Supabase 키 종류 (Vercel 환경 변수)
현재 로컬(개발자 PC)의 `.env` 파일에 기록된 `SUPABASE_KEY`의 토큰을 분석해본 결과, 해당 키는 **`anon` (공개용) 키**로 확인되었습니다. 
하지만 실제 서비스되는 Vercel 서버에 어떤 키가 등록되어 있는지는 코드상으로 접근이 불가능합니다.
**[추출 및 확인 방법]**
1. [Vercel 대시보드](https://vercel.com/)에 로그인하여 프로젝트를 선택합니다.
2. **Settings > Environment Variables** 메뉴로 이동합니다.
3. `SUPABASE_KEY` 값을 복사합니다.
4. [jwt.io](https://jwt.io/) 사이트에 접속해 복사한 값을 붙여넣고 우측 Payload 화면에서 `"role"` 값이 `"anon"` 인지 `"service_role"` 인지 확인하여 검토자에게 알려주시면 됩니다. (키 값 자체는 유출하지 마세요)

---
## 🔐 보안 처리 내역
- 원본 소스코드 내에 하드코딩된 비밀정보나 민감한 신청자 개인정보는 없습니다. (모든 인증 정보는 환경 변수를 통하도록 설계됨)
- 따라서 코드 내에 `REVIEW_REDACTED` 로 치환한 별도의 항목은 없습니다.
