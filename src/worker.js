// Tick — servidor de dados e notificações. Roda junto com o app (pasta public) no Worker "tick".
// Configuração toda no wrangler.jsonc: KV DADOS (tick-dados) e agendamento a cada minuto.
// Chave de acesso: criada pelo próprio app. O servidor aceita até MAX_USERS chaves (padrão 5).

const TZ = 'America/Sao_Paulo';
const MES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
const te = new TextEncoder();
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    let p = url.pathname;
    if (!p.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    p = p.slice(4); // tira o "/api"
    if (!env.DADOS) return json({ erro: 'KV DADOS não configurado' }, 500);
    try {
      if (p === '/status') return json(await status(env));
      if (p === '/vapid') return json({ key: (await vapid(env)).pub });

      const uid = await autentica(req, env);
      if (!uid) return json({ erro: 'chave inválida' }, 401);

      if (p === '/tick/data' && req.method === 'GET') return json((await env.DADOS.get('tick:data:' + uid, 'json')) || {});
      if (p === '/tick/data' && req.method === 'PUT') {
        const txt = await req.text();
        if (txt.length > 2_000_000) return json({ erro: 'grande demais' }, 413);
        const novo = JSON.parse(txt);
        const atual = await env.DADOS.get('tick:data:' + uid, 'json');
        if (atual && atual.u && novo.u && atual.u > novo.u) return json(atual, 409);
        await env.DADOS.put('tick:data:' + uid, JSON.stringify(novo));
        await registraUsuario(env, uid);
        return json({ ok: true, u: novo.u });
      }
      if (p === '/tick/subscribe' && req.method === 'POST') {
        const sub = await req.json();
        if (!sub || !sub.endpoint) return json({ erro: 'inscrição inválida' }, 400);
        const subs = ((await env.DADOS.get('tick:subs:' + uid, 'json')) || []).filter(s => s.endpoint !== sub.endpoint);
        subs.push({ endpoint: sub.endpoint, keys: sub.keys || null });
        await env.DADOS.put('tick:subs:' + uid, JSON.stringify(subs.slice(-5)));
        await registraUsuario(env, uid);
        return json({ ok: true, aparelhos: subs.length });
      }
      if (p === '/tick/notif') return json((await env.DADOS.get('tick:msg:' + uid, 'json')) || {});
      if (p === '/tick/teste' && req.method === 'POST') {
        const r = await notifica(env, uid, { title: 'Tick', body: 'Notificações ativadas. Os lembretes vão chegar aqui.', tag: 'teste' });
        return json({ ok: true, envio: r });
      }
      if (p === '/tick/teste-agendado' && req.method === 'POST') {
        // Teste do caminho completo: quem envia é o agendamento (cron), cerca de 1 minuto depois
        await env.DADOS.put('tick:agendado:' + uid, String(Date.now() + 60_000), { expirationTtl: 3600 });
        await registraUsuario(env, uid);
        return json({ ok: true });
      }
      return json({ erro: 'não encontrado' }, 404);
    } catch (e) {
      return json({ erro: 'falha', detalhe: String((e && e.message) || e) }, 500);
    }
  },

  async scheduled(ev, env, ctx) {
    ctx.waitUntil(cron(env));
  },
};

/* ---------- acesso ---------- */
async function autentica(req, env) {
  const k = (req.headers.get('X-Key') || '').trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(k)) return null;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(k)));
  const uid = [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
  const manuais = (env.ACCESS_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (manuais.includes(k)) return uid;
  const max = parseInt(env.MAX_USERS || '5', 10);
  const ok = (await env.DADOS.get('tick:keys', 'json')) || [];
  if (ok.includes(uid)) return uid;
  // chave que já tem dados guardados (ex.: conectada antes manualmente) continua valendo
  if (await env.DADOS.get('tick:data:' + uid)) { ok.push(uid); await env.DADOS.put('tick:keys', JSON.stringify(ok)); return uid; }
  if (ok.length >= max) return null;
  ok.push(uid);
  await env.DADOS.put('tick:keys', JSON.stringify(ok));
  return uid;
}
async function registraUsuario(env, uid) {
  const us = (await env.DADOS.get('tick:users', 'json')) || [];
  if (!us.includes(uid)) { us.push(uid); await env.DADOS.put('tick:users', JSON.stringify(us)); }
}

/* ---------- Web Push (mesmo método do Nexum: mensagem criptografada) ---------- */
const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); return Uint8Array.from(b, c => c.charCodeAt(0)); },
};
function concat(...a) { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; }
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
let VAPID = null;
async function vapid(env) {
  if (VAPID) return VAPID;
  let v = await env.DADOS.get('vapid', 'json');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)) };
    await env.DADOS.put('vapid', JSON.stringify(v));
  }
  VAPID = { pub: v.pub, key: await crypto.subtle.importKey('jwk', v.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  return VAPID;
}
async function jwt(env, aud) {
  const v = await vapid(env);
  const enc = o => b64u.enc(te.encode(JSON.stringify(o)));
  const dados = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:notificacoes@tick.app' });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, te.encode(dados));
  return { t: dados + '.' + b64u.enc(sig), k: v.pub };
}
async function encryptPayload(sub, payload) {
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(payload), new Uint8Array([2]))));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);
}
async function enviaPush(env, sub, msg) {
  const { t, k } = await jwt(env, new URL(sub.endpoint).origin);
  const headers = { Authorization: `vapid t=${t}, k=${k}`, TTL: '3600', Urgency: 'high' };
  let body = null;
  if (sub.keys && sub.keys.p256dh && sub.keys.auth) {
    body = await encryptPayload(sub, JSON.stringify(msg));
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
  }
  const r = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return r.status;
}
async function notifica(env, uid, msg) {
  const subs = (await env.DADOS.get('tick:subs:' + uid, 'json')) || [];
  const res = { aparelhos: subs.length, status: [] };
  if (!subs.length) return res;
  await env.DADOS.put('tick:msg:' + uid, JSON.stringify({ ...msg, em: Date.now() }), { expirationTtl: 3600 });
  const vivas = [];
  for (const s of subs) {
    let st = 0;
    try { st = await enviaPush(env, s, msg); } catch (e) { st = 'erro: ' + String((e && e.message) || e).slice(0, 100); }
    res.status.push(st);
    if (st !== 404 && st !== 410) vivas.push(s);
  }
  if (vivas.length !== subs.length) await env.DADOS.put('tick:subs:' + uid, JSON.stringify(vivas));
  return res;
}

/* ---------- regras de ponto (mesmas do app) ---------- */
const pad = n => String(n).padStart(2, '0');
const hm2m = s => { const [a, b] = String(s).split(':').map(Number); return a * 60 + b; };
const m2hm = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
const kOf = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());

function agora(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const key = `${p.year}-${p.month}-${p.day}`;
  const d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  return { key, wd: d.getUTCDay(), min: +p.hour * 60 + +p.minute, dd: +p.day, mes: +p.month - 1, ano: +p.year };
}
function pascoa(y) { const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), l = c % 4, m = (32 + 2 * e + 2 * i - h - l) % 7, n = Math.floor((a + 11 * h + 22 * m) / 451), mes = Math.floor((h + m - 7 * n + 114) / 31), dia = ((h + m - 7 * n + 114) % 31) + 1; return new Date(Date.UTC(y, mes - 1, dia)); }
function feriado(cfg, key) {
  if (cfg.feriados === false || (cfg.ignHol || []).includes(key)) return false;
  if (['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].includes(key.slice(5))) return true;
  const p = pascoa(+key.slice(0, 4)); p.setUTCDate(p.getUTCDate() - 2);
  return kOf(p) === key;
}
function jornada(cfg, key, wd) { return feriado(cfg, key) ? 0 : ((cfg.jornada || [])[wd] || 0); }
function durI(i, now) { const f = i.fim ? hm2m(i.fim) : now; const x = f - hm2m(i.ini); return x < 0 ? x + 1440 : x; }

function lembretes(S, A) {
  const cfg = S.cfg || {}, out = [];
  const r = (S.dias || {})[A.key];
  const especial = r && r.tipo && r.tipo !== 'trabalho';
  const j = especial ? 0 : jornada(cfg, A.key, A.wd);
  const b = ((r && r.batidas) || []).slice().sort();
  const n = b.length, ant = cfg.antecedencia ?? 10;

  if (j > 0) {
    let trab = 0; for (let i = 0; i + 1 < n; i += 2) trab += hm2m(b[i + 1]) - hm2m(b[i]);
    if (n % 2 === 1) trab += Math.max(0, A.min - hm2m(b[n - 1]));
    const desc = (S.interf || []).filter(i => i.data === A.key && (i.status || 'pendente') !== 'abonada').reduce((a, i) => a + durI(i, A.min), 0);
    trab -= Math.min(trab, desc);
    const falta = j - trab;

    const alvo = (id, hora, titulo) => out.push({ id, quando: hora - ant, title: titulo, body: ant ? `Faltam ${ant} min.` : 'Agora.' });
    if (n === 0 && cfg.horaEntrada) alvo('entrada', hm2m(cfg.horaEntrada), `Entrada às ${cfg.horaEntrada}`);
    if (n === 1 && cfg.horaAlmoco) alvo('almoco', hm2m(cfg.horaAlmoco), `Saída pro almoço às ${cfg.horaAlmoco}`);
    if (n === 2) { const v = hm2m(b[1]) + (cfg.intervalo || 60); alvo('volta', v, `Volta do almoço às ${m2hm(v)}`); }
    if (n === 3 && falta > 0) alvo('saida', A.min + falta, `Saída prevista às ${m2hm(A.min + falta)}`);

    if (cfg.lemEsquecido !== false) {
      if (n === 0 && cfg.horaEntrada) out.push({ id: 'esq-entrada', quando: hm2m(cfg.horaEntrada) + 15, title: 'Você ainda não bateu a entrada', body: 'Toque para registrar.' });
      if (n === 3) out.push({ id: 'esq-saida', quando: A.min + Math.max(0, falta) + 30, title: 'Ponto ainda aberto', body: 'Esqueceu de registrar a saída?' });
    }
    if (cfg.lemJornada !== false && n % 2 === 1 && falta <= 0) out.push({ id: 'jornada', quando: A.min, title: 'Jornada completa ✓', body: `Você já fez ${m2hm(j)} hoje.` });
  }

  // fechamento: primeiro dia útil do mês, às 09:00
  if (cfg.lemFechamento !== false && A.dd <= 7) {
    let primeiro = null;
    for (let d = 1; d <= 7; d++) { const dt = new Date(Date.UTC(A.ano, A.mes, d)); if (jornada(cfg, kOf(dt), dt.getUTCDay()) > 0) { primeiro = d; break; } }
    const pm = new Date(Date.UTC(A.ano, A.mes - 1, 1)), pym = pm.getUTCFullYear() + '-' + pad(pm.getUTCMonth() + 1);
    if (primeiro === A.dd && !(cfg.fechados || []).includes(pym)) {
      const np = (S.interf || []).filter(i => i.fim && (i.status || 'pendente') === 'pendente' && i.data.startsWith(pym)).length;
      out.push({ id: 'fechamento-' + pym, quando: 9 * 60, title: `Fechamento de ${MES[pm.getUTCMonth()]}`, body: (np ? `${np} ocorrência(s) pendente(s). ` : '') + 'Revise e envie os Excel do mês.' });
    }
  }
  return out;
}

async function cron(env) {
  const A = agora();
  const resumo = { em: new Date().toISOString(), hora: m2hm(A.min), usuarios: 0, aparelhos: 0, enviados: 0, status: [], erro: null };
  try {
    const us = (await env.DADOS.get('tick:users', 'json')) || [];
    resumo.usuarios = us.length;
    for (const uid of us) {
      const subs = await env.DADOS.get('tick:subs:' + uid, 'json');
      if (!subs || !subs.length) continue;
      resumo.aparelhos += subs.length;

      const ag = await env.DADOS.get('tick:agendado:' + uid);
      if (ag && Date.now() >= +ag) {
        await env.DADOS.delete('tick:agendado:' + uid);
        const r = await notifica(env, uid, { title: 'Teste agendado ✓', body: 'O agendamento está funcionando. Os lembretes de ponto vão chegar assim.', tag: 'teste-agendado' });
        resumo.enviados++; resumo.status.push(...r.status);
      }

      const S = await env.DADOS.get('tick:data:' + uid, 'json');
      if (!S) continue;
      const devidos = lembretes(S, A).filter(l => A.min >= l.quando && A.min - l.quando <= 5);
      for (const l of devidos) {
        const marca = `tick:sent:${uid}:${A.key}:${l.id}`;
        if (await env.DADOS.get(marca)) continue;
        await env.DADOS.put(marca, '1', { expirationTtl: 172800 });
        const r = await notifica(env, uid, { title: l.title, body: l.body, tag: l.id });
        resumo.enviados++; resumo.status.push(...r.status);
      }
    }
  } catch (e) { resumo.erro = String((e && e.message) || e).slice(0, 200); }
  // grava o resumo só quando enviou algo ou a cada 15 min (o KV gratuito tem limite de gravações por dia)
  if (resumo.enviados || resumo.erro || A.min % 15 === 0) await env.DADOS.put('tick:status', JSON.stringify(resumo));
  if (resumo.enviados) await env.DADOS.put('tick:ultimo-envio', JSON.stringify(resumo));
}

async function status(env) {
  const us = (await env.DADOS.get('tick:users', 'json')) || [];
  let aparelhos = 0;
  for (const uid of us) aparelhos += ((await env.DADOS.get('tick:subs:' + uid, 'json')) || []).length;
  return {
    servico: 'Tick',
    usuarios: us.length,
    aparelhos,
    ultimaVerificacao: (await env.DADOS.get('tick:status', 'json')) || 'nenhuma ainda (o agendamento grava a cada 15 min)',
    ultimoEnvio: (await env.DADOS.get('tick:ultimo-envio', 'json')) || 'nenhum ainda',
  };
}

