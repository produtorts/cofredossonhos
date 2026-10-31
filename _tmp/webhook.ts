// Recebe os avisos do Asaas e libera, renova ou deixa expirar o plano automaticamente.
// Segredos: ASAAS_WEBHOOK_TOKEN (o mesmo token configurado no webhook do Asaas), ASAAS_API_KEY, ASAAS_BASE
// Publicar com "Verify JWT" DESLIGADO (o Asaas não envia login do Supabase; a segurança é o token).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const CHAVE_SERVICO = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0]) as string;
const CARENCIA_DIAS = 3;
const DONO = "produtorts@gmail.com"; // recebe no celular o aviso de cada venda
const NOME_CICLO: Record<string, string> = { MONTHLY: "Mensal", QUARTERLY: "Trimestral", YEARLY: "Anual" };
const brl = (v: number) => "R$ " + Number(v || 0).toFixed(2).replace(".", ",");

// Aviso de venda no celular do dono (push do próprio app). Falha aqui nunca atrapalha a liberação do plano.
async function avisarDono(adm: any, titulo: string, texto: string) {
  try {
    const { data: dono } = await adm.from("perfis").select("id").eq("email", DONO).maybeSingle();
    if (!dono) return;
    const { data: subs } = await adm.from("push_inscricoes").select("endpoint, p256dh, auth").eq("user_id", dono.id);
    if (!subs?.length) return;
    webpush.setVapidDetails(Deno.env.get("VAPID_CONTATO")!, Deno.env.get("VAPID_PUBLICA")!, Deno.env.get("VAPID_PRIVADA")!);
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ titulo, texto, tag: "venda-" + Date.now(), url: "./painel/" }), { TTL: 86400, urgency: "high" });
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) await adm.from("push_inscricoes").delete().eq("endpoint", s.endpoint);
      }
    }
  } catch (_e) { /* sem aviso, segue */ }
}

Deno.serve(async (req) => {
  if (req.headers.get("asaas-access-token") !== Deno.env.get("ASAAS_WEBHOOK_TOKEN")) {
    return new Response("nao autorizado", { status: 401 });
  }
  const adm = createClient(Deno.env.get("SUPABASE_URL")!, CHAVE_SERVICO);
  const BASE = Deno.env.get("ASAAS_BASE") ?? "https://api.asaas.com/v3";
  const asaas = (caminho: string, init: RequestInit = {}) =>
    fetch(BASE + caminho, { ...init, headers: { "Content-Type": "application/json", "User-Agent": "cofre-dos-sonhos", access_token: Deno.env.get("ASAAS_API_KEY")! } });

  const corpo = await req.json().catch(() => ({}));
  const evento: string = corpo.event ?? "";

  // Pagamento confirmado (cartão) ou recebido (Pix/boleto): libera ou renova o plano.
  if (evento === "PAYMENT_CONFIRMED" || evento === "PAYMENT_RECEIVED") {
    const pg = corpo.payment ?? {};
    if (!pg.subscription) return new Response("ok");
    const { data: ass } = await adm.from("assinaturas").select("*").eq("id", pg.subscription).maybeSingle();
    if (!ass) return new Response("ok");

    const base = new Date(Math.max(Date.now(), Date.parse((pg.dueDate ?? "") + "T12:00:00Z") || Date.now()));
    if (ass.ciclo === "YEARLY") base.setUTCFullYear(base.getUTCFullYear() + 1);
    else if (ass.ciclo === "QUARTERLY") base.setUTCMonth(base.getUTCMonth() + 3);
    else base.setUTCMonth(base.getUTCMonth() + 1);
    base.setUTCDate(base.getUTCDate() + CARENCIA_DIAS);

    const primeiraVez = ass.status !== "ativa";
    const atualizar: Record<string, unknown> = { plano: ass.plano, plano_ate: base.toISOString() };
    if (ass.plano === "elite") atualizar.elite_fundador = true;
    await adm.from("perfis").update(atualizar).eq("id", ass.user_id);
    await adm.from("assinaturas").update({ status: "ativa", promo: false }).eq("id", ass.id);
    // Oferta de boas-vindas vale só no primeiro trimestre: as próximas cobranças voltam para R$ 29,90.
    if (ass.promo) await asaas(`/subscriptions/${ass.id}`, { method: "POST", body: JSON.stringify({ value: 29.9, updatePendingPayments: false }) });

    // Aviso no celular do dono: venda nova ou renovação (só no recebimento, para não avisar duas vezes).
    if (pg.billingType === "CREDIT_CARD" ? evento === "PAYMENT_CONFIRMED" : evento === "PAYMENT_RECEIVED") {
      const { data: cli } = await adm.from("perfis").select("nome, email").eq("id", ass.user_id).maybeSingle();
      const { data: est } = await adm.from("estados").select("dados").eq("user_id", ass.user_id).maybeSingle();
      const quem = cli?.nome || est?.dados?.perfil?.nome || cli?.email || "cliente";
      const planoNome = (ass.plano === "elite" ? "Elite" : "Premium") + " " + (NOME_CICLO[ass.ciclo] ?? "");
      await avisarDono(adm, primeiraVez ? "💰 Nova venda no Cofre!" : "🔁 Renovação paga", `${planoNome.trim()} · ${brl(pg.value)} · ${quem}`);
    }

    // Se a pessoa trocou de plano, cancela a assinatura antiga para não cobrar duas vezes.
    const { data: outras } = await adm.from("assinaturas").select("id").eq("user_id", ass.user_id).neq("id", ass.id).in("status", ["ativa", "pendente"]);
    for (const o of outras ?? []) {
      await asaas(`/subscriptions/${o.id}`, { method: "DELETE" });
      await adm.from("assinaturas").update({ status: "cancelada" }).eq("id", o.id);
    }
    return new Response("ok");
  }

  // Assinatura cancelada ou removida: o plano continua até o fim do período já pago.
  if (evento === "SUBSCRIPTION_DELETED" || evento === "SUBSCRIPTION_INACTIVATED") {
    const id = corpo.subscription?.id;
    if (id) await adm.from("assinaturas").update({ status: "cancelada" }).eq("id", id);
    return new Response("ok");
  }

  // Estorno ou contestação: encerra o plano na hora.
  if (evento === "PAYMENT_REFUNDED" || evento === "PAYMENT_PARTIALLY_REFUNDED" || evento === "PAYMENT_CHARGEBACK_REQUESTED") {
    const pg = corpo.payment ?? {};
    if (pg.subscription) {
      const { data: ass } = await adm.from("assinaturas").select("user_id").eq("id", pg.subscription).maybeSingle();
      if (ass) {
        await adm.from("perfis").update({ plano: "entrada", plano_ate: null }).eq("id", ass.user_id);
        await avisarDono(adm, evento === "PAYMENT_CHARGEBACK_REQUESTED" ? "⚠️ Contestação no cartão" : "↩️ Pagamento estornado", `${brl(pg.value)} · o Premium do cliente foi encerrado.`);
      }
    }
    return new Response("ok");
  }

  return new Response("ok");
});
