// Painel de clientes com login próprio (usuário e senha do painel, separados da conta do app).
// Só leitura: devolve a lista de clientes; não altera nada no sistema.
// Segredos: PAINEL_USUARIO, PAINEL_SENHA (o dono cadastra no Supabase). Publicar com "Verify JWT" DESLIGADO.
// Corpo: { usuario, senha } -> { token }   |   { token } -> { clientes }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CHAVE_SERVICO = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0]) as string;
const CORS = { "Access-Control-Allow-Origin": "https://www.cofredossonhos.com", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Vary": "Origin" };
const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const DURACAO_H = 12;          // a sessão do painel dura 12 horas
const MAX_ERROS = 5;           // tentativas erradas permitidas...
const JANELA_MIN = 15;         // ...a cada 15 minutos (por aparelho/rede)

const enc = new TextEncoder();
async function chaveHmac() {
  const base = (Deno.env.get("PAINEL_SENHA") ?? "") + "|" + CHAVE_SERVICO; // trocar a senha derruba as sessões abertas
  return crypto.subtle.importKey("raw", enc.encode(base), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function assinar(exp: number) { const k = await chaveHmac(); return exp + "." + b64(await crypto.subtle.sign("HMAC", k, enc.encode("painel." + exp))); }
async function tokenValido(t: string) {
  const [exp, sig] = String(t || "").split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return (await assinar(Number(exp))) === exp + "." + sig;
}
function iguais(a: string, b: string) { // comparação em tempo constante
  const x = enc.encode(a), y = enc.encode(b); let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "método inválido" }, 405);
  const adm = createClient(Deno.env.get("SUPABASE_URL")!, CHAVE_SERVICO);
  const corpo = await req.json().catch(() => ({}));
  const usuarioOk = Deno.env.get("PAINEL_USUARIO"), senhaOk = Deno.env.get("PAINEL_SENHA");
  if (!usuarioOk || !senhaOk) return json({ erro: "O acesso ao painel ainda não foi configurado." }, 503);

  // Login
  if (corpo.usuario !== undefined || corpo.senha !== undefined) {
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
    const desde = new Date(Date.now() - JANELA_MIN * 60e3).toISOString();
    const { count } = await adm.from("painel_tentativas").select("*", { count: "exact", head: true }).eq("ip", ip).gte("quando", desde);
    if ((count ?? 0) >= MAX_ERROS) return json({ erro: `Muitas tentativas. Espere ${JANELA_MIN} minutos e tente de novo.` }, 429);
    const uOk = iguais(String(corpo.usuario ?? "").trim().toLowerCase(), usuarioOk.trim().toLowerCase());
    const sOk = iguais(String(corpo.senha ?? ""), senhaOk);
    const certo = uOk && sOk;
    if (!certo) {
      await adm.from("painel_tentativas").insert({ ip });
      await new Promise((r) => setTimeout(r, 800));
      return json({ erro: "Usuário ou senha incorretos." }, 401);
    }
    return json({ token: await assinar(Date.now() + DURACAO_H * 3600e3) });
  }

  // Dados (só leitura)
  if (!(await tokenValido(corpo.token))) return json({ erro: "sessao" }, 401);
  const { data, error } = await adm.rpc("painel_clientes_admin");
  if (error) return json({ erro: "Não foi possível carregar os clientes." }, 500);
  return json({ clientes: data ?? [] });
});
