-- 18. 교육비 입금 확인 표시
-- 관리자 페이지 신청자 명단의 '입금확인' 칸에서 슈퍼관리자가 입금을 확인하면 체크한 시각을 남긴다(체크 해제 시 지움).
-- 서버는 관리자 로그인 키로 바꾸므로 신청 표의 기존 수정 규칙(sql/12: 슈퍼관리자 + OTP만 수정)이 그대로 적용된다.
-- 홈페이지 배포 전에 실행한다(실행 전에 배포하면 입금확인 체크가 저장되지 않는다). 여러 번 실행해도 안전하다.

ALTER TABLE public.education_apply ADD COLUMN IF NOT EXISTS paid_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- 확인: 1줄(paid_at, timestamp with time zone)
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'education_apply' AND column_name = 'paid_at';
