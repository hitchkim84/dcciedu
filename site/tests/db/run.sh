#!/usr/bin/env bash
# 실제 PostgreSQL에서 접근 규칙(RLS)·함수 권한·동시 요청 제한·파기 기준을 확인하는 테스트.
# 운영 DB가 아니라 이 스크립트가 만드는 임시 DB에서만 실행된다(끝나면 삭제).
# 필요: PostgreSQL 14 이상(initdb, pg_ctl, psql). 실행: bash tests/db/run.sh  (site 폴더에서)
# 주의: Supabase를 흉내 낸 것이라 Supabase Auth(MFA 등록·해제 규칙)는 확인하지 못한다.
set -euo pipefail
cd "$(dirname "$0")/../.."
PGBIN="${PGBIN:-$(dirname "$(command -v initdb 2>/dev/null || echo /usr/lib/postgresql/16/bin/initdb)")}"
TMP="$(mktemp -d)"
PORT="${PGPORT_TEST:-55432}"
cleanup() { "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses='' -c max_connections=100" -l "$TMP/log" -w start >/dev/null
export PGOPTIONS="-c client_min_messages=warning"
PSQL=("$PGBIN/psql" -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
run_sql() { sed '/CREATE EXTENSION IF NOT EXISTS pg_cron/d' "$1" | "${PSQL[@]}" -o /dev/null; }

fail=0
pass() { echo "  통과: $1"; }
bad() { echo "  실패: $1"; fail=1; }

# 1) 운영 DB가 거쳐 온 순서대로 만든다 (01의 옛 규칙이 남은 최악의 경우 포함)
"${PSQL[@]}" -f tests/db/supabase_stub.sql -o /dev/null
run_sql ../supabase_schema.sql
for f in sql/01_setup.sql sql/03_add_apply_function.sql sql/04_apply_list_view.sql sql/05_admin_only_policies.sql \
         sql/06_apply_validation.sql sql/07_admin_require_mfa.sql sql/08_lookup_applications.sql \
         sql/09_admin_delete_application.sql sql/10_apply_server_only.sql sql/11_purge_old_applications.sql; do
  run_sql "$f"
done
"${PSQL[@]}" -f tests/db/fixtures.sql -o /dev/null

# 동시 요청: 같은 전화번호로 N개를 같은 순간에 보낸다. 성공 건수를 돌려준다.
concurrent_apply() {
  local n=$1 phone=$2 start
  start=$("${PSQL[@]}" -At -c "SELECT (clock_timestamp() + interval '1.5 seconds')::text")
  for i in $(seq 1 "$n"); do
    ( "${PSQL[@]}" -At -c "SELECT pg_sleep(greatest(0, extract(epoch FROM '$start'::timestamptz - clock_timestamp())))" -o /dev/null \
        -c "SET ROLE service_role" \
        -c "SELECT public.atomic_course_apply('11111111-1111-1111-1111-111111111111', 'req-$phone-$i', '회사', '', '', '', '동시$i', '$phone', 'c$i@example.com', true, NULL, NULL)" \
        >/dev/null 2>&1 && echo ok || echo no ) > "$TMP/r$i" &
  done
  wait
  cat "$TMP"/r* | grep -c '^ok$' || true
  rm -f "$TMP"/r*
}
concurrent_lookup() {
  local n=$1 phone=$2 start
  start=$("${PSQL[@]}" -At -c "SELECT (clock_timestamp() + interval '1.5 seconds')::text")
  for i in $(seq 1 "$n"); do
    ( "${PSQL[@]}" -At -c "SELECT pg_sleep(greatest(0, extract(epoch FROM '$start'::timestamptz - clock_timestamp())))" -o /dev/null \
        -c "SET ROLE service_role" \
        -c "SELECT count(*) FROM public.lookup_my_applications('홍길동', '$phone', 'x@example.com')" \
        >/dev/null 2>&1 && echo ok || echo no ) > "$TMP/r$i" &
  done
  wait
  cat "$TMP"/r* | grep -c '^ok$' || true
  rm -f "$TMP"/r*
}

echo "[적용 전] 옛 함수(sql/06·08)의 동시 요청 제한 (제한 5건)"
"${PSQL[@]}" -c "GRANT EXECUTE ON FUNCTION lookup_my_applications(text,text,text) TO service_role" -o /dev/null
before_apply=$(concurrent_apply 20 010-1111-0001)
before_lookup=$(concurrent_lookup 20 010-2222-0001)
echo "  신청 20건 동시 → 성공 $before_apply 건 / 조회 20건 동시 → 성공 $before_lookup 건 (5를 넘으면 경쟁 조건 재현)"

echo "[적용 전] 비로그인(anon)이 공개 뷰(public_courses)로 과정을 고칠 수 있는지"
view_write=$("${PSQL[@]}" -At -c "BEGIN" -c "SET LOCAL ROLE anon" -c "WITH x AS (UPDATE public_courses SET place = place RETURNING 1) SELECT count(*) FROM x" -c "ROLLBACK" 2>&1 | tail -1)
echo "  결과: $view_write (숫자가 나오면 수정 가능 = 문제 재현, 되돌림 처리함)"

check_report() { "${PSQL[@]}" -At -F ' | ' -f <(sed -n '1,/^ORDER BY 1, 2;/p' sql/check_security.sql) > "$TMP/check.txt"; }
echo "[적용 전] check_security.sql 판정 (옛 규칙·권한 문제가 드러나야 함)"
check_report
grep '확인 필요' "$TMP/check.txt" | sed 's/^/  /' || true
before_issues=$(grep -c '확인 필요' "$TMP/check.txt" || true)
[ "$before_issues" -gt 0 ] && pass "적용 전 문제 $before_issues 건 발견" || bad "적용 전인데 문제가 발견되지 않음"

# 2) 이번 보강 적용 (두 번 실행해서 재실행 안전성도 확인)
run_sql sql/12_security_hardening.sql
run_sql sql/12_security_hardening.sql
run_sql sql/13_lookup_server_only.sql
run_sql sql/14_staff_role_access_log.sql
run_sql sql/14_staff_role_access_log.sql

echo "[적용 후] check_security.sql 판정 (종료일 미입력만 남아야 함)"
check_report
grep '확인 필요' "$TMP/check.txt" | sed 's/^/  /' || true
leftover=$(grep '확인 필요' "$TMP/check.txt" | grep -vc '종료일 미입력' || true)
[ "$leftover" = "0" ] && pass "규칙·권한·함수·과정삭제 항목 모두 정상" || bad "확인 필요 항목 $leftover 건"

echo "[적용 후] 동시 요청 제한"
after_apply=$(concurrent_apply 20 010-1111-0002)
after_lookup=$(concurrent_lookup 20 010-2222-0002)
[ "$after_apply" = "5" ] && pass "신청 20건 동시 → 정확히 5건 성공" || bad "신청 20건 동시 → $after_apply 건 성공"
[ "$after_lookup" = "5" ] && pass "조회 20건 동시 → 정확히 5건 성공" || bad "조회 20건 동시 → $after_lookup 건 성공"

echo "[적용 후] 접근 규칙·권한·파기"
if PGOPTIONS="-c client_min_messages=notice" "${PSQL[@]}" -f tests/db/checks.sql > "$TMP/checks.log" 2>&1; then
  grep -o 'NOTICE:  .*' "$TMP/checks.log" | sed 's/NOTICE:  /  통과: /'
else
  bad "checks.sql"; cat "$TMP/checks.log"
fi

[ "$fail" = "0" ] && echo "결과: 모두 통과" || { echo "결과: 실패 있음"; exit 1; }
