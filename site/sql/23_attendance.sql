-- 23. 교육 출석 표시
-- 관리자 페이지 신청자 명단의 '출석' 칸에서 슈퍼관리자가 교육 당일 출석을 체크하면 체크한 시각을 남긴다(체크 해제 시 지움).
-- 결과보고용 실제 참석 인원, 만족도 조사 발송 대상(체크한 사람이 없으면 출석한 사람), 나중에 수료증 기준으로 쓴다.
-- 서버는 관리자 로그인 키로 바꾸므로 신청 표의 기존 수정 규칙(sql/12: 슈퍼관리자 + OTP만 수정)이 그대로 적용된다.
-- 홈페이지 배포 전에 실행한다(실행 전에 배포하면 출석 체크가 저장되지 않는다). 여러 번 실행해도 안전하다.

ALTER TABLE public.education_apply ADD COLUMN IF NOT EXISTS attended_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- 확인: 1줄(attended_at, timestamp with time zone)
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'education_apply' AND column_name = 'attended_at';
