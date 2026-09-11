/**
 * RAFLY Widget SDK
 * Usage:
 *   <div id="rafly-widget" data-key="w_abc123"></div>
 *   <script src="https://rafly.onrender.com/widget-sdk.js"></script>
 *
 * Options via data attributes:
 *   data-key     — Widget key (required)
 *   data-width   — Width (default: 400)
 *   data-height  — Height (default: 500)
 *
 * Events:
 *   window.addEventListener('rafly:winner', e => console.log(e.detail))
 */
(function() {
  const BASE = 'https://rafly.onrender.com';

  function init() {
    const container = document.getElementById('rafly-widget');
    if (!container) return;

    const key = container.getAttribute('data-key');
    if (!key) {
      console.error('[RAFLY] Missing data-key attribute');
      return;
    }

    const width = container.getAttribute('data-width') || '400';
    const height = container.getAttribute('data-height') || '500';

    const iframe = document.createElement('iframe');
    iframe.src = `${BASE}/widget.html?key=${key}`;
    iframe.width = width;
    iframe.height = height;
    iframe.frameBorder = '0';
    iframe.style.borderRadius = '12px';
    iframe.style.overflow = 'hidden';
    iframe.style.maxWidth = '100%';
    iframe.allow = 'clipboard-write';

    container.appendChild(iframe);

    // Listen for winner events from iframe
    window.addEventListener('message', function(event) {
      if (event.data?.type === 'rafly:winner') {
        window.dispatchEvent(new CustomEvent('rafly:winner', {
          detail: {
            winner: event.data.winner,
            participants: event.data.participants
          }
        }));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
