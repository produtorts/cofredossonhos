// Roda de hora em hora (pg_cron). Decide quem recebe lembrete nesta hora e envia o push.
// Segredos: CRON_SEGREDO, VAPID_PUBLICA, VAPID_PRIVADA, VAPID_CONTATO (ex.: mailto:contato@cofredossonhos.com)
// Publicar com "Verify JWT" DESLIGADO (a segurança é o x-cron-segredo).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";
const MENSAGENS = {"reservaMensal": [{"t": "Dia de alimentar o cofre", "m": "{C} mandou dizer que está com saudade de você. Faltam {f}."}, {"t": "Hoje é dia de reserva", "m": "Antes do boleto, antes do delivery: primeiro {o_c}. Faltam {f}."}, {"t": "Lembrete combinado", "m": "Foi você que marcou: hoje é dia de guardar para {c}. Eu só estou cobrando."}, {"t": "Dia do depósito", "m": "Primeiro você se paga. Depois paga o resto. {C} está em {p}%."}, {"t": "Sua conquista te chamou", "m": "{C} está em {p}%. Um depósito hoje e esse número sobe."}, {"t": "Salário caiu?", "m": "Então separa a parte {do_c} antes que o mês decida por você."}], "desafioSemanal": [{"t": "Domingo do desafio", "m": "Quantos dias sem gasto por impulso nessa semana? Marca aí. Você está em {n}/30."}, {"t": "Check-in da semana", "m": "Desafio dos 30 dias: {n} conquistados. Bora fechar a semana no controle?"}, {"t": "Hora da verdade", "m": "Essa semana você mandou no dinheiro ou o dinheiro mandou em você? Marca seus dias."}, {"t": "Desafio te esperando", "m": "{n}/30 dias sem impulso. Quem chega no 30 vira outra pessoa com dinheiro."}, {"t": "Semana nova, placar novo", "m": "Cada dia sem impulso é um tijolo {do_c}. Marca os de hoje."}], "indoBem": [{"t": "Você está voando", "m": "Adiantado {no_c}. Quem é você e o que fez com quem gastava tudo no dia 10?"}, {"t": "Acima do plano", "m": "Você guardou mais do que o combinado este mês. Nesse ritmo, {o_c} chega antes."}, {"t": "Constância detectada", "m": "Semanas seguidas guardando. É assim que gente comum vira gente que conquista."}, {"t": "Recado da sua conquista", "m": "{C} pediu para avisar: está chegando mais rápido do que esperava."}], "sumiu": [{"t": "Tudo bem por aí?", "m": "{s} semanas sem guardar nada. {C} não desistiu de você. Vai desistir?"}, {"t": "Saudade", "m": "Faz {s} semanas que o cofre não vê um centavo. Até R$ 10 já reacende."}, {"t": "Volta pra cá", "m": "{C} continua em {p}%. Um depósito pequeno hoje vale mais que um grande que nunca chega."}, {"t": "Recomeço vale", "m": "Parou? Acontece. Recomeçar hoje é a decisão mais rica que você pode tomar."}], "motivacao": [{"t": "Frase do dia", "m": "Rico não é quem ganha muito. É quem não abandona o próprio cofre."}, {"t": "Frase do dia", "m": "Não espere sobrar para guardar. Guarde para que sobre."}, {"t": "Frase do dia", "m": "Quem guarda pouco todo mês vence quem guarda muito uma vez."}, {"t": "Frase do dia", "m": "O impulso passa. A conquista fica."}, {"t": "Frase do dia", "m": "Seu futuro está sendo pago hoje. Escolha bem o que você compra."}, {"t": "Frase do dia", "m": "Ambição sem plano é só vontade. Com plano, vira data marcada."}, {"t": "Frase do dia", "m": "Ninguém vai sonhar o seu sonho por você. Nem pagar por ele."}, {"t": "Bom dia", "m": "Hoje é mais um dia para provar que você leva {o_c} a sério."}, {"t": "Lembra por quê", "m": "Olha o seu wallpaper. É por aquilo ali que você está fazendo tudo isso."}, {"t": "Frase do dia", "m": "Liberdade financeira é silêncio: ninguém vê, mas você sente."}, {"t": "Frase do dia", "m": "Todo grande patrimônio começou com alguém que decidiu guardar o primeiro real."}, {"t": "Frase do dia", "m": "O caminho da conquista é feito de \"nãos\" para as coisas pequenas."}], "teste5": [{"t": "Faltam 2 dias do seu teste", "m": "Você já guardou {g} para os seus sonhos. Garanta o Premium e continue de onde parou."}, {"t": "Seu teste está acabando", "m": "Mais 2 dias de Premium. {C} está em {p}%: não deixa esse progresso parar."}], "teste7": [{"t": "Amanhã seu cofre será pausado", "m": "Seu teste Premium termina hoje. Ative o Premium e {o_c} continua de onde parou."}, {"t": "Último dia de teste", "m": "Amanhã {o_c} pausa em {p}%. Um toque e ele continua crescendo."}], "teste8": [{"t": "Seu cofre foi pausado", "m": "{C} está pausado em {p}%. Continue de onde parou: trimestral por R$ 24,90 só nas próximas 48 horas."}]};

const CHAVE_SERVICO = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0]) as string;
const brl = (v: number) => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: Math.abs(v) % 1 ? 2 : 0 });

function formasNome(nome: string, cat: string) {
  const FEM = ["viagem", "casa", "moto", "reserva", "faculdade", "loja", "empresa", "minha", "primeira", "nova"];
  const MASC = ["carro", "celular", "notebook", "setup", "negócio", "negocio", "apartamento", "curso", "intercâmbio", "sonho", "meu", "primeiro", "novo", "iphone"];
  const COMUNS = ["viagem", "casa", "carro", "moto", "reserva", "celular", "notebook", "setup", "faculdade", "negócio", "negocio", "loja", "apartamento", "curso", "primeiro", "primeira", "novo", "nova", "empresa"];
  let t = String(nome || "conquista").trim();
  let fem: boolean;
  const m = t.match(/^(minha|meu|minhas|meus)\s+(.+)$/i);
  if (m) { fem = /^minha/i.test(m[1]); t = m[2]; }
  else { const p = t.split(/\s+/)[0].toLowerCase(); fem = FEM.includes(p) ? true : MASC.includes(p) ? false : ["casa", "moto", "neve", "praia", "liberdade", "estudos"].includes(cat); }
  const p0 = t.split(/\s+/)[0];
  if (COMUNS.includes(p0.toLowerCase())) t = p0.toLowerCase() + t.slice(p0.length);
  const pos = fem ? "sua" : "seu", art = fem ? "a" : "o", c = `${pos} ${t}`;
  return { c, C: c[0].toUpperCase() + c.slice(1), o_c: `${art} ${c}`, O_c: `${art.toUpperCase()} ${c}`, do_c: `${fem ? "da" : "do"} ${c}`, no_c: `${fem ? "na" : "no"} ${c}` };
}
function montar(tipo: string, vars: Record<string, string | number>, semente: number) {
  const lista = (MENSAGENS as Record<string, { t: string; m: string }[]>)[tipo];
  const item = lista[semente % lista.length];
  const troca = (s: string) => s.replace(/\{(\w+)\}/g, (_, n) => (vars[n] !== undefined ? String(vars[n]) : ""));
  return { titulo: troca(item.t), texto: troca(item.m) };
}

// Hora e data em São Paulo.
function agoraSP() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  const dias: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { data: `${p.year}-${p.month}-${p.day}`, dia: Number(p.day), hora: Number(p.hour) % 24, semana: dias[p.weekday as string] };
}
const DIAS_MOTIVACAO: Record<number, number[]> = { 2: [2, 5], 3: [1, 3, 5], 5: [1, 2, 3, 4, 5] };

type Cofre = { id: string; nome: string; cat: string; meta: number; guardado: number; data: string; depositos?: { v: number; data: string }[] };

// Situação do plano: teste do cupom, pausado, básico da Kiwify, Premium ativo.
type Situacao = { modo: "premium" | "teste" | "pausado" | "basico" | "sem"; restaHoras: number; desdeHoras: number; basicoDias: number };
function situacao(perfil: any, acesso: any): Situacao {
  const agora = Date.now();
  const ativo = (pl?: string, ate?: string) => !!pl && pl !== "entrada" && (Date.parse(ate ?? "") || 0) > agora;
  const fimTeste = Date.parse(perfil?.teste_ate ?? "") || 0;
  const ateP = Date.parse(perfil?.plano_ate ?? "") || 0;
  const pago = ativo(acesso?.plano, acesso?.plano_ate) || (ativo(perfil?.plano, perfil?.plano_ate) && (!fimTeste || ateP > fimTeste + 60e3));
  const base = { restaHoras: (fimTeste - agora) / 3600e3, desdeHoras: (agora - fimTeste) / 3600e3, basicoDias: acesso?.criado ? (agora - Date.parse(acesso.criado)) / 864e5 : 99 };
  if (pago) return { modo: "premium", ...base };
  if (fimTeste && fimTeste > agora) return { modo: "teste", ...base };
  if (acesso?.basico) return { modo: "basico", ...base };
  if (fimTeste) return { modo: "pausado", ...base };
  return { modo: "sem", ...base };
}

function decidir(dados: any, sp: ReturnType<typeof agoraSP>, st: Situacao) {
  const L = Object.assign({ reserva: true, diaReserva: 5, desafio: true, diaDesafio: 0, motivacao: 3, horaMotivacao: 8, progresso: true }, dados.lembretes || {});
  const cofres: Cofre[] = dados.cofres || [];
  const ativo = cofres.filter((c) => c.guardado < c.meta).sort((a, b) => b.guardado / b.meta - a.guardado / a.meta)[0] || cofres[0];
  const base = ativo ? { ...formasNome(ativo.nome, ativo.cat), p: Math.min(100, Math.floor((ativo.guardado / ativo.meta) * 100)), f: brl(Math.max(0, ativo.meta - ativo.guardado)) } : formasNome("conquista", "outro");
  const vars: Record<string, string | number> = { ...base, n: Math.min(30, (dados.d30 || []).length), g: brl(cofres.reduce((a, c) => a + (Number(c.guardado) || 0), 0)) };

  // Teste de 7 dias do cupom: avisos dos dias 5 e 7; no dia 8, um único aviso de pausa.
  if (st.modo === "teste") {
    const dias = Math.ceil(st.restaHoras / 24);
    if (dias === 2 || dias === 1) return sp.hora === 10 ? { tipo: dias === 2 ? "teste5" : "teste7", vars } : null;
    // Nos outros dias do teste: frase motivacional todo dia, para animar.
    if (sp.hora === L.horaMotivacao) return { tipo: "motivacao", vars };
  }
  if (st.modo === "pausado") return sp.hora === 10 && st.desdeHoras < 24 ? { tipo: "teste8", vars } : null;
  if (st.modo === "sem") return null;

  // Prioridade: reserva > desafio > progresso > motivação (no máximo 1 por dia).
  if (L.reserva && ativo && sp.dia === L.diaReserva && sp.hora === 9) return { tipo: "reservaMensal", vars };
  if (L.desafio && sp.semana === L.diaDesafio && sp.hora === 19) return { tipo: "desafioSemanal", vars };
  if (L.progresso && ativo && sp.semana === 0 && sp.hora === 18) {
    const todos = cofres.flatMap((c) => c.depositos || []);
    const ultimo = todos.filter((d) => d.v > 0).map((d) => d.data).sort().at(-1);
    const semanas = ultimo ? Math.floor((Date.parse(sp.data) - Date.parse(ultimo)) / (7 * 864e5)) : 99;
    if (semanas >= 3 && semanas < 99) return { tipo: "sumiu", vars: { ...vars, s: semanas } };
    const mes = sp.data.slice(0, 7);
    const noMes = (ativo.depositos || []).filter((d) => d.data.startsWith(mes)).reduce((a, d) => a + d.v, 0);
    const meses = Math.max(1, (new Date(ativo.data).getFullYear() - new Date(sp.data).getFullYear()) * 12 + (new Date(ativo.data).getMonth() - new Date(sp.data).getMonth()));
    const planoMes = Math.max(0, (ativo.meta - ativo.guardado + noMes) / meses);
    if (noMes > 0 && noMes >= planoMes) return { tipo: "indoBem", vars };
  }
  // Básico da Kiwify: motivação todo dia só na primeira semana (gostinho do Premium); depois, só no Premium.
  if (st.modo === "basico") return st.basicoDias < 7 && sp.hora === L.horaMotivacao ? { tipo: "motivacao", vars } : null;
  if (L.motivacao && (DIAS_MOTIVACAO[L.motivacao] || []).includes(sp.semana) && sp.hora === L.horaMotivacao) return { tipo: "motivacao", vars };
  return null;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-segredo") !== Deno.env.get("CRON_SEGREDO")) return new Response("nao autorizado", { status: 401 });
  const sp = agoraSP();
  if (sp.hora < 7 || sp.hora > 21) return new Response("fora do horario");

  webpush.setVapidDetails(Deno.env.get("VAPID_CONTATO")!, Deno.env.get("VAPID_PUBLICA")!, Deno.env.get("VAPID_PRIVADA")!);
  const adm = createClient(Deno.env.get("SUPABASE_URL")!, CHAVE_SERVICO);

  const { data: inscricoes } = await adm.from("push_inscricoes").select("user_id, endpoint, p256dh, auth");
  const porUsuario = new Map<string, { endpoint: string; p256dh: string; auth: string }[]>();
  for (const i of inscricoes || []) porUsuario.set(i.user_id, [...(porUsuario.get(i.user_id) || []), i]);
  if (!porUsuario.size) return new Response("ninguem inscrito");

  const ids = [...porUsuario.keys()];
  const { data: estados } = await adm.from("estados").select("user_id, dados").in("user_id", ids);
  const { data: jaHoje } = await adm.from("lembretes_log").select("user_id").eq("dia", sp.data).in("user_id", ids);
  const enviados = new Set((jaHoje || []).map((x) => x.user_id));
  const { data: perfis } = await adm.from("perfis").select("id, email, plano, plano_ate, origem, teste_ate").in("id", ids);
  const emails = (perfis || []).map((p) => p.email).filter(Boolean);
  const { data: acessos } = emails.length ? await adm.from("acessos").select("email, basico, plano, plano_ate, criado").in("email", emails) : { data: [] };
  const perfilDe = new Map((perfis || []).map((p) => [p.id, p]));
  const acessoDe = new Map((acessos || []).map((a) => [a.email, a]));

  let total = 0;
  for (const e of estados || []) {
    if (enviados.has(e.user_id)) continue;
    const perfil = perfilDe.get(e.user_id);
    const d = decidir(e.dados || {}, sp, situacao(perfil, acessoDe.get(perfil?.email)));
    if (!d) continue;
    const semente = sp.dia + sp.hora + e.user_id.charCodeAt(0);
    const msg = montar(d.tipo, d.vars, semente);
    const { error: jaFoi } = await adm.from("lembretes_log").insert({ user_id: e.user_id, dia: sp.data, tipo: d.tipo });
    if (jaFoi) continue; // outra execução já enviou hoje
    for (const s of porUsuario.get(e.user_id) || []) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ ...msg, tag: d.tipo }), { TTL: 6 * 3600 });
        total++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await adm.from("push_inscricoes").delete().eq("endpoint", s.endpoint);
      }
    }
  }
  return new Response(JSON.stringify({ enviados: total }), { headers: { "Content-Type": "application/json" } });
});
