// 모바일 메뉴 토글
const toggle = document.querySelector(".nav-toggle");
const menu = document.getElementById("nav-menu");

if (toggle && menu) {
  toggle.addEventListener("click", () => {
    const isOpen = menu.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(isOpen));
  });

  // 메뉴 항목 클릭 시 모바일 메뉴 닫기
  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      menu.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
}

// 상담 문의 폼 (화면 구성용 - 실제 전송은 백엔드/폼 서비스 연동 필요)
const form = document.getElementById("contact-form");
const note = document.getElementById("form-note");

if (form && note) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = form.name.value.trim();
    const phone = form.phone.value.trim();

    if (!name || !phone) {
      note.textContent = "이름과 연락처를 입력해 주세요.";
      note.style.color = "#c0392b";
      return;
    }

    note.textContent =
      "입력이 확인되었습니다. (현재는 데모 화면으로, 실제 접수를 위해서는 폼 전송 연동이 필요합니다.)";
    note.style.color = "#1f4e79";
    form.reset();
  });
}

// 푸터 연도 자동 표시
const yearEl = document.getElementById("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());
