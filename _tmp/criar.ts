// Cria a assinatura no Asaas (só Pix) e devolve o QR Code para o app mostrar na própria tela.
// O cliente nunca abre a página do Asaas e não recebe e-mails dele (os avisos ficam no app).
// Corpo: { plano, nome, cpf }  -> nova assinatura (ou reaproveita a pendente)
//        { acao: "pendente" }  -> QR da cobrança em aberto (renovação)
// Segredos: ASAAS_API_KEY, ASAAS_BASE (https://api.asaas.com/v3)
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

    // QR Code de uma cobrança (para a tela do app).
    async function qrDaCobranca(pagamento: { id: string; value: number; dueDate: string }, nomePlano: string) {
      const q = await asaas(`/payments/${pagamento.id}/pixQrCode`);
      if (!q.ok || !q.corpo?.payload) return null;
      return { pagamento: pagamento.id, valor: pagamento.value, vence: pagamento.dueDate, plano: nomePlano, qr: q.corpo.encodedImage, copia: q.corpo.payload };
    }
    async function cobrancaAberta(assinatura: string) {
      const pg = await asaas(`/payments?subscription=${assinatura}&limit=10`);
      const lista = (pg.corpo?.data ?? []) as { id: string; status: string; value: number; dueDate: string }[];
      return lista.filter((p) => p.status === "PENDING" || p.status === "OVERDUE").sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;
    }

    const corpo = await req.json();

    // Renovação: QR da cobrança em aberto da assinatura ativa.
    if (corpo.acao === "pendente") {
      const { data: ass } = await adm.from("assinaturas").select("id, plano, ciclo").eq("user_id", user.id).eq("status", "ativa").order("criado", { ascending: false }).limit(1).maybeSingle();
      if (!ass) return resposta({ erro: "Nenhuma assinatura ativa." }, 404);
      const aberta = await cobrancaAberta(ass.id);
      if (!aberta) return resposta({ nada: true });
      const nome = Object.values(PLANOS).find((p) => p.plano === ass.plano && p.ciclo === ass.ciclo)?.nome ?? "Cofre dos Sonhos Premium";
      const qr = await qrDaCobranca(aberta, nome);
      return qr ? resposta(qr) : resposta({ erro: "Não foi possível gerar o Pix agora. Tente de novo." }, 502);
    }

    const { plano, nome, cpf } = corpo;
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

    // Cliente no Asaas, sempre com os e-mails/SMS do Asaas desligados (quem avisa é o app).
    let cliente = perfil?.asaas_customer as string | null;
    if (!cliente) {
      const c = await asaas("/customers", {
        method: "POST",
        body: JSON.stringify({ name: String(nome).trim(), cpfCnpj: cpfLimpo, email: user.email, externalReference: user.id, notificationDisabled: true }),
      });
      if (!c.ok) return resposta({ erro: "Não foi possível cadastrar seus dados de pagamento." }, 502);
      cliente = c.corpo.id;
      await adm.from("perfis").update({ asaas_customer: cliente }).eq("id", user.id);
    } else {
      await asaas(`/customers/${cliente}`, { method: "POST", body: JSON.stringify({ name: String(nome).trim(), cpfCnpj: cpfLimpo, notificationDisabled: true }) });
    }

    // Reaproveita uma assinatura Pix pendente igual; as demais pendentes são canceladas (evita cobranças duplicadas).
    const { data: pendentes } = await adm.from("assinaturas").select("id, plano, ciclo, promo").eq("user_id", user.id).eq("status", "pendente").order("criado", { ascending: false });
    for (const a of pendentes ?? []) {
      const info = await asaas(`/subscriptions/${a.id}`);
      const igual = info.ok && info.corpo?.billingType === "PIX" && info.corpo?.status === "ACTIVE" && a.plano === p.plano && a.ciclo === p.ciclo && !!a.promo === promo && Number(info.corpo?.value) === valor;
      if (igual) {
        const aberta = await cobrancaAberta(a.id);
        if (aberta) { const qr = await qrDaCobranca(aberta, p.nome); if (qr) return resposta(qr); }
      }
      await asaas(`/subscriptions/${a.id}`, { method: "DELETE" });
      await adm.from("assinaturas").update({ status: "cancelada" }).eq("id", a.id);
    }

    const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // data de Brasília
    const s = await asaas("/subscriptions", {
      method: "POST",
      body: JSON.stringify({ customer: cliente, billingType: "PIX", value: valor, nextDueDate: hoje, cycle: p.ciclo, description: p.nome + (promo ? " - oferta de boas-vindas" : ""), externalReference: user.id }),
    });
    if (!s.ok) return resposta({ erro: "Não foi possível criar a assinatura." }, 502);
    await adm.from("assinaturas").insert({ id: s.corpo.id, user_id: user.id, plano: p.plano, ciclo: p.ciclo, status: "pendente", promo });

    // A primeira cobrança pode levar um instante para existir.
    let aberta = null;
    for (let i = 0; i < 4 && !aberta; i++) { aberta = await cobrancaAberta(s.corpo.id); if (!aberta) await new Promise((r) => setTimeout(r, 800)); }
    if (!aberta) return resposta({ erro: "Assinatura criada, mas o Pix ainda não ficou pronto. Toque em assinar de novo em instantes." }, 502);
    const qr = await qrDaCobranca(aberta, p.nome);
    if (!qr) return resposta({ erro: "Não foi possível gerar o QR Code do Pix. Tente de novo em instantes." }, 502);
    return resposta(qr);
  } catch (_e) {
    return resposta({ erro: "Erro inesperado. Tente de novo." }, 500);
  }
});
