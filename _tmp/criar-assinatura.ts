// Cria a assinatura no Asaas e devolve o link de pagamento (Pix, cartão ou boleto).
// Segredos necessários: ASAAS_API_KEY, ASAAS_BASE (https://api.asaas.com/v3 ou https://api-sandbox.asaas.com/v3)
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CHAVE_SERVICO = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0]) as string;
// Oferta do dia 8: quem testou pelo cupom paga R$ 24,90 no primeiro trimestre se assinar em até 48h após o fim do teste.
const PROMO_TRIMESTRAL = 24.9;
const PROMO_HORAS = 48;
const PLANOS: Record<string, { plano: "premium" | "elite"; ciclo: "MONTHLY" | "QUARTERLY" | "YEARLY"; valor: number; nome: string }> = {
  premium_mensal: { plano: "premium", ciclo: "MONTHLY", valor: 12.9, nome: "Cofre dos Sonhos Premium (mensal)" },
  premium_trimestral: { plano: "premium", ciclo: "QUARTERLY", valor: 29.9, nome: "Cofre dos Sonhos Premium (trimestral)" },
  elite_fundador: { plano: "elite", ciclo: "MONTHLY", valor: 29.9, nome: "Cofre dos Sonhos Elite Fundador" },
};
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const resposta = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function cpfValido(cpf: string) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dig = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(cpf[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dig(9) === Number(cpf[9]) && dig(10) === Number(cpf[10]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const BASE = Deno.env.get("ASAAS_BASE") ?? "https://api.asaas.com/v3";
    const asaas = (caminho: string, init: RequestInit = {}) =>
      fetch(BASE + caminho, {
        ...init,
        headers: { "Content-Type": "application/json", "User-Agent": "cofre-dos-sonhos", access_token: Deno.env.get("ASAAS_API_KEY")!, ...(init.headers ?? {}) },
      }).then(async (r) => ({ ok: r.ok, corpo: await r.json().catch(() => ({})) }));

    const url = Deno.env.get("SUPABASE_URL")!;
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = await createClient(url, CHAVE_SERVICO).auth.getUser(token);
    if (!user) return resposta({ erro: "Entre na sua conta para assinar." }, 401);
    const adm = createClient(url, CHAVE_SERVICO);

    const { plano, nome, cpf } = await req.json();
    const p = PLANOS[plano];
    if (!p) return resposta({ erro: "Plano inválido." }, 400);
    const cpfLimpo = String(cpf ?? "").replace(/\D/g, "");
    if (!cpfValido(cpfLimpo)) return resposta({ erro: "CPF inválido. Confira os números." }, 400);
    if (!String(nome ?? "").trim()) return resposta({ erro: "Informe seu nome completo." }, 400);

    if (p.plano === "elite") {
      const { data: vagas } = await adm.rpc("vagas_elite");
      if ((vagas ?? 0) <= 0) return resposta({ erro: "As vagas de Elite Fundador acabaram." }, 409);
    }

    const { data: perfil } = await adm.from("perfis").select("asaas_customer, origem, teste_ate").eq("id", user.id).maybeSingle();
    const fimTeste = Date.parse(perfil?.teste_ate ?? "") || 0;
    const { count: jaPagou } = await adm.from("assinaturas").select("*", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "ativa");
    const promo = plano === "premium_trimestral" && perfil?.origem === "cupom" && fimTeste > 0 && Date.now() >= fimTeste && Date.now() < fimTeste + PROMO_HORAS * 3600e3 && !jaPagou;
    const valor = promo ? PROMO_TRIMESTRAL : p.valor;
    let cliente = perfil?.asaas_customer as string | null;
    if (!cliente) {
      const c = await asaas("/customers", {
        method: "POST",
        body: JSON.stringify({ name: String(nome).trim(), cpfCnpj: cpfLimpo, email: user.email, externalReference: user.id, notificationDisabled: false }),
      });
      if (!c.ok) return resposta({ erro: "Não foi possível cadastrar seus dados de pagamento." }, 502);
      cliente = c.corpo.id;
      await adm.from("perfis").update({ asaas_customer: cliente }).eq("id", user.id);
    }

    const hoje = new Date().toISOString().slice(0, 10);
    const s = await asaas("/subscriptions", {
      method: "POST",
      body: JSON.stringify({ customer: cliente, billingType: "UNDEFINED", value: valor, nextDueDate: hoje, cycle: p.ciclo, description: p.nome + (promo ? " - oferta de boas-vindas" : ""), externalReference: user.id }),
    });
    if (!s.ok) return resposta({ erro: "Não foi possível criar a assinatura." }, 502);
    await adm.from("assinaturas").insert({ id: s.corpo.id, user_id: user.id, plano: p.plano, ciclo: p.ciclo, status: "pendente", promo });

    const pg = await asaas(`/subscriptions/${s.corpo.id}/payments`);
    const link = pg.corpo?.data?.[0]?.invoiceUrl;
    if (!link) return resposta({ erro: "Assinatura criada, mas o link de pagamento não ficou pronto. Tente de novo em instantes." }, 502);
    return resposta({ url: link });
  } catch (_e) {
    return resposta({ erro: "Erro inesperado. Tente de novo." }, 500);
  }
});
