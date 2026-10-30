// Recebe os avisos do Asaas e libera, renova ou deixa expirar o plano automaticamente.
// Segredos: ASAAS_WEBHOOK_TOKEN (o mesmo token configurado no webhook do Asaas), ASAAS_API_KEY, ASAAS_BASE
// Publicar com "Verify JWT" DESLIGADO (o Asaas não envia login do Supabase; a segurança é o token).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CHAVE_SERVICO = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0]) as string;
const CARENCIA_DIAS = 3;

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

    const atualizar: Record<string, unknown> = { plano: ass.plano, plano_ate: base.toISOString() };
    if (ass.plano === "elite") atualizar.elite_fundador = true;
    await adm.from("perfis").update(atualizar).eq("id", ass.user_id);
    await adm.from("assinaturas").update({ status: "ativa", promo: false }).eq("id", ass.id);
    // Oferta de boas-vindas vale só no primeiro trimestre: as próximas cobranças voltam para R$ 29,90.
    if (ass.promo) await asaas(`/subscriptions/${ass.id}`, { method: "POST", body: JSON.stringify({ value: 29.9, updatePendingPayments: false }) });

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
  if (evento === "PAYMENT_REFUNDED" || evento === "PAYMENT_CHARGEBACK_REQUESTED") {
    const pg = corpo.payment ?? {};
    if (pg.subscription) {
      const { data: ass } = await adm.from("assinaturas").select("user_id").eq("id", pg.subscription).maybeSingle();
      if (ass) await adm.from("perfis").update({ plano: "entrada", plano_ate: null }).eq("id", ass.user_id);
    }
    return new Response("ok");
  }

  return new Response("ok");
});
