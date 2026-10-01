# 대구상공회의소 교육센터 홈페이지 (코드 검토용본 v3)

본 저장소는 기업용 유료 교육 사이트에 필요한 트랜잭션, 동시성 제어, 보안 강화를 적용한 V3 아키텍처 검토용 프로젝트입니다.

## 📁 프로젝트 구조
- `public/`: 프론트엔드 정적 파일
- `api/proxy.js`: V3 적용된 서버리스 함수 (RBAC, RPC 호출, 동기화 재처리 등)
- `sql/01_setup.sql`: DB 보안 정책(RLS), 중복 방지 제약조건, 오버부킹 방지 RPC 함수
- `scripts/google_apps_script.js`: 구글 시트 중복 방지 및 덮어쓰기(Upsert) 스크립트
- `tests/`: 동시성 및 중복 방지 모의 테스트 스크립트와 결과

## ✨ V3 아키텍처 주요 변경 사항 (검증 항목)
1. **관리자 역할 검증 (RBAC):** `proxy.js`에서 JWT의 `role = admin` 여부를 확인하여 인가되지 않은 사용자의 삭제/수정을 완벽 차단.
2. **원자적 처리 (Atomic DB Transaction):** `sql/01_setup.sql`의 `atomic_course_apply` RPC를 통해 정원 조회와 저장을 `FOR UPDATE` 락으로 묶어, 1석 남았을 때 10명이 동시 접근해도 1명만 저장됨.
3. **중복 방지 및 멱등성 (Idempotency):** `course_id`, `email`, `biz_no` 묶음으로 UNIQUE 제약조건을 설정하여, 네트워크 재시도나 다중 클릭으로 인한 중복 데이터를 원천 차단.
4. **구글시트 연동 및 재처리:** `education_apply` 테이블에 `sync_status` 기록. `proxy.js`에 `retry_sync` 액션을 추가하여 누락 건 재전송 지원.
5. **Apps Script Upsert:** `apply_id`를 기준으로 기존 행을 찾아 업데이트만 수행하므로, 직원이 수기로 작성한 메모나 입금 상태 열은 보존됨.

## 🚀 배포 순서 및 복구 방법
운영 배포 시 **반드시 아래 순서대로** 진행해야 서비스 장애가 발생하지 않습니다.

1. **Supabase DB 적용:** `sql/01_setup.sql`을 Supabase SQL Editor에서 실행하여 컬럼, 제약조건, RLS, RPC를 생성.
2. **Google Apps Script 반영:** `scripts/google_apps_script.js` 코드를 구글 시트 Apps Script에 덮어쓰고 '새 버전으로 배포'.
3. **Vercel 운영 배포:** `api/proxy.js`와 `public/index.html` 변경사항을 GitHub main 브랜치에 Push하여 배포.

**(복구 방법)**
만약 시트 연동 실패 발생 시, 관리자 화면에서 해당 신청자의 `apply_id`를 담아 `action: "retry_sync"` API를 호출하면 시트에 정상적으로 반영되며 직원 메모도 그대로 유지됩니다.

## ⚠️ 확인 불가 항목 (수동 확인 필요 사항)
- 현재 제공된 코드는 로컬 수정본이며 실제 운영 DB의 기존 RLS 정책을 알 수 없습니다.
- Supabase의 `auth.users` 테이블과 연동된 `app_metadata.role` 설정(실제 관리자 권한 부여) 여부를 반드시 확인해야 합니다.
