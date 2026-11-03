/* Rastreio anônimo das páginas do The Vault (Vault e Coringa).
   Não usa cookie e não coleta dado pessoal: só um código aleatório do aparelho,
   de onde a pessoa veio, o tipo de aparelho e o que ela fez na página.
   Os dados vão para o painel do The Vault (thebestia.com.br/vault-painel). */
(function () {
  try {
    var API = 'https://thebestia.com.br/api/vault/evento';
    var sc = document.currentScript;
    var PAGINA = (sc && sc.getAttribute('data-pagina')) || (location.pathname.indexOf('coringa') >= 0 ? 'coringa' : 'vault');

    function aleatorio() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
    function ler(st, k) { try { return st.getItem(k); } catch (e) { return null; } }
    function gravar(st, k, v) { try { st.setItem(k, v); } catch (e) {} }

    var visitante = ler(localStorage, 'tv-vis');
    var novo = !visitante;
    if (!visitante) { visitante = aleatorio(); gravar(localStorage, 'tv-vis', visitante); }
    var sessao = ler(sessionStorage, 'tv-ses-' + PAGINA);
    if (!sessao) { sessao = aleatorio(); gravar(sessionStorage, 'tv-ses-' + PAGINA, sessao); }

    // ---- de onde veio
    var q = new URLSearchParams(location.search);
    var ua = navigator.userAgent || '';
    function origem() {
      var s = (q.get('src') || q.get('utm_source') || '').toLowerCase().trim();
      if (s) return s.slice(0, 40);
      if (q.has('fbclid')) return /Instagram/i.test(ua) ? 'instagram' : 'facebook';
      if (q.has('ttclid')) return 'tiktok';
      if (q.has('gclid')) return 'google';
      var r = '';
      try { r = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch (e) {}
      if (r && r.indexOf('cofredossonhos.com') >= 0) r = '';
      if (/instagram/.test(r)) return 'instagram';
      if (/facebook|fb\.com/.test(r)) return 'facebook';
      if (/tiktok/.test(r)) return 'tiktok';
      if (/google/.test(r)) return 'google';
      if (/whatsapp|wa\.me/.test(r)) return 'whatsapp';
      if (/t\.me|telegram/.test(r)) return 'telegram';
      if (/youtube/.test(r)) return 'youtube';
      if (r) return r.slice(0, 40);
      if (/Instagram/i.test(ua)) return 'instagram';
      if (/FBAN|FBAV/i.test(ua)) return 'facebook';
      if (/musical_ly|Bytedance|TikTok/i.test(ua)) return 'tiktok';
      if (/WhatsApp/i.test(ua)) return 'whatsapp';
      return 'direto';
    }
    var ORIGEM = ler(sessionStorage, 'tv-ori') || origem();
    gravar(sessionStorage, 'tv-ori', ORIGEM);
    var CAMPANHA = (q.get('utm_campaign') || '').slice(0, 60);
    var DISP = /iPad|Tablet/i.test(ua) ? 'tablet' : (/iPhone|Android|Mobile/i.test(ua) ? 'celular' : 'computador');
    var SIS = /iPhone|iPad|Mac OS X(?!.*Windows)/i.test(ua) && /Mobile|iPhone|iPad/.test(ua) ? 'iOS' : (/Android/i.test(ua) ? 'Android' : (/Windows/i.test(ua) ? 'Windows' : (/Mac/i.test(ua) ? 'Mac' : 'outro')));

    // ---- envio (uma vez por tipo+valor em cada sessão)
    var enviados = {};
    try { enviados = JSON.parse(ler(sessionStorage, 'tv-env-' + PAGINA) || '{}'); } catch (e) {}
    function enviar(tipo, valor, repetir) {
      try {
        var chave = tipo + ':' + (valor || '');
        if (!repetir && enviados[chave]) return;
        enviados[chave] = 1; gravar(sessionStorage, 'tv-env-' + PAGINA, JSON.stringify(enviados));
        var corpo = JSON.stringify({ tipo: tipo, valor: valor == null ? '' : String(valor).slice(0, 80), pagina: PAGINA, visitante: visitante, sessao: sessao,
          origem: ORIGEM, campanha: CAMPANHA, dispositivo: DISP + '/' + SIS, novo: novo });
        if (navigator.sendBeacon && navigator.sendBeacon(API, new Blob([corpo], { type: 'text/plain' }))) return;
        fetch(API, { method: 'POST', body: corpo, keepalive: true, mode: 'cors', headers: { 'Content-Type': 'text/plain' } });
      } catch (e) {}
    }

    enviar('visita');

    // ---- rolagem
    function rolagem() {
      var h = document.documentElement.scrollHeight - innerHeight;
      if (h <= 0) return;
      var p = (scrollY / h) * 100;
      [25, 50, 75, 100].forEach(function (m) { if (p >= m - 2) enviar('rolou', m); });
    }
    addEventListener('scroll', rolagem, { passive: true });

    // ---- seções vistas
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) { enviar('secao', e.target.getAttribute('data-sec')); io.unobserve(e.target); } });
      }, { threshold: 0.35 });
      document.querySelectorAll('[data-sec]').forEach(function (el) { io.observe(el); });
    }

    // ---- VSL (o vídeo pode ser criado depois do clique, por isso escuta o documento inteiro)
    var MARCAS = [10, 25, 50, 75, 90, 100];
    // vídeo tocando sem som (prévia) não conta: só conta quando a pessoa liga o som
    document.addEventListener('play', function (e) { if (e.target && e.target.tagName === 'VIDEO' && !e.target.hasAttribute('data-previa')) enviar('vsl_play'); }, true);
    document.addEventListener('timeupdate', function (e) {
      var v = e.target; if (!v || v.tagName !== 'VIDEO' || !v.duration || v.hasAttribute('data-previa')) return;
      var p = (v.currentTime / v.duration) * 100;
      MARCAS.forEach(function (m) { if (p >= (m === 100 ? 97 : m)) enviar('vsl', m); });
    }, true);

    // ---- link do checkout com a origem (a Kiwify guarda src/utm/sck na venda)
    function marcarCheckout(a) {
      try {
        var u = new URL(a.href);
        u.searchParams.set('src', PAGINA);
        u.searchParams.set('utm_source', ORIGEM);
        u.searchParams.set('utm_medium', DISP);
        if (CAMPANHA) u.searchParams.set('utm_campaign', CAMPANHA);
        u.searchParams.set('sck', visitante);
        a.href = u.toString();
      } catch (e) {}
    }
    function rotulo(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60); }

    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a');
      if (a) {
        var href = a.getAttribute('href') || '';
        if (a.hasAttribute('data-comprar')) enviar('checkout', rotulo(a), true);
        else if (/pay\.kiwify\.com\.br/.test(a.href)) { marcarCheckout(a); enviar('checkout', rotulo(a), true); }
        else if (href === '#oferta') enviar('cta_oferta', rotulo(a), true);
        else if (/instagram\.com/.test(href)) enviar('instagram', rotulo(a));
      }
      var s = e.target.closest && e.target.closest('summary');
      if (s) enviar('faq', rotulo(s));
      var st = e.target.closest && e.target.closest('.story');
      if (st) enviar('story', rotulo(st));
    }, true);
    setTimeout(function () { document.querySelectorAll('a[href*="pay.kiwify.com.br"]').forEach(marcarCheckout); }, 800);

    // ---- tempo na página (só conta o tempo com a aba aberta e visível)
    var ativo = 0, desde = Date.now(), visivel = !document.hidden, mandouTempo = false;
    function somar() { if (visivel) ativo += Date.now() - desde; desde = Date.now(); }
    document.addEventListener('visibilitychange', function () {
      somar(); visivel = !document.hidden;
      if (document.hidden && !mandouTempo && ativo > 2000) { mandouTempo = true; enviar('tempo', Math.round(ativo / 1000)); }
    });
    addEventListener('pagehide', function () { somar(); if (!mandouTempo && ativo > 2000) { mandouTempo = true; enviar('tempo', Math.round(ativo / 1000)); } });
  } catch (e) { /* o rastreio nunca pode quebrar a página */ }
})();
