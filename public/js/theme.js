(function () {
  document.documentElement.classList.add('preload');

  function setTheme(isLight) {
    document.body.classList.toggle('light-theme', isLight);
    const icon = document.getElementById('theme-icon');
    if (icon) icon.src = isLight ? '/assets/moon-icon.svg' : '/assets/sun-icon.svg';
    const logo = document.getElementById('brand-logo');
    if (logo) logo.src = isLight ? '/assets/logo-b.png' : '/assets/logo-w.png';
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
  }

  function applySavedTheme() {
    setTheme(localStorage.getItem('theme') === 'light');
    setTimeout(() => document.documentElement.classList.remove('preload'), 50);
  }

  window.addEventListener('DOMContentLoaded', () => {
    applySavedTheme();
    const btn = document.getElementById('theme-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        setTheme(!document.body.classList.contains('light-theme'));
      });
    }
  });
})();
