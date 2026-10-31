-- v4: WhatsApp obrigatório no cadastro + painel de clientes do dono.

alter table public.perfis add column if not exists nome text;
alter table public.perfis add column if not exists whatsapp text;            -- só números, com 55 + DDD
alter table public.perfis add column if not exists whatsapp_aceite boolean not null default false;
alter table public.perfis add column if not exists whatsapp_em timestamptz;

-- O app salva nome e WhatsApp da pessoa logada (ela não consegue mexer no plano).
create or replace function public.salvar_contato(p_nome text, p_whatsapp text, p_aceite boolean) returns json
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); n text := regexp_replace(coalesce(p_whatsapp,''), '\D', '', 'g');
begin
  if uid is null then return json_build_object('ok', false, 'erro', 'Entre na sua conta.'); end if;
  if length(n) in (10, 11) then n := '55' || n; end if;
  if not (n ~ '^55[1-9][0-9]9?[0-9]{8}$') then return json_build_object('ok', false, 'erro', 'WhatsApp inválido. Use DDD + número.'); end if;
  if not coalesce(p_aceite, false) then return json_build_object('ok', false, 'erro', 'Marque a caixa de autorização.'); end if;
  update public.perfis set
    nome = coalesce(nullif(left(trim(p_nome), 60), ''), nome),
    whatsapp = n, whatsapp_aceite = true, whatsapp_em = now()
  where id = uid;
  return json_build_object('ok', true, 'whatsapp', n);
end $$;
revoke all on function public.salvar_contato(text, text, boolean) from public, anon;
grant execute on function public.salvar_contato(text, text, boolean) to authenticated;

-- meu_status passa a dizer se a pessoa já informou o WhatsApp.
create or replace function public.meu_status() returns json
language sql security definer set search_path = public stable as $$
  select json_build_object(
    'plano', p.plano, 'plano_ate', p.plano_ate, 'origem', p.origem, 'teste_ate', p.teste_ate,
    'kiwify_basico', coalesce(a.basico, false),
    'kiwify_plano', a.plano, 'kiwify_plano_ate', a.plano_ate,
    'pagou', exists (select 1 from public.assinaturas s where s.user_id = p.id and s.status = 'ativa'),
    'whatsapp', p.whatsapp is not null and p.whatsapp_aceite
  )
  from public.perfis p
  left join public.acessos a on a.email = lower(auth.jwt() ->> 'email')
  where p.id = auth.uid();
$$;
revoke all on function public.meu_status() from public, anon;
grant execute on function public.meu_status() to authenticated;

-- Painel: lista de clientes. Só funciona para o e-mail do dono.
create or replace function public.painel_clientes() returns table (
  id uuid, email text, nome text, whatsapp text, whatsapp_aceite boolean, criado timestamptz,
  plano text, plano_ate timestamptz, teste_ate timestamptz, origem text, instagram text,
  kiwify_basico boolean, kiwify_plano text, kiwify_plano_ate timestamptz,
  assinatura_ciclo text, assinatura_status text, ultimo_uso timestamptz
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
    s.ciclo, s.status, e.atualizado
  from public.perfis p
  left join public.acessos a on a.email = p.email
  left join public.estados e on e.user_id = p.id
  left join lateral (
    select x.ciclo, x.status from public.assinaturas x where x.user_id = p.id
    order by (x.status = 'ativa') desc, x.criado desc limit 1
  ) s on true
  order by p.criado desc;
end $$;
revoke all on function public.painel_clientes() from public, anon;
grant execute on function public.painel_clientes() to authenticated;
