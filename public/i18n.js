/**
 * RAFLY i18n — Minimal internationalization system
 * Usage: Add data-i18n="key" to elements. Call setLang('en'|'es').
 */

const TRANSLATIONS = {
  es: {
    // Header
    'nav.tools': 'Herramientas',
    'nav.plans': 'Planes',
    'nav.login': 'LOGIN',
    'nav.logout': 'Salir',

    // Main panel
    'panel.title': 'Panel de Participantes',
    'panel.placeholder': 'Pegá los nombres aquí (uno por línea)...',
    'panel.count': 'participantes',
    'panel.clear': 'Limpiar',
    'panel.import': 'Importar',
    'panel.export': 'Exportar',

    // Modes
    'mode.slot': 'Slot',
    'mode.roulette': 'Ruleta',
    'mode.shuffle': 'Shuffle',

    // Spin
    'spin.button': 'SORTEAR',
    'spin.spinning': 'SORTEANDO...',
    'spin.winner': '¡GANADOR!',
    'spin.again': 'Sortear de nuevo',

    // Settings
    'settings.sound': 'Sonido',
    'settings.duplicates': 'Eliminar duplicados',
    'settings.suplentes': 'Suplentes',
    'settings.theme': 'Tema',
    'settings.fullscreen': 'Pantalla completa',

    // Instagram
    'ig.connect': 'Conectar Instagram',
    'ig.disconnect': 'Desconectar',
    'ig.selectPost': 'Seleccionar post',
    'ig.loadComments': 'Cargar comentarios',

    // URL import
    'url.placeholder': 'Pegá la URL del post de Instagram, YouTube o TikTok',
    'url.load': 'Cargar',
    'url.loading': 'Cargando...',

    // Tabs
    'tab.manual': 'Manual',
    'tab.url': 'Desde URL',
    'tab.instagram': 'Instagram',

    // Plan limits
    'plan.limit': 'Límite alcanzado',
    'plan.upgrade': 'Subir plan',
    'plan.dailyLimit': 'Llegaste al límite de sorteos diarios de tu plan',
    'plan.participantLimit': 'Tu plan permite hasta {max} participantes',

    // Auth
    'auth.login': 'Iniciar sesión',
    'auth.register': 'Crear cuenta',
    'auth.email': 'Email',
    'auth.password': 'Contraseña',
    'auth.name': 'Nombre (opcional)',
    'auth.loginBtn': 'Entrar',
    'auth.registerBtn': 'Registrarse',
    'auth.noAccount': '¿No tenés cuenta?',
    'auth.hasAccount': '¿Ya tenés cuenta?',
    'auth.createOne': 'Crear una',
    'auth.loginHere': 'Iniciá sesión',

    // User menu
    'user.profile': 'Mi perfil',
    'user.plans': 'Planes',
    'user.dashboard': 'Dashboard',
    'user.admin': 'Admin',
    'user.logout': 'Cerrar sesión',

    // Tour
    'tour.skip': 'Saltar',
    'tour.next': 'Siguiente',
    'tour.finish': 'Empezar',
    'tour.step1.title': 'Agregá participantes',
    'tour.step1.text': 'Podés escribirlos manualmente, importar desde Instagram/YouTube/TikTok, o pegar una lista.',
    'tour.step2.title': 'Elegí el modo',
    'tour.step2.text': 'Slot Machine, Ruleta o Shuffle. Cada uno tiene su animación única.',
    'tour.step3.title': 'Sorteá',
    'tour.step3.text': 'Hacé click en SORTEAR o presioná Espacio. El ganador se elige con criptografía segura.',
    'tour.step4.title': 'Compartí el resultado',
    'tour.step4.text': 'Generá un certificado de ganador, exportá en PDF o compartí el link.',
    'tour.step5.title': 'Atajos de teclado',
    'tour.step5.text': 'Presioná ? para ver todos los atajos. Espacio=Sortear, P=Panel, F=Fullscreen.',

    // Shortcuts
    'shortcuts.title': 'Atajos de teclado',

    // Misc
    'misc.certificate': 'Certificado de ganador',
    'misc.download': 'Descargar',
    'misc.share': 'Compartir',
    'misc.close': 'Cerrar',
    'misc.cancel': 'Cancelar',
    'misc.save': 'Guardar',
    'misc.loading': 'Cargando...',
  },

  en: {
    // Header
    'nav.tools': 'Tools',
    'nav.plans': 'Plans',
    'nav.login': 'LOGIN',
    'nav.logout': 'Log out',

    // Main panel
    'panel.title': 'Participants Panel',
    'panel.placeholder': 'Paste names here (one per line)...',
    'panel.count': 'participants',
    'panel.clear': 'Clear',
    'panel.import': 'Import',
    'panel.export': 'Export',

    // Modes
    'mode.slot': 'Slot',
    'mode.roulette': 'Roulette',
    'mode.shuffle': 'Shuffle',

    // Spin
    'spin.button': 'DRAW',
    'spin.spinning': 'DRAWING...',
    'spin.winner': 'WINNER!',
    'spin.again': 'Draw again',

    // Settings
    'settings.sound': 'Sound',
    'settings.duplicates': 'Remove duplicates',
    'settings.suplentes': 'Alternates',
    'settings.theme': 'Theme',
    'settings.fullscreen': 'Fullscreen',

    // Instagram
    'ig.connect': 'Connect Instagram',
    'ig.disconnect': 'Disconnect',
    'ig.selectPost': 'Select post',
    'ig.loadComments': 'Load comments',

    // URL import
    'url.placeholder': 'Paste Instagram, YouTube or TikTok post URL',
    'url.load': 'Load',
    'url.loading': 'Loading...',

    // Tabs
    'tab.manual': 'Manual',
    'tab.url': 'From URL',
    'tab.instagram': 'Instagram',

    // Plan limits
    'plan.limit': 'Limit reached',
    'plan.upgrade': 'Upgrade plan',
    'plan.dailyLimit': 'You reached your plan\'s daily draw limit',
    'plan.participantLimit': 'Your plan allows up to {max} participants',

    // Auth
    'auth.login': 'Log in',
    'auth.register': 'Sign up',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.name': 'Name (optional)',
    'auth.loginBtn': 'Log in',
    'auth.registerBtn': 'Sign up',
    'auth.noAccount': 'Don\'t have an account?',
    'auth.hasAccount': 'Already have an account?',
    'auth.createOne': 'Create one',
    'auth.loginHere': 'Log in',

    // User menu
    'user.profile': 'My profile',
    'user.plans': 'Plans',
    'user.dashboard': 'Dashboard',
    'user.admin': 'Admin',
    'user.logout': 'Log out',

    // Tour
    'tour.skip': 'Skip',
    'tour.next': 'Next',
    'tour.finish': 'Start',
    'tour.step1.title': 'Add participants',
    'tour.step1.text': 'Type them manually, import from Instagram/YouTube/TikTok, or paste a list.',
    'tour.step2.title': 'Choose the mode',
    'tour.step2.text': 'Slot Machine, Roulette or Shuffle. Each one has its unique animation.',
    'tour.step3.title': 'Draw',
    'tour.step3.text': 'Click DRAW or press Space. The winner is chosen with secure cryptography.',
    'tour.step4.title': 'Share the result',
    'tour.step4.text': 'Generate a winner certificate, export as PDF or share the link.',
    'tour.step5.title': 'Keyboard shortcuts',
    'tour.step5.text': 'Press ? to see all shortcuts. Space=Draw, P=Panel, F=Fullscreen.',

    // Shortcuts
    'shortcuts.title': 'Keyboard shortcuts',

    // Misc
    'misc.certificate': 'Winner certificate',
    'misc.download': 'Download',
    'misc.share': 'Share',
    'misc.close': 'Close',
    'misc.cancel': 'Cancel',
    'misc.save': 'Save',
    'misc.loading': 'Loading...',
  }
};

let currentLang = (() => {
  try { return localStorage.getItem('rafly-lang') || 'es'; } catch(e) { return 'es'; }
})();

function t(key, params) {
  let text = TRANSLATIONS[currentLang]?.[key] || TRANSLATIONS['es']?.[key] || key;
  if (params) {
    Object.keys(params).forEach(k => {
      text = text.replace(`{${k}}`, params[k]);
    });
  }
  return text;
}

function setLang(lang) {
  if (!TRANSLATIONS[lang]) return;
  currentLang = lang;
  try { localStorage.setItem('rafly-lang', lang); } catch(e) {}
  document.documentElement.lang = lang;

  // Update all elements with data-i18n
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    if (attr === 'placeholder') {
      el.placeholder = t(key);
    } else if (attr === 'title') {
      el.title = t(key);
    } else {
      el.textContent = t(key);
    }
  });

  // Update lang toggle button
  const langBtn = document.getElementById('langToggle');
  if (langBtn) {
    langBtn.textContent = lang === 'es' ? 'EN' : 'ES';
    langBtn.title = lang === 'es' ? 'Switch to English' : 'Cambiar a Español';
  }

  // Dispatch event for custom handlers
  window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
}

function toggleLang() {
  setLang(currentLang === 'es' ? 'en' : 'es');
}

function getLang() {
  return currentLang;
}

// Auto-detect browser language on first visit
if (!(() => { try { return localStorage.getItem('rafly-lang'); } catch(e) { return null; } })()) {
  const browserLang = navigator.language?.split('-')[0];
  if (browserLang === 'en') {
    currentLang = 'en';
    try { localStorage.setItem('rafly-lang', 'en'); } catch(e) {}
  }
}
