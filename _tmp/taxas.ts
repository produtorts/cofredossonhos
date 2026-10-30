// Taxas atuais do Banco Central para o simulador do app (CDI e Selic, % ao ano).
// Fonte: API SGS do Banco Central (série 4389 = CDI anualizado base 252; série 432 = meta Selic).
// Publicar com "Verify JWT" DESLIGADO (dado público). Guarda em memória por 6 horas.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
let cache: { t: number; corpo: string } | null = null;

async function serie(n: number) {
  const r = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${n}/dados/ultimos/1?formato=json`, { headers: { Accept: "application/json" } });
  const j = await r.json();
  return { valor: Number(String(j[0].valor).replace(",", ".")), data: String(j[0].data) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const cabecalho = { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" };
  if (cache && Date.now() - cache.t < 6 * 3600e3) return new Response(cache.corpo, { headers: cabecalho });
  try {
    const [cdi, selic] = await Promise.all([serie(4389), serie(432)]);
    if (!(cdi.valor > 0) || !(selic.valor > 0)) throw new Error("valor invalido");
    const corpo = JSON.stringify({ cdi: cdi.valor, selic: selic.valor, data: cdi.data, fonte: "Banco Central do Brasil" });
    cache = { t: Date.now(), corpo };
    return new Response(corpo, { headers: cabecalho });
  } catch (_e) {
    if (cache) return new Response(cache.corpo, { headers: cabecalho });
    return new Response(JSON.stringify({ erro: "indisponivel" }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
