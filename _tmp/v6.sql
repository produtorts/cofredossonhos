-- v6: código de campanha reutilizável (ex.: COFRE7 no link do ManyChat).
-- Cada conta só ganha 1 teste na vida, e cada número de WhatsApp também.

create table if not exists public.campanhas (
  codigo text primary key,          -- sempre em maiúsculas
  dias int not null default 7,
  ativo boolean not null default true,
  expira timestamptz,               -- vazio = sem prazo
  criado timestamptz not null default now()
);
alter table public.campanhas enable row level security; -- ninguém lê pelo app; só as funções do servidor

alter table public.perfis add column if not exists campanha text;
create index if not exists perfis_whatsapp_idx on public.perfis (whatsapp);

insert into public.campanhas (codigo, dias) values ('COFRE7', 7) on conflict (codigo) do nothing;

create or replace function public.ativar_cupom(p_codigo text) returns json
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid(); cod text := upper(trim(coalesce(p_codigo, '')));
  c public.cupons%rowtype; camp public.campanhas%rowtype; p public.perfis%rowtype; fim timestamptz;
begin
  if uid is null then return json_build_object('ok', false, 'erro', 'Entre na sua conta para ativar o cupom.'); end if;
  select * into p from public.perfis where id = uid for update;
  if p.teste_ate is not null then
    if p.teste_ate > now() then return json_build_object('ok', true, 'teste_ate', p.teste_ate); end if;
    return json_build_object('ok', false, 'erro', 'Você já usou o seu teste grátis de 7 dias.');
  end if;

  -- 1) Código de campanha (o mesmo para todo mundo, um uso por conta e por WhatsApp)
  select * into camp from public.campanhas where codigo = cod;
  if found then
    if not camp.ativo or (camp.expira is not null and camp.expira < now()) then
      return json_build_object('ok', false, 'erro', 'Este código expirou. Comente COFRE de novo no post para receber o novo.');
    end if;
    if p.whatsapp is null then
      return json_build_object('ok', false, 'motivo', 'sem_whatsapp', 'erro', 'Informe o seu WhatsApp para liberar o teste grátis.');
    end if;
    if exists (select 1 from public.perfis o where o.whatsapp = p.whatsapp and o.id <> uid and o.teste_ate is not null) then
      return json_build_object('ok', false, 'erro', 'Este WhatsApp já usou o teste grátis de 7 dias.');
    end if;
    fim := now() + make_interval(days => camp.dias);
    update public.perfis set
      origem = coalesce(origem, 'cupom'), campanha = camp.codigo, teste_ate = fim,
      plano = case when plano <> 'entrada' and plano_ate > fim then plano else 'premium' end,
      plano_ate = greatest(coalesce(plano_ate, now()), fim)
    where id = uid;
    return json_build_object('ok', true, 'teste_ate', fim);
  end if;

  -- 2) Cupom individual (gerado pelo ManyChat Pro, um por @ do Instagram)
  fim := now() + interval '7 days';
  select * into c from public.cupons where codigo = cod for update;
  if not found then return json_build_object('ok', false, 'erro', 'Cupom não encontrado. Confira as letras e os números.'); end if;
  if c.usado_por = uid then return json_build_object('ok', true, 'teste_ate', p.teste_ate); end if;
  if c.usado_por is not null then return json_build_object('ok', false, 'erro', 'Este cupom já foi usado.'); end if;
  if c.expira < now() then return json_build_object('ok', false, 'erro', 'Este cupom expirou. Comente COFRE de novo no post para receber outro.'); end if;
  if exists (select 1 from public.cupons where lower(instagram) = lower(c.instagram) and usado_por is not null) then
    return json_build_object('ok', false, 'erro', 'Este Instagram já usou o teste grátis.'); end if;
  if p.whatsapp is not null and exists (select 1 from public.perfis o where o.whatsapp = p.whatsapp and o.id <> uid and o.teste_ate is not null) then
    return json_build_object('ok', false, 'erro', 'Este WhatsApp já usou o teste grátis de 7 dias.');
  end if;
  update public.cupons set usado_por = uid, usado_em = now() where codigo = c.codigo;
  update public.perfis set
    origem = coalesce(origem, 'cupom'), instagram = c.instagram, campanha = coalesce(campanha, 'MANYCHAT'), teste_ate = fim,
    plano = case when plano <> 'entrada' and plano_ate > fim then plano else 'premium' end,
    plano_ate = greatest(coalesce(plano_ate, now()), fim)
  where id = uid;
  return json_build_object('ok', true, 'teste_ate', fim);
end $$;
revoke all on function public.ativar_cupom(text) from public, anon;
grant execute on function public.ativar_cupom(text) to authenticated;

-- painel_clientes agora também devolve a campanha de origem.
drop function if exists public.painel_clientes();
create or replace function public.painel_clientes() returns table (
  id uuid, email text, nome text, whatsapp text, whatsapp_aceite boolean, criado timestamptz,
  plano text, plano_ate timestamptz, teste_ate timestamptz, origem text, instagram text,
  kiwify_basico boolean, kiwify_plano text, kiwify_plano_ate timestamptz,
  assinatura_ciclo text, assinatura_status text, ultimo_uso timestamptz,
  pix_gerado_em timestamptz, pix_ciclo text, pix_promo boolean, campanha text
)
language plpgsql security definer set search_path = public stable as $$
begin
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> 'produtorts@gmail.com' then
    raise exception 'acesso negado';
  end if;
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
revoke all on function public.painel_clientes() from public, anon;
grant execute on function public.painel_clientes() to authenticated;
