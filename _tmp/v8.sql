-- v8: painel com login próprio. Só o servidor (função painel-dados) lê a lista de clientes.
create table if not exists public.painel_tentativas (ip text not null, quando timestamptz not null default now());
create index if not exists painel_tentativas_ip on public.painel_tentativas (ip, quando);
alter table public.painel_tentativas enable row level security; -- sem políticas: ninguém lê pelo app

drop function if exists public.painel_clientes_admin();
create or replace function public.painel_clientes_admin() returns table (
  id uuid, email text, nome text, whatsapp text, whatsapp_aceite boolean, criado timestamptz,
  plano text, plano_ate timestamptz, teste_ate timestamptz, origem text, instagram text,
  kiwify_basico boolean, kiwify_plano text, kiwify_plano_ate timestamptz,
  assinatura_ciclo text, assinatura_status text, ultimo_uso timestamptz,
  pix_gerado_em timestamptz, pix_ciclo text, pix_promo boolean, campanha text
)
language plpgsql security definer set search_path = public stable as $$
begin
  return query
  select p.id, p.email,
    coalesce(p.nome, e.dados -> 'perfil' ->> 'nome'),
    p.whatsapp, p.whatsapp_aceite, p.criado,
    p.plano, p.plano_ate, p.teste_ate, p.origem, p.instagram,
    coalesce(a.basico, false), a.plano, a.plano_ate,
    s.ciclo, s.status, e.atualizado,
    pend.criado, pend.ciclo, pend.promo, p.campanha
  from public.perfis p
  left join public.acessos a on a.email = p.email
  left join public.estados e on e.user_id = p.id
  left join lateral (
    select x.ciclo, x.status from public.assinaturas x where x.user_id = p.id
    order by (x.status = 'ativa') desc, x.criado desc limit 1
  ) s on true
  left join lateral (
    select y.criado, y.ciclo, y.promo from public.assinaturas y where y.user_id = p.id and y.status = 'pendente'
    order by y.criado desc limit 1
  ) pend on true
  order by p.criado desc;
end $$;
revoke all on function public.painel_clientes_admin() from public, anon, authenticated;
grant execute on function public.painel_clientes_admin() to service_role;

-- O acesso pela conta do app deixa de existir: o painel só abre com o usuário e a senha do painel.
drop function if exists public.painel_clientes();
