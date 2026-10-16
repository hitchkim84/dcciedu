// 관리자 페이지 동작 코드 (admin.html에서 불러옴)
// CSP(netlify.toml)가 페이지 안 인라인 스크립트와 onclick 같은 속성 실행을 막으므로,
// 버튼은 data-action 속성으로 표시하고 아래 '버튼 동작 연결'에서 함수와 연결한다.
// ★★★ Netlify Functions 프록시 URL (netlify.toml에서 /api/* → 함수로 연결) ★★★
const scriptURL = '/api/proxy';

let supabaseClient;
let sessionToken = null; // JWT Access Token
let allCourses = {}; // 데이터 저장용
let statusCourses = []; // 신청자 현황 (명단 표/CSV용)
let editingCourseId = null; // 현재 수정 중인 ID
// 관리자 등급: admin = 슈퍼관리자(모든 기능, OTP 필수), staff = 일반관리자(명단 보기·엑셀 다운로드만, OTP 없음)
// 화면에서는 버튼만 숨기고, 실제 차단은 서버(proxy.js)와 DB 규칙(sql/14)이 한다.
const ROLE_LABELS = { admin: '슈퍼관리자', staff: '일반관리자' };
let currentRole = null;
// 일반관리자 아이디는 이 주소를 붙여 로그인한다(Supabase 계정 이메일: 아이디@staff.dcciedu.co.kr)
const STAFF_ID_DOMAIN = 'staff.dcciedu.co.kr';

// --- "이 PC 기억" (슈퍼관리자 OTP 입력 횟수 줄이기) ---
// 기본: 로그인 정보는 이 탭에만 보관(sessionStorage). 탭을 닫으면 사라지고 다른 탭과 공유하지 않는다.
// OTP 화면에서 "이 PC 기억"을 체크하면 30일 동안 이 브라우저(localStorage)에 보관해 탭을 다시 열어도 OTP를 묻지 않는다.
// 회사 PC에서만 체크한다. 로그아웃하거나 30일이 지나면 기억을 지우고(서버 재발급 토큰도 폐기) 다시 OTP를 묻는다.
const TRUST_KEY = 'dcciedu-admin-trusted-until';
const TRUST_DAYS = 30;
let purgingTrust = false; // 기억 기간이 끝난 로그인 정보를 지우는 중
function trustedUntil() {
    try { return Number(localStorage.getItem(TRUST_KEY)) || 0; } catch (e) { return 0; }
}
function isTrustedPc() {
    return trustedUntil() > Date.now();
}
function authStore() {
    return (isTrustedPc() || purgingTrust) ? localStorage : sessionStorage;
}
const authStorage = {
    getItem: k => authStore().getItem(k),
    setItem: (k, v) => authStore().setItem(k, v),
    removeItem: k => { localStorage.removeItem(k); sessionStorage.removeItem(k); }
};
function forgetThisPc() {
    try {
        localStorage.removeItem(TRUST_KEY);
        Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k));
    } catch (e) { /* 저장소를 못 쓰는 브라우저는 무시 */ }
}
// OTP 통과 직후 호출: 지금 탭의 로그인 정보를 이 PC(localStorage)로 옮긴다.
function rememberThisPc() {
    try {
        Object.keys(sessionStorage).filter(k => k.startsWith('sb-')).forEach(k => {
            localStorage.setItem(k, sessionStorage.getItem(k));
            sessionStorage.removeItem(k);
        });
        localStorage.setItem(TRUST_KEY, String(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000));
    } catch (e) {
        alert('이 브라우저에서는 "이 PC 기억"을 쓸 수 없습니다. 이번 탭에서만 로그인이 유지됩니다.');
    }
}

// Initialize Supabase and check session on load
async function initSupabase() {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        if (!config.supabaseUrl || !config.supabaseKey) {
            throw new Error("Supabase configuration is missing on the server.");
        }

        // 로그인 정보 보관 위치는 위 authStorage가 정한다(기본 이 탭, "이 PC 기억" 시 30일 동안 이 브라우저).
        supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseKey, {
            auth: { storage: authStorage, persistSession: true, autoRefreshToken: true }
        });

        // 기억 기간(30일)이 끝났으면 남은 로그인을 서버에서도 끊고 지운다.
        if (trustedUntil() && !isTrustedPc()) {
            purgingTrust = true;
            try { await supabaseClient.auth.signOut(); } catch (e) { /* 이미 만료된 경우 */ }
            purgingTrust = false;
            forgetThisPc();
        }

        // Listen to auth state changes
        // 콜백 안에서 Supabase 함수를 바로 부르면 멈출 수 있어 다음 차례로 미룬다.
        // 같은 브라우저의 다른 관리자 탭에서 로그아웃하면(자리 비움 자동 로그아웃 포함) 이 탭에도 SIGNED_OUT이 전달된다.
        supabaseClient.auth.onAuthStateChange((event, session) => {
            const byOtherTab = event === 'SIGNED_OUT' && !loggingOut &&
                (sessionToken || !document.getElementById('mfa-panel').classList.contains('hidden'));
            setTimeout(() => {
                applySession(session);
                if (byOtherTab) alert('다른 창(탭)에서 로그아웃되어 이 창도 로그아웃되었습니다. 다시 로그인해주세요.');
            }, 0);
        });

        // Check current session
        const { data: { session } } = await supabaseClient.auth.getSession();
        applySession(session);
        // 새로고침·브라우저 탭 복원 때도 그 전에 비어 있던 시간을 이어서 센다(아래 '자리 비움 자동 로그아웃').
        checkIdle();

    } catch (err) {
        console.error("Initialization Error:", err);
        alert("설정 로드 실패: " + err.message);
    }
}

// 로그인 상태를 화면에 반영한다. 관리자 역할이 없는 계정은 바로 로그아웃시킨다.
// JWT 안의 정보(관리자 역할, 인증 단계 aal)를 읽는다. 검증은 서버와 DB가 다시 한다.
function jwtClaims(token) {
    try {
        const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4)));
    } catch (e) {
        return {};
    }
}

let mfaFactorId = null; // 등록 또는 입력 중인 OTP 인증 수단 ID

function applySession(session) {
    if (session && !ROLE_LABELS[(session.user.app_metadata || {}).role]) {
        applySession(null);
        alert('관리자 권한이 없는 계정입니다.');
        supabaseClient.auth.signOut();
        return;
    }
    // 슈퍼관리자가 비밀번호만 통과한 상태(aal1)면 명단을 보여주지 않고 OTP 단계로 보낸다.
    // 일반관리자(staff)는 OTP 없이 들어간다(조회·엑셀만 가능, 서버·DB에서도 같은 기준).
    if (session && session.user.app_metadata.role === 'admin' && jwtClaims(session.access_token).aal !== 'aal2') {
        sessionToken = null;
        document.getElementById('admin-content').classList.add('hidden');
        document.getElementById('login-modal').classList.remove('hidden');
        showMfa();
        return;
    }
    hideMfa();
    if (session) {
        const isNew = sessionToken !== session.access_token;
        sessionToken = session.access_token;
        applyRole(session.user.app_metadata.role);
        document.getElementById('login-modal').classList.add('hidden');
        document.getElementById('admin-content').classList.remove('hidden');
        if (isNew) fetchStatus();
    } else {
        sessionToken = null;
        currentRole = null;
        document.getElementById('login-modal').classList.remove('hidden');
        document.getElementById('admin-content').classList.add('hidden');

        // 보안: 로그아웃 시 개인정보 데이터 메모리 및 화면에서 삭제
        document.getElementById('status-body').innerHTML = '';
        document.getElementById('manage-body').innerHTML = '';
        allCourses = {};
        statusCourses = [];
        openCourseIds.clear();
        document.getElementById('member-result').textContent = '';
        document.getElementById('member-biz').value = '';
        document.getElementById('member-file').value = '';
    }
}

// 등급에 따라 화면 구성: 일반관리자는 과정 등록·관리 탭을 숨긴다.
function applyRole(role) {
    const changed = currentRole !== role;
    currentRole = role;
    document.getElementById('role-label').textContent = '(' + ROLE_LABELS[role] + ')';
    const isSuper = role === 'admin';
    ['register', 'manage', 'members'].forEach(id => document.getElementById('tab-' + id).classList.toggle('hidden', !isSuper));
    if (changed && !isSuper) switchTab('status');
}

function isSuperAdmin() {
    return currentRole === 'admin';
}

window.onload = initSupabase;

function hideMfa() {
    mfaSeq++; // 준비 중이던 OTP 화면(showMfa)이 있으면 결과를 화면에 쓰지 않게 한다
    document.getElementById('mfa-remember').checked = false;
    mfaFactorId = null;
    document.getElementById('mfa-panel').classList.add('hidden');
    document.getElementById('mfa-enroll').classList.add('hidden');
    document.getElementById('mfa-qr').removeAttribute('src');
    document.getElementById('mfa-secret').textContent = '';
    document.getElementById('mfa-code').value = '';
    document.getElementById('login-form').classList.remove('hidden');
    document.getElementById('login-desc').textContent = '접근 권한을 확인하기 위해 아이디와 비밀번호를 입력해주세요.';
}

// OTP 단계: 등록된 인증 앱이 있으면 코드 입력, 없으면 QR 등록부터
let mfaLoading = false; // 같은 화면을 두 번 준비하지 않도록 (중복 등록 방지)
let mfaSeq = 0; // hideMfa가 부를 때마다 1 늘어난다. 준비 도중 로그아웃되면 값이 달라져 중단한다.
async function showMfa() {
    if (mfaLoading || (!document.getElementById('mfa-panel').classList.contains('hidden') && mfaFactorId)) return;
    mfaLoading = true;
    const seq = mfaSeq;
    document.getElementById('login-form').classList.add('hidden');
    document.getElementById('mfa-panel').classList.remove('hidden');
    try {
        const { data, error } = await supabaseClient.auth.mfa.listFactors();
        if (seq !== mfaSeq) return; // 기다리는 사이 로그아웃됨(다른 탭 등): 로그인 화면을 그대로 둔다
        if (error) throw error;
        const verified = data.totp || [];
        if (verified.length > 0) {
            mfaFactorId = verified[0].id;
            document.getElementById('mfa-enroll').classList.add('hidden');
            document.getElementById('login-desc').textContent = '2단계 인증: 인증 앱에 표시된 6자리 코드를 입력해주세요.';
        } else {
            // 끝내지 못한 이전 등록이 있으면 지우고 새로 등록한다.
            for (const f of (data.all || [])) {
                if (f.factor_type === 'totp' && f.status !== 'verified') {
                    await supabaseClient.auth.mfa.unenroll({ factorId: f.id });
                }
            }
            const { data: enrolled, error: enrollError } = await supabaseClient.auth.mfa.enroll({ factorType: 'totp', friendlyName: '관리자 OTP' });
            if (seq !== mfaSeq) return; // 끝내지 못한 등록은 다음 로그인 때 위에서 지운다
            if (enrollError) throw enrollError;
            mfaFactorId = enrolled.id;
            document.getElementById('mfa-qr').src = enrolled.totp.qr_code;
            document.getElementById('mfa-secret').textContent = enrolled.totp.secret;
            document.getElementById('mfa-enroll').classList.remove('hidden');
            document.getElementById('login-desc').textContent = '2단계 인증 등록: 처음 한 번만 하면 됩니다.';
        }
        document.getElementById('mfa-code').focus();
    } catch (err) {
        if (seq !== mfaSeq) return;
        alert('2단계 인증을 준비하지 못했습니다: ' + err.message);
        logout();
    } finally {
        mfaLoading = false;
    }
}

async function verifyMfa() {
    const codeInput = document.getElementById('mfa-code');
    const code = codeInput.value.trim();
    if (!/^[0-9]{6}$/.test(code) || !mfaFactorId) return alert('6자리 숫자를 입력해주세요.');
    const btn = document.getElementById('mfa-submit');
    btn.disabled = true;
    try {
        const { error } = await supabaseClient.auth.mfa.challengeAndVerify({ factorId: mfaFactorId, code });
        if (error) throw error;
        if (document.getElementById('mfa-remember').checked) rememberThisPc();
        const { data: { session } } = await supabaseClient.auth.getSession();
        applySession(session);
    } catch (err) {
        alert('코드가 맞지 않습니다. 인증 앱의 현재 코드를 다시 입력해주세요.');
        codeInput.value = '';
        codeInput.focus();
    } finally {
        btn.disabled = false;
    }
}

// Login Handler
async function tryLogin() {
    const emailInput = document.getElementById('login-email');
    const pwdInput = document.getElementById('login-password');
    const loginId = emailInput.value.trim();
    const password = pwdInput.value;

    if (!loginId || !password) return alert('아이디와 비밀번호를 모두 입력해주세요.');
    // '@'가 없으면 일반관리자 아이디로 보고 직원용 주소를 붙인다. 슈퍼관리자는 이메일 그대로 입력.
    const email = loginId.includes('@') ? loginId : `${loginId}@${STAFF_ID_DOMAIN}`;

    const btn = document.querySelector('#login-form button[type="submit"]');
    const originalText = btn.innerText;
    btn.innerText = "로그인 중...";
    btn.disabled = true;

    try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        // Success is handled by onAuthStateChange listener
        emailInput.value = '';
        pwdInput.value = '';
    } catch (err) {
        alert('로그인 실패: ' + err.message);
        pwdInput.value = '';
        pwdInput.focus();
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

// Logout Handler
// 로그아웃하면 "이 PC 기억"도 함께 지운다(다음 로그인 때 OTP를 다시 묻는다).
let loggingOut = false; // 이 탭에서 직접 로그아웃하는 중(다른 탭 로그아웃 안내를 띄우지 않음)
async function logout() {
    loggingOut = true;
    try {
        if (supabaseClient) {
            await supabaseClient.auth.signOut();
        }
    } finally {
        loggingOut = false;
    }
    forgetThisPc();
}

function switchTab(tabId) {
    if (tabId !== 'status' && !isSuperAdmin()) tabId = 'status'; // 일반관리자는 신청자 현황만
    // 버튼 스타일 초기화
    ['register', 'status', 'manage', 'members'].forEach(id => {
        const btn = document.getElementById('tab-' + id);
        if (btn) {
            btn.className = "py-2 px-4 text-gray-500 font-medium hover:text-gray-700 focus:outline-none transition-colors";
            if (id !== 'status' && !isSuperAdmin()) btn.classList.add('hidden'); // 일반관리자는 탭 숨김 유지
            btn.classList.remove('border-b-2', 'border-blue-600', 'text-blue-600', 'font-bold');
        }
        const section = document.getElementById('section-' + id);
        if (section) section.classList.add('hidden');
    });

    // 선택된 탭 활성화
    const activeHeader = document.getElementById('tab-' + tabId);
    if (activeHeader) {
        activeHeader.classList.remove('text-gray-500', 'font-medium');
        activeHeader.classList.add('text-blue-600', 'border-b-2', 'border-blue-600', 'font-bold');
    }

    const activeSection = document.getElementById('section-' + tabId);
    if (activeSection) activeSection.classList.remove('hidden');

    if (tabId === 'status') fetchStatus();
    if (tabId === 'manage') fetchManage();
    if (tabId === 'members') fetchMemberInfo();
}

// --- 기능 1: 과정 등록/수정 ---
function updateDateFromInputs() {
    const day = document.getElementById('input-date-day').value;
    const start = document.getElementById('input-date-start').value;
    const end = document.getElementById('input-date-end').value;

    if (!day || !start || !end) return false;

    const dateObj = new Date(day);
    const week = ['일', '월', '화', '수', '목', '금', '토'];
    const dayOfWeek = week[dateObj.getDay()];
    
    // YYYY-MM-DD -> YYYY. M. D
    const parts = day.split('-');
    const formattedDate = `${parts[0]}. ${parseInt(parts[1])}. ${parseInt(parts[2])}(${dayOfWeek}) ${start}~${end}`;
    document.getElementById('date').value = formattedDate;
    return true;
}

function submitCourse() {
    const btn = document.getElementById('btn-submit');
    const originalText = btn.innerText;

    if (!sessionToken) return alert('로그인 세션이 만료되었습니다. 다시 로그인해주세요.');

    // 일시 통합 업데이트
    if (!updateDateFromInputs()) {
        return alert('교육 일시(날짜, 시작시간, 종료시간)를 모두 입력해주세요.');
    }

    const actionType = editingCourseId ? "수정" : "등록";
    if (!confirm(`이대로 교육 과정을 ${actionType}하시겠습니까?`)) return;

    btn.innerText = "처리 중...";
    btn.disabled = true;

    const formData = new FormData();
    formData.append('action', editingCourseId ? 'update_course' : 'add_course');
    if (editingCourseId) formData.append('id', editingCourseId);

    // 데이터 매핑
    ['category', 'title', 'date', 'place', 'capacity', 'deadline', 'endDate', 'target', 'goal', 'content', 'instructor', 'instructorBio', 'contact', 'memberFee', 'nonmemberFee', 'cost', 'paymentInfo', 'otherInfo'].forEach(field => {
        const el = document.getElementById(field);
        if (el) formData.append(field, el.value);
    });

    const data = new URLSearchParams(formData);

    fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Bearer ' + sessionToken
        },
        body: data
    })
        .then(response => response.json())
        .then(result => {
            if (result.result === 'success') {
                alert(`✅ 교육 과정이 성공적으로 ${actionType}되었습니다!`);
                if (editingCourseId) cancelEdit(); // 수정 모드 종료
                else {
                    document.getElementById('courseForm').reset();
                }
            } else {
                alert(`⛔ ${actionType} 실패: ` + result.msg);
            }
            btn.innerText = originalText;
            btn.disabled = false;
        })
        .catch(error => {
            alert('서버 연결 실패: ' + error.message);
            console.error(error);
            btn.innerText = originalText;
            btn.disabled = false;
        });
}

// --- 기능 2: 신청자 현황 조회 ---
function fetchStatus() {
    const tbody = document.getElementById('status-body');
    if (!sessionToken) return; // 로그인 전이면 중단

    tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-10 text-center text-blue-600 font-bold"><span class="animate-pulse">데이터를 불러오는 중입니다...</span></td></tr>';

    fetch(scriptURL + '?type=admin', {
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + sessionToken
        }
    })
        .then(response => response.json())
        .then(data => renderStatusTable(data, tbody))
        .catch(err => handleError(tbody, err));
}

// 신청 1건 삭제: 확인 창을 거친 뒤 서버에 요청 (OTP 통과 관리자만 가능)
function deleteApplication(btn) {
    const id = btn.dataset.id;
    if (!id) return;
    if (!confirm(`이 신청을 삭제하시겠습니까?\n\n성명: ${btn.dataset.name}\n회사: ${btn.dataset.company}\n\n삭제 후에는 복구할 수 없습니다.`)) return;
    btn.disabled = true;
    fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Bearer ' + sessionToken
        },
        body: new URLSearchParams({ action: 'delete_application', id })
    })
        .then(response => response.json())
        .then(result => {
            if (result.result === 'success') {
                alert('🗑️ 삭제되었습니다.');
                fetchStatus();
            } else {
                alert('⛔ 삭제 실패: ' + result.msg);
                btn.disabled = false;
            }
        })
        .catch(err => { alert('오류 발생: ' + err); btn.disabled = false; });
}

// 체크한 신청 여러 건 삭제 (슈퍼관리자만, 한 번에 최대 100건)
function checkAll(box) {
    document.querySelectorAll(`.app-check[data-course="${box.dataset.idx}"]`).forEach(c => { c.checked = box.checked; });
}

function deleteSelected(btn) {
    const checked = [...document.querySelectorAll(`.app-check[data-course="${btn.dataset.idx}"]:checked`)];
    if (checked.length === 0) return alert('삭제할 신청을 체크해주세요.');
    if (checked.length > 100) return alert('한 번에 100건까지 삭제할 수 있습니다.');
    const names = checked.slice(0, 10).map(c => `- ${c.dataset.name} (${c.dataset.company})`).join('\n');
    const more = checked.length > 10 ? `\n외 ${checked.length - 10}건` : '';
    if (!confirm(`선택한 신청 ${checked.length}건을 삭제하시겠습니까?\n\n${names}${more}\n\n삭제 후에는 복구할 수 없습니다.`)) return;
    btn.disabled = true;
    fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Bearer ' + sessionToken
        },
        body: new URLSearchParams({ action: 'delete_applications', ids: checked.map(c => c.dataset.id).join(',') })
    })
        .then(response => response.json())
        .then(result => {
            if (result.result === 'success') {
                alert(`🗑️ ${result.deleted}건 삭제되었습니다.`);
                fetchStatus();
            } else {
                alert('⛔ 삭제 실패: ' + result.msg);
                btn.disabled = false;
            }
        })
        .catch(err => { alert('오류 발생: ' + err); btn.disabled = false; });
}

// 신청자/과정 입력값을 화면에 넣을 때는 반드시 이 함수로 감싼다 (HTML 주입 방지)
function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const APPLICANT_COLUMNS = [
    ['timestamp', '신청일시'], ['bizName', '회사명'], ['bizNo', '사업자번호'], ['feeLabel', '구분'], ['feeText', '교육비'], ['payNoticeAt', '입금안내'], ['paidText', '입금확인'], ['dept', '부서'],
    ['position', '직위'], ['name', '성명'], ['phone', '연락처'], ['email', '이메일'], ['privacy', '개인정보동의']
];

// 신청 때 자동 판별한 회원 구분(sql/16)을 화면·엑셀용 글자로
const FEE_LABELS = { member: '회원사', nonmember: '비회원사' };
function sortedApplicants(item) {
    return (item.applicants || []).map(a => ({
        ...a,
        feeLabel: FEE_LABELS[a.feeType] || '미확인',
        feeText: a.appliedFee === '' || a.appliedFee === null || a.appliedFee === undefined ? '' : Number(a.appliedFee).toLocaleString('ko-KR') + '원',
        paidText: a.paidAt ? '입금완료 ' + a.paidAt : ''
    })).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

// 교육비 입금 안내 알림톡 보내기(슈퍼관리자). items: [{id, name, fee, label, sent}]
function sendPayNotice(items, btn) {
    if (items.length === 0) return alert('입금 안내를 보낼 신청을 체크해주세요.');
    if (items.length > 50) return alert('입금 안내는 한 번에 50건까지 보낼 수 있습니다.');
    const noFee = items.filter(x => !x.fee || x.label === '미확인');
    const ready = items.filter(x => !noFee.includes(x));
    if (ready.length === 0) return alert('교육비나 구분(회원사/비회원사)이 없는 신청입니다.\n과정 교육비를 입력하거나 구분을 지정한 뒤 보내주세요.');
    const sentBefore = ready.filter(x => x.sent);
    const list = ready.slice(0, 10).map(x => `- ${x.name}: ${x.fee} (${x.label})${x.sent ? ' ※ ' + x.sent + ' 발송함' : ''}`).join('\n');
    const more = ready.length > 10 ? `\n외 ${ready.length - 10}건` : '';
    const skipNote = noFee.length ? `\n\n교육비·구분이 없는 ${noFee.length}건은 보내지 않습니다.` : '';
    if (!confirm(`입금 안내 알림톡 ${ready.length}건을 보내시겠습니까?\n\n${list}${more}${skipNote}`)) return;
    let force = '0';
    if (sentBefore.length) {
        if (!confirm(`이 중 ${sentBefore.length}건은 이미 입금 안내를 보낸 신청입니다.\n다시 보내시겠습니까?\n(취소를 누르면 보내지 않은 신청에만 보냅니다)`)) {
            if (sentBefore.length === ready.length) return;
        } else force = '1';
    }
    btn.disabled = true;
    fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Bearer ' + sessionToken },
        body: new URLSearchParams({ action: 'send_pay_notice', ids: ready.map(x => x.id).join(','), force })
    })
        .then(r => r.json())
        .then(result => {
            if (result.result !== 'success') throw new Error(result.msg);
            const sk = result.skipped || {};
            const notes = [
                result.failed ? `실패 ${result.failed}건 (잠시 후 다시 보내주세요)` : '',
                sk.already ? `이미 보낸 ${sk.already}건 제외` : '',
                sk.noFee ? `교육비 없음 ${sk.noFee}건 제외` : '',
                sk.badPhone ? `휴대폰 번호 오류 ${sk.badPhone}건 제외` : ''
            ].filter(Boolean).join('\n');
            alert(`📨 입금 안내 ${result.sent}건을 보냈습니다.${notes ? '\n' + notes : ''}`);
            fetchStatus();
        })
        .catch(err => alert('⛔ 입금 안내 실패: ' + err.message))
        .finally(() => { btn.disabled = false; });
}

function payItem(el) {
    return { id: el.dataset.id, name: el.dataset.name, fee: el.dataset.fee, label: el.dataset.label, sent: el.dataset.sent };
}

// 신청 1건의 회원 구분 바꾸기(슈퍼관리자). 교육비도 그 과정의 해당 금액으로 바뀐다.
function setFeeType(btn) {
    const next = btn.dataset.next;
    if (!confirm(`${btn.dataset.name}(${btn.dataset.company})의 구분을 '${FEE_LABELS[next]}'(으)로 바꾸시겠습니까?`)) return;
    btn.disabled = true;
    fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Bearer ' + sessionToken },
        body: new URLSearchParams({ action: 'set_fee_type', id: btn.dataset.id, feeType: next })
    })
        .then(r => r.json())
        .then(result => {
            if (result.result === 'success') fetchStatus();
            else { alert('⛔ 변경 실패: ' + result.msg); btn.disabled = false; }
        })
        .catch(err => { alert('오류 발생: ' + err); btn.disabled = false; });
}

// 교육비 입금 확인 체크/해제(슈퍼관리자). 체크한 시각이 남는다(sql/18).
function setPaid(box) {
    const paid = box.checked;
    const who = `${box.dataset.name}(${box.dataset.company})`;
    if (!confirm(paid ? `${who}의 교육비 입금을 확인 처리하시겠습니까?` : `${who}의 입금 확인을 취소하시겠습니까?`)) {
        box.checked = !paid;
        return;
    }
    box.disabled = true;
    fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Bearer ' + sessionToken },
        body: new URLSearchParams({ action: 'set_paid', id: box.dataset.id, paid: paid ? '1' : '0' })
    })
        .then(r => r.json())
        .then(result => {
            if (result.result !== 'success') throw new Error(result.msg);
            fetchStatus();
        })
        .catch(err => { alert('⛔ 입금 확인 저장 실패: ' + err.message); box.checked = !paid; box.disabled = false; });
}

// 명단 칸 하나. 슈퍼관리자에게는 '입금확인' 칸이 체크박스로 보인다.
function applicantCell(app, key, canEdit) {
    if (key === 'paidText' && canEdit) {
        return `<label class="inline-flex items-center gap-1 cursor-pointer"><input type="checkbox" data-action="set-paid"
            data-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" data-company="${escapeHtml(app.bizName)}"${app.paidAt ? ' checked' : ''}
            aria-label="입금확인"><span class="${app.paidAt ? 'text-green-700 font-bold' : 'text-gray-400'}">${app.paidAt ? '완료' : '미입금'}</span>${app.paidAt ? `<span class="text-xs text-gray-500">${escapeHtml(app.paidAt)}</span>` : ''}</label>`;
    }
    return escapeHtml(app[key]);
}

function renderApplicantsTable(item, idx) {
    const apps = sortedApplicants(item);
    if (apps.length === 0) {
        return '<p class="text-sm text-gray-500 py-2">신청자가 없습니다.</p>';
    }
    // 삭제(개별·선택 삭제)는 슈퍼관리자에게만 보인다.
    const canDelete = isSuperAdmin();
    const checkHead = canDelete
        ? `<th class="px-3 py-2"><input type="checkbox" data-action="check-all" data-idx="${idx}" aria-label="전체 선택"></th>` : '';
    const head = APPLICANT_COLUMNS.map(([, label]) =>
        `<th class="px-3 py-2 text-left text-xs font-bold text-gray-500">${label}</th>`).join('')
        + (canDelete ? '<th class="px-3 py-2 text-left text-xs font-bold text-gray-500">관리</th>' : '');
    const rows = apps.map((app, i) => `
        <tr class="border-t">
            ${canDelete ? `<td class="px-3 py-2"><input type="checkbox" class="app-check" data-course="${idx}" data-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" data-company="${escapeHtml(app.bizName)}" data-fee="${escapeHtml(app.feeText)}" data-label="${escapeHtml(app.feeLabel)}" data-sent="${escapeHtml(app.payNoticeAt)}" aria-label="선택"></td>` : ''}
            <td class="px-3 py-2 text-xs text-gray-500">${i + 1}</td>
            ${APPLICANT_COLUMNS.map(([key]) => `<td class="px-3 py-2 text-sm text-gray-800">${applicantCell(app, key, canDelete)}</td>`).join('')}
            ${canDelete ? `<td class="px-3 py-2"><button type="button" data-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" data-company="${escapeHtml(app.bizName)}"
                data-fee="${escapeHtml(app.feeText)}" data-label="${escapeHtml(app.feeLabel)}" data-sent="${escapeHtml(app.payNoticeAt)}" data-action="send-pay-notice"
                class="px-2 py-1 mr-1 text-xs font-bold text-green-700 border border-green-300 rounded hover:bg-green-50">입금안내</button><button type="button" data-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" data-company="${escapeHtml(app.bizName)}"
                data-next="${app.feeType === 'member' ? 'nonmember' : 'member'}" data-action="set-fee-type"
                class="px-2 py-1 mr-1 text-xs font-bold text-blue-700 border border-blue-300 rounded hover:bg-blue-50">${app.feeType === 'member' ? '비회원사로' : '회원사로'}</button><button type="button" data-id="${escapeHtml(app.id)}" data-name="${escapeHtml(app.name)}" data-company="${escapeHtml(app.bizName)}"
                data-action="delete-application" class="px-2 py-1 text-xs font-bold text-red-600 border border-red-300 rounded hover:bg-red-50">삭제</button></td>` : ''}
        </tr>`).join('');
    return `
        <div class="flex justify-between items-center mb-2">
            <span class="text-sm font-bold text-gray-700">신청자 명단 (${apps.length}명 · 입금확인 ${apps.filter(a => a.paidAt).length}명)</span>
            <div>
                ${canDelete ? `<button type="button" data-action="send-pay-selected" data-idx="${idx}"
                    class="px-3 py-1 mr-2 text-xs font-bold text-green-700 border border-green-300 rounded hover:bg-green-50">선택 입금안내</button>` : ''}
                ${canDelete ? `<button type="button" data-action="delete-selected" data-idx="${idx}"
                    class="px-3 py-1 mr-2 text-xs font-bold text-red-600 border border-red-300 rounded hover:bg-red-50">선택 삭제</button>` : ''}
                <button type="button" data-action="download-csv" data-idx="${idx}"
                    class="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-xs font-bold">엑셀(CSV) 다운로드</button>
            </div>
        </div>
        <div class="overflow-x-auto bg-white border rounded-lg">
            <table class="min-w-full whitespace-nowrap">
                <thead class="bg-gray-50"><tr>${checkHead}<th class="px-3 py-2 text-left text-xs font-bold text-gray-500">No</th>${head}</tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// 펼친 과정은 새로고침(삭제·입금안내 후 목록 다시 불러오기) 뒤에도 펼친 채로 둔다.
const openCourseIds = new Set();
function toggleApplicants(idx, forceOpen) {
    const row = document.getElementById('applicants-row-' + idx);
    const arrow = document.getElementById('applicants-arrow-' + idx);
    if (!row) return;
    const willOpen = forceOpen || row.classList.contains('hidden');
    row.classList.toggle('hidden', !willOpen);
    if (arrow) arrow.textContent = willOpen ? '▼' : '▶';
    const course = statusCourses[idx];
    if (course) { if (willOpen) openCourseIds.add(course.id); else openCourseIds.delete(course.id); }
}

// 엑셀 수식으로 해석될 수 있는 값(=, +, -, @ 시작)은 앞에 '를 붙여 글자로 저장
function csvCell(value) {
    let s = String(value === undefined || value === null ? '' : value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
}

// 엑셀 다운로드: 서버에 다운로드 기록(접속 기록)을 먼저 남기고, 성공해야 파일을 만든다.
async function downloadApplicantsCsv(idx) {
    const item = statusCourses[idx];
    if (!item) return;
    const apps = sortedApplicants(item);
    try {
        const res = await fetch(scriptURL + '?type=admin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Bearer ' + sessionToken },
            body: new URLSearchParams({ action: 'log_csv', course_id: item.id, count: String(apps.length) })
        });
        const result = await res.json();
        if (result.result !== 'success') return alert('⛔ 다운로드 실패: ' + result.msg);
    } catch (err) {
        return alert('서버 연결 실패로 다운로드하지 못했습니다.');
    }
    const lines = [
        ['No', ...APPLICANT_COLUMNS.map(([, label]) => label)].map(csvCell).join(','),
        ...apps.map((app, i) => [i + 1, ...APPLICANT_COLUMNS.map(([key]) => app[key])].map(csvCell).join(','))
    ];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = String(item.title || '과정').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    a.href = url;
    a.download = `${safeTitle}_신청자명단.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderStatusTable(data, tbody) {
    tbody.innerHTML = '';
    statusCourses = [];
    if (data.result === 'error') {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-red-500 font-bold">오류: ${escapeHtml(data.msg)}</td></tr>`;
        return;
    }

    const now = new Date();

    // 1. 날짜순 정렬 (오름차순)
    const courses = Object.keys(data).map(key => data[key]).sort((a, b) => {
        const parseDate = (str) => {
            try {
                const parts = str.match(/(\d{4})[\.\s]+(\d{1,2})[\.\s]+(\d{1,2})/);
                if (parts) return new Date(`${parts[1]}-${parts[2]}-${parts[3]}`);
                return new Date(9999, 11, 31); // 파싱 실패시 뒤로
            } catch (e) { return new Date(9999, 11, 31); }
        };
        return parseDate(a.date) - parseDate(b.date);
    });

    if (courses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="px-6 py-10 text-center text-gray-500">데이터가 없습니다.</td></tr>';
        return;
    }

    statusCourses = courses;
    let html = '';
    courses.forEach((item, idx) => {
        let statusBadge = `<span class="px-2 py-1 bg-green-100 text-green-800 text-xs font-bold rounded-full">접수중</span>`;
        const cap = parseInt(item.capacity || 0);
        const cur = parseInt(item.current || 0);

        if (cap > 0 && cur >= cap) statusBadge = `<span class="px-2 py-1 bg-gray-100 text-gray-500 text-xs font-bold rounded-full">정원마감</span>`;

        if (item.deadline) {
            const deadlineDate = new Date(item.deadline);
            deadlineDate.setHours(23, 59, 59, 999);
            if (now > deadlineDate) statusBadge = `<span class="px-2 py-1 bg-gray-100 text-gray-500 text-xs font-bold rounded-full">기한마감</span>`;
        }

        html += `
            <tr class="hover:bg-blue-50 border-b">
                <td class="px-6 py-4">${statusBadge}</td>
                <td class="px-6 py-4">
                    <button type="button" data-action="toggle-applicants" data-idx="${idx}"
                        class="text-sm font-bold text-gray-900 flex items-center text-left hover:text-blue-700 hover:underline focus:outline-none">
                        <span id="applicants-arrow-${idx}" class="text-xs text-gray-400 mr-2">▶</span>${escapeHtml(item.title)}
                    </button>
                    <div class="text-xs text-gray-500 ml-5">${escapeHtml(item.category)}</div>
                </td>
                <td class="px-6 py-4 text-gray-500 text-sm">${escapeHtml(item.date)}</td>
                <td class="px-6 py-4">
                    <div class="flex items-center">
                        <div class="w-full bg-gray-200 rounded-full h-2.5 mr-2 max-w-[100px]">
                            <div class="bg-blue-600 h-2.5 rounded-full" style="width: ${cap > 0 ? Math.min((cur / cap) * 100, 100) : 0}%"></div>
                        </div>
                        <span class="text-sm font-bold text-gray-700">${cur} / ${cap > 0 ? cap : '-'}명</span>
                    </div>
                </td>
                <td class="px-6 py-4 text-gray-500 text-sm">${item.deadline ? escapeHtml(String(item.deadline).split('T')[0]) : '상시/별도'}</td>
            </tr>
            <tr id="applicants-row-${idx}" class="hidden bg-gray-50 border-b">
                <td colspan="5" class="px-6 py-4">${renderApplicantsTable(item, idx)}</td>
            </tr>`;
    });
    tbody.innerHTML = html;
    courses.forEach((item, idx) => { if (openCourseIds.has(item.id)) toggleApplicants(idx, true); });
}

// --- 기능 3: 관리 (수정/삭제) ---
function fetchManage() {
    const tbody = document.getElementById('manage-body');
    if (!sessionToken) return;

    tbody.innerHTML = '<tr><td colspan="3" class="px-6 py-10 text-center text-blue-600 font-bold"><span class="animate-pulse">데이터를 불러오는 중입니다...</span></td></tr>';

    fetch(scriptURL + '?type=admin', {
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + sessionToken
        }
    })
        .then(response => response.json())
        .then(data => {
            allCourses = data; // 데이터 전역 저장
            renderManageTable(data, tbody);
        })
        .catch(err => {
            console.error("Error fetching for manage:", err);
            tbody.innerHTML = '<tr><td colspan="3" class="px-6 py-10 text-center text-red-500">데이터 불러오기 실패</td></tr>';
            alert('데이터 불러오기 실패: ' + err.message);
        });
}

function renderManageTable(data, tbody) {
    tbody.innerHTML = '';
    const courses = Object.keys(data).map(key => data[key]);

    if (courses.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="px-6 py-10 text-center text-gray-500">데이터가 없습니다.</td></tr>';
        return;
    }

    courses.forEach(item => {
        tbody.innerHTML += `
            <tr class="hover:bg-gray-50">
                <td class="px-6 py-4">
                    <div class="text-sm font-bold text-gray-900">${escapeHtml(item.title)}</div>
                    <div class="text-xs text-gray-500">${escapeHtml(item.category)}</div>
                </td>
                <td class="px-6 py-4 text-gray-500 text-sm">${escapeHtml(item.date)}
                    <div class="text-xs ${item.endDate ? 'text-gray-500' : 'text-red-600 font-bold'}">${item.endDate ? '종료일 ' + escapeHtml(item.endDate) : '종료일 미입력 (수정에서 입력 필요)'}</div>
                </td>
                <td class="px-6 py-4 text-center whitespace-nowrap">
                    <button type="button" data-action="edit-course" data-id="${escapeHtml(item.id)}" class="text-blue-600 hover:text-blue-900 font-bold mr-2 border border-blue-200 px-3 py-1 rounded hover:bg-blue-50 transition-colors">수정</button>
                    <button type="button" data-action="delete-course" data-id="${escapeHtml(item.id)}" class="text-red-600 hover:text-red-900 font-bold border border-red-200 px-3 py-1 rounded hover:bg-red-50 transition-colors">삭제</button>
                </td>
            </tr>`;
    });
}

// 수정 모드 진입
function loadCourseForEdit(id) {
    const data = allCourses[id];
    if (!data) return alert('정보를 찾을 수 없습니다.');

    editingCourseId = id;

    // 탭 전환
    switchTab('register');

    // 폼 채우기
    document.getElementById('category').value = data.category;
    document.getElementById('title').value = data.title;
    document.getElementById('date').value = data.date;
    document.getElementById('place').value = data.place;
    document.getElementById('capacity').value = data.capacity;
    document.getElementById('deadline').value = data.deadline ? data.deadline.split('T')[0] : '';
    document.getElementById('endDate').value = data.endDate || '';
    document.getElementById('target').value = data.target;
    document.getElementById('goal').value = data.goal;
    document.getElementById('content').value = data.content;
    document.getElementById('instructor').value = data.instructor;
      if(document.getElementById('instructorBio')) document.getElementById('instructorBio').value = data.instructorBio || '';
    document.getElementById('contact').value = data.contact;
    document.getElementById('cost').value = data.cost || '';
    document.getElementById('memberFee').value = data.memberFee ?? '';
    document.getElementById('nonmemberFee').value = data.nonmemberFee ?? '';
    document.getElementById('paymentInfo').value = data.paymentInfo;
    document.getElementById('otherInfo').value = data.otherInfo;

    // 일시(date) 필드 파싱해서 개별 입력란에 채우기
    try {
        const dateText = data.date;
        const datePart = dateText.match(/(\d{4})[\.\s]+(\d{1,2})[\.\s]+(\d{1,2})/);
        const timePart = dateText.match(/(\d{2}:\d{2})~(\d{2}:\d{2})/);
        
        if (datePart) {
            const y = datePart[1];
            const m = datePart[2].padStart(2, '0');
            const d = datePart[3].padStart(2, '0');
            document.getElementById('input-date-day').value = `${y}-${m}-${d}`;
        }
        if (timePart) {
            document.getElementById('input-date-start').value = timePart[1];
            document.getElementById('input-date-end').value = timePart[2];
        }
    } catch (e) {
        console.error("일시 파싱 실패:", e);
    }

    // UI 변경
    document.getElementById('edit-header').classList.remove('hidden');
    document.getElementById('edit-course-title').innerText = data.title;
    document.getElementById('btn-submit').innerText = '교육 과정 수정하기';
    document.getElementById('btn-submit').classList.remove('bg-blue-900', 'hover:bg-blue-800');
    document.getElementById('btn-submit').classList.add('bg-yellow-600', 'hover:bg-yellow-500');

    window.scrollTo(0, 0);
}

// 수정 취소
function cancelEdit() {
    editingCourseId = null;
    document.getElementById('courseForm').reset();
    document.getElementById('edit-header').classList.add('hidden');

    const btn = document.getElementById('btn-submit');
    btn.innerText = '교육 과정 등록하기';
    btn.classList.remove('bg-yellow-600', 'hover:bg-yellow-500');
    btn.classList.add('bg-blue-900', 'hover:bg-blue-800');
}

// 삭제
function deleteCourse(id) {
    if (!sessionToken) return alert('로그인이 필요합니다.');

    if (!confirm("정말로 이 과정을 삭제하시겠습니까?\n삭제 후에는 복구할 수 없습니다.")) return;

    const formData = new FormData();
    formData.append('action', 'delete_course');
    formData.append('id', id);

    fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': 'Bearer ' + sessionToken
        },
        body: new URLSearchParams(formData)
    })
        .then(response => response.json())
        .then(result => {
            if (result.result === 'success') {
                alert('🗑️ 삭제되었습니다.');
                fetchManage(); // 목록 갱신
            } else {
                alert('⛔ 삭제 실패: ' + result.msg);
            }
        })
        .catch(err => alert('오류 발생: ' + err));
}

// --- 기능 4: 회비 납부 회원사 명단 (슈퍼관리자만, sql/16) ---
function memberPost(params) {
    return fetch(scriptURL + '?type=admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Bearer ' + sessionToken },
        body: new URLSearchParams(params)
    }).then(r => r.json());
}

function fetchMemberInfo() {
    memberPost({ action: 'member_info' })
        .then(result => {
            if (result.result !== 'success') throw new Error(result.msg);
            document.getElementById('member-count').textContent = Number(result.count).toLocaleString('ko-KR');
            document.getElementById('member-updated').textContent = result.updatedAt || '-';
        })
        .catch(err => { document.getElementById('member-count').textContent = '불러오기 실패'; console.error(err); });
}

// CSV 전체를 행·칸으로 나눈다. 따옴표 안의 쉼표·줄바꿈은 칸 안의 글자로 본다
// (예: "(주)가나, 대구지점", 엑셀에서 두 줄로 쓴 열 제목 "2026/1↵회비 납부").
function parseCsv(text) {
    const rows = []; let row = []; let cur = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (q) {
            if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') q = false;
            else cur += ch;
        } else if (ch === '"') q = true;
        else if (ch === ',') { row.push(cur.trim()); cur = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(cur.trim()); cur = '';
            if (row.some(c => c !== '')) rows.push(row);
            row = [];
        } else cur += ch;
    }
    row.push(cur.trim());
    if (row.some(c => c !== '')) rows.push(row);
    return rows;
}

// 회비 납부 여부 칸의 값: 납부·완납·Y·O는 납부, 미납·N·X·빈칸 등은 제외
function isPaidValue(v) {
    const t = String(v || '').replace(/\s/g, '');
    if (!t || t.includes('미')) return false;
    return t.includes('납부') || t === '완납' || /^(Y|O|○|예)$/i.test(t);
}

// CSV에서 회비 납부 회원사의 사업자등록번호만 뽑는다.
// - 열 제목 줄: '사업자'가 들어간 칸이 있는 첫 줄(위쪽의 문서 제목 줄은 건너뜀). 그 열의 번호만 읽는다.
//   그런 줄이 없으면 각 줄의 첫 10자리 번호를 읽는다.
// - '납부'가 들어간 열(예: 2026/1 회비 납부)이 있으면 그 칸이 '납부'인 행만 쓴다(미납 회사 제외).
function extractBizNumbers(text) {
    const all = parseCsv(text.replace(/^\uFEFF/, ''));
    const norm = h => String(h || '').replace(/\s/g, '');
    const headerIdx = all.findIndex(r => r.some(h => norm(h).includes('사업자')));
    const header = headerIdx >= 0 ? all[headerIdx].map(norm) : [];
    const col = header.findIndex(h => h.includes('사업자'));
    const paidCol = header.findIndex((h, i) => i !== col && h.includes('납부'));
    const rows = headerIdx >= 0 ? all.slice(headerIdx + 1) : all;
    const out = []; let unpaid = 0; const otherValues = new Set();
    rows.forEach(c => {
        const target = col >= 0 ? (c[col] || '') : c.join(',');
        const m = target.match(/(?<![0-9])([0-9]{3})-?([0-9]{2})-?([0-9]{5})(?![0-9])/);
        if (!m) return; // 번호가 없는 줄(합계·빈 줄 등)은 세지 않는다
        if (paidCol >= 0 && !isPaidValue(c[paidCol])) {
            unpaid++;
            const v = String(c[paidCol] || '').trim();
            if (v && !v.includes('미')) otherValues.add(v);
            return;
        }
        out.push(m[1] + m[2] + m[3]);
    });
    const total = out.length + unpaid;
    return {
        list: [...new Set(out)], usedColumn: col >= 0 ? header[col] : null, lines: total,
        paidColumn: paidCol >= 0 ? header[paidCol] : null, unpaid, otherValues: [...otherValues].slice(0, 5)
    };
}

async function replaceMembers(btn) {
    const file = document.getElementById('member-file').files[0];
    if (!file) return alert('CSV 파일을 선택해주세요.');
    // 엑셀의 'CSV(쉼표로 분리)'는 한글이 EUC-KR로 저장된다. UTF-8로 읽어 깨지면 EUC-KR로 다시 읽는다.
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('\uFFFD')) text = new TextDecoder('euc-kr').decode(buf);
    const { list, usedColumn, lines, paidColumn, unpaid, otherValues } = extractBizNumbers(text);
    if (list.length === 0) return alert('파일에서 회비 납부 회원사의 사업자등록번호(10자리)를 찾지 못했습니다. 엑셀에서 CSV로 저장했는지, 납부 여부 칸이 "납부"로 적혀 있는지 확인해주세요.');
    const masked = list.slice(0, 3).map(b => `***-**-*${b.slice(-4)}`).join(', ');
    const how = usedColumn ? `'${usedColumn}' 열에서` : '각 줄에서';
    const paidNote = paidColumn
        ? `'${paidColumn}' 열이 '납부'인 회사만 골랐습니다(번호가 있는 ${lines}개 회사 중 ${unpaid}개 제외).` + (otherValues.length ? `\n※ 납부로 보지 않은 값: ${otherValues.join(', ')}` : '')
        : '⚠️ 회비 납부 여부 열이 없습니다. 파일의 모든 회사가 회원사 교육비로 등록됩니다.\n납부한 회사만 들어 있는 명단이 맞는지 확인하세요.';
    if (!confirm(`${how} 회원사 교육비 대상 ${list.length}개를 찾았습니다.\n${paidNote}\n예: ${masked}\n\n기존 명단을 지우고 이 명단으로 바꾸시겠습니까?`)) return;
    btn.disabled = true;
    try {
        const result = await memberPost({ action: 'member_replace', bizNos: list.join(',') });
        if (result.result !== 'success') throw new Error(result.msg);
        alert(`✅ 회원사 명단을 ${result.count}개로 바꿨습니다.\n올린 CSV 파일은 PC에서 지워주세요.`);
        document.getElementById('member-file').value = '';
        fetchMemberInfo();
    } catch (err) {
        alert('⛔ 명단 바꾸기 실패: ' + err.message);
    } finally {
        btn.disabled = false;
    }
}

function memberSingle(action) {
    const input = document.getElementById('member-biz');
    const out = document.getElementById('member-result');
    const bizNo = input.value.replace(/[^0-9]/g, '');
    if (bizNo.length !== 10) return alert('사업자등록번호 10자리를 입력해주세요.');
    if (action === 'member_delete' && !confirm('이 사업자등록번호를 회원사 명단에서 삭제하시겠습니까?')) return;
    memberPost({ action, bizNo })
        .then(result => {
            if (result.result !== 'success') throw new Error(result.msg);
            if (action === 'member_check') out.textContent = result.exists ? '✅ 명단에 있습니다 (회원사 교육비 적용)' : '❌ 명단에 없습니다 (비회원사 교육비 적용)';
            if (action === 'member_add') out.textContent = result.already ? '이미 명단에 있습니다.' : '✅ 추가했습니다. 이후 신청부터 회원사 교육비가 적용됩니다.';
            if (action === 'member_delete') out.textContent = result.deleted ? '🗑️ 삭제했습니다.' : '명단에 없는 번호입니다.';
            fetchMemberInfo();
        })
        .catch(err => { out.textContent = '⛔ ' + err.message; });
}

function handleError(tbody, err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-red-500">데이터 로드 실패</td></tr>`;
}

// --- 버튼 동작 연결 (onclick 대신 data-action) ---
const ACTIONS = {
    'logout': () => logout(),
    'switch-tab': el => switchTab(el.dataset.tab),
    'fetch-status': () => fetchStatus(),
    'fetch-manage': () => fetchManage(),
    'cancel-edit': () => cancelEdit(),
    'submit-course': () => submitCourse(),
    'delete-application': el => deleteApplication(el),
    'download-csv': el => downloadApplicantsCsv(Number(el.dataset.idx)),
    'delete-selected': el => deleteSelected(el),
    'check-all': el => checkAll(el),
    'toggle-applicants': el => toggleApplicants(Number(el.dataset.idx)),
    'edit-course': el => loadCourseForEdit(el.dataset.id),
    'delete-course': el => deleteCourse(el.dataset.id),
    'set-fee-type': el => setFeeType(el),
    'set-paid': el => setPaid(el),
    'send-pay-notice': el => sendPayNotice([payItem(el)], el),
    'send-pay-selected': el => sendPayNotice([...document.querySelectorAll(`.app-check[data-course="${el.dataset.idx}"]:checked`)].map(payItem), el),
    'member-replace': el => replaceMembers(el),
    'member-check': () => memberSingle('member_check'),
    'member-add': () => memberSingle('member_add'),
    'member-delete': () => memberSingle('member_delete')
};
document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (el && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
});
document.getElementById('login-form').addEventListener('submit', e => { e.preventDefault(); tryLogin(); });
document.getElementById('mfa-panel').addEventListener('submit', e => { e.preventDefault(); verifyMfa(); });

// --- 자리 비움 자동 로그아웃 ---
// 관리자 화면을 열어 둔 채 조작이 없으면 로그아웃한다(서버에 저장된 재발급 토큰도 폐기).
// 기본 30분, "이 PC 기억"을 켠 PC는 4시간. 탭을 닫아 두는 시간은 세지 않는다.
// 마지막 조작 시각은 이 탭(sessionStorage)에 적어 두어, 새로고침하거나 브라우저가 탭을 복원해도 이어서 센다.
// 참고: 이미 발급된 접속 토큰(JWT)은 만료 시각(Supabase 설정 30분)까지 서버에서 유효할 수 있다.
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const IDLE_LIMIT_TRUSTED_MS = 4 * 60 * 60 * 1000;
const ACTIVITY_KEY = 'dcciedu-admin-last-activity';
function loadActivity() {
    try {
        const t = Number(sessionStorage.getItem(ACTIVITY_KEY));
        if (t > 0 && t <= Date.now()) return t;
    } catch (e) { /* 저장소를 못 쓰는 브라우저는 지금부터 센다 */ }
    return Date.now();
}
let lastActivity = loadActivity();
let lastSaved = 0;
function touchActivity() {
    lastActivity = Date.now();
    if (lastActivity - lastSaved < 10 * 1000) return; // 저장은 10초에 한 번만
    lastSaved = lastActivity;
    try { sessionStorage.setItem(ACTIVITY_KEY, String(lastActivity)); } catch (e) { /* 무시 */ }
}
['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach(ev =>
    document.addEventListener(ev, touchActivity, { passive: true }));
function checkIdle() {
    const loggedIn = sessionToken || !document.getElementById('mfa-panel').classList.contains('hidden');
    const limit = isTrustedPc() ? IDLE_LIMIT_TRUSTED_MS : IDLE_LIMIT_MS;
    if (!loggedIn || Date.now() - lastActivity < limit) return;
    const label = isTrustedPc() ? '4시간' : '30분';
    lastSaved = 0;
    touchActivity();
    logout().finally(() => alert(`${label} 동안 사용하지 않아 자동으로 로그아웃되었습니다.`));
}
setInterval(checkIdle, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkIdle(); });
