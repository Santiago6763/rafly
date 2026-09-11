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
  },

  pt: {
    // Header
    'nav.tools': 'Ferramentas',
    'nav.plans': 'Planos',
    'nav.login': 'LOGIN',
    'nav.logout': 'Sair',

    // Main panel
    'panel.title': 'Painel de Participantes',
    'panel.placeholder': 'Cole os nomes aqui (um por linha)...',
    'panel.count': 'participantes',
    'panel.clear': 'Limpar',
    'panel.import': 'Importar',
    'panel.export': 'Exportar',

    // Modes
    'mode.slot': 'Slot',
    'mode.roulette': 'Roleta',
    'mode.shuffle': 'Shuffle',

    // Spin
    'spin.button': 'SORTEAR',
    'spin.spinning': 'SORTEANDO...',
    'spin.winner': 'VENCEDOR!',
    'spin.again': 'Sortear novamente',

    // Settings
    'settings.sound': 'Som',
    'settings.duplicates': 'Remover duplicados',
    'settings.suplentes': 'Suplentes',
    'settings.theme': 'Tema',
    'settings.fullscreen': 'Tela cheia',

    // Instagram
    'ig.connect': 'Conectar Instagram',
    'ig.disconnect': 'Desconectar',
    'ig.selectPost': 'Selecionar post',
    'ig.loadComments': 'Carregar comentarios',

    // URL import
    'url.placeholder': 'Cole a URL do post do Instagram, YouTube ou TikTok',
    'url.load': 'Carregar',
    'url.loading': 'Carregando...',

    // Tabs
    'tab.manual': 'Manual',
    'tab.url': 'Por URL',
    'tab.instagram': 'Instagram',

    // Plan limits
    'plan.limit': 'Limite atingido',
    'plan.upgrade': 'Atualizar plano',
    'plan.dailyLimit': 'Voce atingiu o limite diario de sorteios do seu plano',
    'plan.participantLimit': 'Seu plano permite ate {max} participantes',

    // Auth
    'auth.login': 'Entrar',
    'auth.register': 'Criar conta',
    'auth.email': 'Email',
    'auth.password': 'Senha',
    'auth.name': 'Nome (opcional)',
    'auth.loginBtn': 'Entrar',
    'auth.registerBtn': 'Cadastrar',
    'auth.noAccount': 'Nao tem uma conta?',
    'auth.hasAccount': 'Ja tem uma conta?',
    'auth.createOne': 'Criar uma',
    'auth.loginHere': 'Faca login',

    // User menu
    'user.profile': 'Meu perfil',
    'user.plans': 'Planos',
    'user.dashboard': 'Dashboard',
    'user.admin': 'Admin',
    'user.logout': 'Sair',

    // Tour
    'tour.skip': 'Pular',
    'tour.next': 'Proximo',
    'tour.finish': 'Comecar',
    'tour.step1.title': 'Adicione participantes',
    'tour.step1.text': 'Digite manualmente, importe do Instagram/YouTube/TikTok ou cole uma lista.',
    'tour.step2.title': 'Escolha o modo',
    'tour.step2.text': 'Slot Machine, Roleta ou Shuffle. Cada um tem sua animacao unica.',
    'tour.step3.title': 'Sorteie',
    'tour.step3.text': 'Clique em SORTEAR ou pressione Espaco. O vencedor e escolhido com criptografia segura.',
    'tour.step4.title': 'Compartilhe o resultado',
    'tour.step4.text': 'Gere um certificado de vencedor, exporte em PDF ou compartilhe o link.',
    'tour.step5.title': 'Atalhos de teclado',
    'tour.step5.text': 'Pressione ? para ver todos os atalhos. Espaco=Sortear, P=Painel, F=Tela cheia.',

    // Shortcuts
    'shortcuts.title': 'Atalhos de teclado',

    // Misc
    'misc.certificate': 'Certificado do vencedor',
    'misc.download': 'Baixar',
    'misc.share': 'Compartilhar',
    'misc.close': 'Fechar',
    'misc.cancel': 'Cancelar',
    'misc.save': 'Salvar',
    'misc.loading': 'Carregando...',
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
    const nextMap = { es: 'EN', en: 'PT', pt: 'ES' };
    const titleMap = { es: 'Switch to English', en: 'Mudar para Portugues', pt: 'Cambiar a Espanol' };
    langBtn.textContent = nextMap[lang] || 'ES';
    langBtn.title = titleMap[lang] || '';
  }

  // Dispatch event for custom handlers
  window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
}

function toggleLang() {
  const cycle = { es: 'en', en: 'pt', pt: 'es' };
  setLang(cycle[currentLang] || 'es');
}

function getLang() {
  return currentLang;
}

// Auto-detect browser language on first visit
if (!(() => { try { return localStorage.getItem('rafly-lang'); } catch(e) { return null; } })()) {
  const browserLang = navigator.language?.split('-')[0];
  if (browserLang === 'en' || browserLang === 'pt') {
    currentLang = browserLang;
    try { localStorage.setItem('rafly-lang', browserLang); } catch(e) {}
  }
}
