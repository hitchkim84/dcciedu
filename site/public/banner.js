// 메인 배너 슬라이드 (index.html의 #banner)
// - 좌우 화살표·아래 점으로 넘기고, 5초마다 자동으로 넘어간다
//   (마우스를 배너 위에 올리거나, 키보드로 배너 안 버튼에 가 있거나, 다른 탭을 보면 멈춤).
// - PC의 '애니메이션 줄이기' 설정이 켜져 있으면 흐려지는 효과 없이 바로 바뀐다(자동 넘김은 그대로).
// - 휴대폰에서는 손가락으로 밀어서 넘긴다.
// - data-until="YYYY-MM-DD"가 있는 배너는 그날(한국 시간)이 지나면 보이지 않는다.
// 외부 라이브러리 없이 이 파일만 쓴다(CSP: script-src 'self').
(function () {
    const root = document.getElementById('banner');
    if (!root) return;
    const AUTO_MS = 5000;
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // 한국 날짜

    // 기간이 지난 배너는 지운다.
    root.querySelectorAll('[data-slide]').forEach(s => {
        if (s.dataset.until && s.dataset.until < today) s.remove();
    });
    const slides = Array.from(root.querySelectorAll('[data-slide]'));
    const prevBtn = root.querySelector('[data-banner="prev"]');
    const nextBtn = root.querySelector('[data-banner="next"]');
    const dotsBox = root.querySelector('[data-banner="dots"]');
    if (slides.length <= 1) {
        [prevBtn, nextBtn, dotsBox].forEach(el => el && el.remove());
        return;
    }

    let current = 0;
    let timer = null;
    let paused = false;

    const dots = slides.map((_, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'w-2.5 h-2.5 rounded-full bg-white/60 hover:bg-white transition-colors';
        b.setAttribute('aria-label', `${i + 1}번째 배너 보기`);
        b.addEventListener('click', () => { show(i); restart(); });
        dotsBox.appendChild(b);
        return b;
    });

    function show(i) {
        current = (i + slides.length) % slides.length;
        slides.forEach((s, k) => {
            const on = k === current;
            s.classList.toggle('opacity-100', on);
            s.classList.toggle('opacity-0', !on);
            s.classList.toggle('pointer-events-none', !on);
            s.setAttribute('aria-hidden', on ? 'false' : 'true');
            if (s.tagName === 'A') s.tabIndex = on ? 0 : -1;
        });
        dots.forEach((d, k) => {
            d.classList.toggle('bg-white', k === current);
            d.classList.toggle('bg-white/60', k !== current);
            d.setAttribute('aria-current', k === current ? 'true' : 'false');
        });
    }

    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) slides.forEach(s => s.classList.remove('transition-opacity', 'duration-700'));

    let hovering = false; // 마우스가 배너 위에 있음(손가락 터치는 제외)
    let keyFocus = false; // 키보드(Tab)로 배너 안 버튼·링크에 가 있음
    function restart() {
        clearInterval(timer);
        timer = null;
        paused = hovering || keyFocus;
        if (!paused && !document.hidden) timer = setInterval(() => show(current + 1), AUTO_MS);
    }

    prevBtn.addEventListener('click', () => { show(current - 1); restart(); });
    nextBtn.addEventListener('click', () => { show(current + 1); restart(); });
    root.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { hovering = true; restart(); } });
    root.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') { hovering = false; restart(); } });
    // 마우스로 화살표를 누르면 버튼에 포커스가 남으므로, 키보드로 온 경우(:focus-visible)만 멈춘다.
    root.addEventListener('focusin', e => { keyFocus = e.target.matches(':focus-visible'); restart(); });
    root.addEventListener('focusout', () => { keyFocus = false; restart(); });
    document.addEventListener('visibilitychange', restart);

    // 휴대폰: 좌우로 40px 넘게 밀면 넘긴다.
    let startX = null;
    root.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
    root.addEventListener('touchend', e => {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        startX = null;
        if (Math.abs(dx) > 40) { show(current + (dx < 0 ? 1 : -1)); restart(); }
    }, { passive: true });

    show(0);
    restart();
})();
