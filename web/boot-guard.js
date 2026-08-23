// This deliberately stays separate from app.js. If the main module fails during evaluation, this
// small classic script can still turn the blocking connection overlay into an actionable error.
(() => {
  'use strict';

  const messageOf = (value) => {
    if (value instanceof Error) return value.message;
    if (value && typeof value === 'object' && 'message' in value) return String(value.message);
    return String(value || 'Unknown browser error.');
  };

  const show = (value) => {
    const overlay = document.getElementById('disconnected');
    const title = document.getElementById('disconnected-title');
    const detail = document.getElementById('disconnected-detail');
    const reload = document.getElementById('disconnected-reload');
    if (!overlay || !title || !detail || !reload) return;

    title.textContent = 'Control panel failed to start';
    detail.textContent = `${messageOf(value)} Reload the panel; if it repeats, copy this message from the Logs tab or application log.`;
    reload.hidden = false;
    overlay.hidden = false;
  };

  window.addEventListener('error', (event) => show(event.error || event.message));
  window.addEventListener('unhandledrejection', (event) => show(event.reason));
  document.getElementById('disconnected-reload')?.addEventListener('click', () => location.reload());
})();
