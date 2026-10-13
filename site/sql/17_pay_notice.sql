-- 17. 교육비 입금 안내 알림톡 발송 시각
-- 관리자 페이지 신청자 명단의 '입금안내' 버튼으로 보낸 시각을 남겨 같은 안내를 실수로 두 번 보내지 않게 한다.
-- 발송 시각은 서버(서비스 키)가 기록한다. 조회·수정 권한은 신청 표의 기존 규칙(sql/12·14)을 그대로 따른다.
-- 홈페이지 배포 전에 실행한다(배포 후 실행하면 그 사이 '입금안내' 발송 기록이 남지 않는다). 여러 번 실행해도 안전하다.

ALTER TABLE public.education_apply ADD COLUMN IF NOT EXISTS pay_notice_sent_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- 확인: 1줄(pay_notice_sent_at, timestamp with time zone)
SELECT column_name, data_type FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'education_apply' AND column_name = 'pay_notice_sent_at';
