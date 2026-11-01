// Avisa no celular do dono quando alguém termina o cadastro (salvou o WhatsApp).
// Chamado pelo app logo depois de salvar o WhatsApp. Cada conta avisa uma vez só.
// Publicar com "Verify JWT" LIGADO. Segredos: VAPID_PUBLICA, VAPID_PRIVADA, VAPID_CONTATO.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import webpush from "npm:web-push@3.6.7";

const CHAVE_SERVICO = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0]) as string;
const DONO = "produtorts@gmail.com";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const ok = (c: unknown) => new Response(JSON.stringify(c), { headers: { ...CORS, "Content-Type": "application/json" } });
const zap = (n: string) => { const d = n.replace(/^55/, ""); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = Deno.env.get("SUPABASE_URL")!;
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const adm = createClient(url, CHAVE_SERVICO);
  const { data: { user } } = await adm.auth.getUser(token);
  if (!user) return new Response("nao autorizado", { status: 401, headers: CORS });

  const corpo = await req.json().catch(() => ({}));
  const campanha = String(corpo.campanha ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20);

  // Marca o aviso de forma atômica: só a primeira chamada de cada conta segue.
  const { data: marcado } = await adm.from("perfis").update({ aviso_cadastro: new Date().toISOString() })
    .eq("id", user.id).is("aviso_cadastro", null).not("whatsapp", "is", null).select("nome, whatsapp, email").maybeSingle();
  if (!marcado) return ok({ avisado: false });
  if ((user.email ?? "").toLowerCase() === DONO) return ok({ avisado: false });

  const { data: est } = await adm.from("estados").select("dados").eq("user_id", user.id).maybeSingle();
  // Só primeiro nome e sonho: sem WhatsApp, e-mail ou origem (a notificação pode virar prova social).
  const bruto = String(marcado.nome || est?.dados?.perfil?.nome || "").trim().split(/\s+/)[0] || "";
  const nome = bruto ? bruto.charAt(0).toLocaleUpperCase("pt-BR") + bruto.slice(1).toLocaleLowerCase("pt-BR") : "Alguém";
  const sonho = String(est?.dados?.cofres?.[0]?.nome || "").trim();
  const titulo = "🆕 Novo cadastro no Cofre";
  const texto = (sonho ? `${nome} começou a guardar para: ${sonho}` : `${nome} acabou de criar o seu Cofre dos Sonhos`).slice(0, 200);

  const { data: dono } = await adm.from("perfis").select("id").eq("email", DONO).maybeSingle();
  const { data: subs } = dono ? await adm.from("push_inscricoes").select("endpoint, p256dh, auth").eq("user_id", dono.id) : { data: [] };
  webpush.setVapidDetails(Deno.env.get("VAPID_CONTATO")!, Deno.env.get("VAPID_PUBLICA")!, Deno.env.get("VAPID_PRIVADA")!);
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ titulo, texto, tag: "cadastro-" + user.id, url: "./painel/" }), { TTL: 86400, urgency: "high" });
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.statusCode === 410) await adm.from("push_inscricoes").delete().eq("endpoint", s.endpoint);
    }
  }
  return ok({ avisado: true });
});
