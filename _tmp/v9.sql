-- v9: funil do painel (visitas e etapas do cadastro). Sem IP e sem dados pessoais: só um código aleatório do aparelho.
create table if not exists public.eventos (
  id bigserial primary key,
  visitante text not null,
  evento text not null,
  campanha text,
  user_id uuid,
  dia date not null default (now() at time zone 'America/Sao_Paulo')::date,
  criado timestamptz not null default now()
);
create index if not exists eventos_evento_criado on public.eventos (evento, criado);
create unique index if not exists eventos_visita_unica on public.eventos (visitante, evento, dia) where evento = 'visita';
create unique index if not exists eventos_etapa_unica on public.eventos (visitante, evento) where evento <> 'visita';
alter table public.eventos enable row level security; -- sem políticas: só a função abaixo grava

create or replace function public.registrar_evento(p_visitante text, p_evento text, p_campanha text default null) returns void
language plpgsql security definer set search_path = public as $$
declare cam text := nullif(upper(regexp_replace(coalesce(p_campanha, ''), '[^A-Za-z0-9-]', '', 'g')), '');
begin
  if p_evento not in ('visita', 'inicio', 'conquista') then return; end if;
  if p_visitante is null or length(p_visitante) < 8 or length(p_visitante) > 40 then return; end if;
  insert into public.eventos (visitante, evento, campanha, user_id)
  values (p_visitante, p_evento, left(coalesce(cam, 'DIRETO'), 20), auth.uid())
  on conflict do nothing;
end $$;
revoke all on function public.registrar_evento(text, text, text) from public;
grant execute on function public.registrar_evento(text, text, text) to anon, authenticated;

-- Números do funil para o painel (só o servidor chama).
create or replace function public.painel_funil_admin(p_dias int) returns json
language sql security definer set search_path = public stable as $$
  with janela as (select now() - make_interval(days => greatest(1, least(coalesce(p_dias, 7), 3650))) as desde),
  ev as (select e.* from public.eventos e, janela j where e.criado >= j.desde),
  pf as (select p.* from public.perfis p, janela j where p.criado >= j.desde and p.email <> 'produtorts@gmail.com'),
  ass as (select a.* from public.assinaturas a, janela j where a.criado >= j.desde),
  etapas as (
    select coalesce(campanha, 'DIRETO') as campanha,
      count(distinct visitante) filter (where evento = 'visita') as visitas,
      count(distinct visitante) filter (where evento = 'inicio') as inicio,
      count(distinct visitante) filter (where evento = 'conquista') as conquista
    from ev group by 1
  ),
  contas as (
    select coalesce(pf.campanha, 'DIRETO') as campanha,
      count(*) as contas,
      count(*) filter (where pf.whatsapp is not null) as whatsapp,
      count(*) filter (where pf.teste_ate is not null) as teste
    from pf group by 1
  ),
  vendas as (
    select coalesce(p.campanha, 'DIRETO') as campanha,
      count(distinct a.user_id) as pix,
      count(distinct a.user_id) filter (where a.status = 'ativa' or exists (
        select 1 from public.assinaturas b where b.user_id = a.user_id and b.status = 'ativa')) as pagou
    from ass a join public.perfis p on p.id = a.user_id where p.email <> 'produtorts@gmail.com' group by 1
  ),
  linhas as (
    select c.campanha,
      coalesce(e.visitas, 0) visitas, coalesce(e.inicio, 0) inicio, coalesce(e.conquista, 0) conquista,
      coalesce(k.contas, 0) contas, coalesce(k.whatsapp, 0) whatsapp, coalesce(k.teste, 0) teste,
      coalesce(v.pix, 0) pix, coalesce(v.pagou, 0) pagou
    from (select campanha from etapas union select campanha from contas union select campanha from vendas) c
    left join etapas e using (campanha) left join contas k using (campanha) left join vendas v using (campanha)
  ),
  por_dia as (
    select d::date as dia,
      (select count(distinct visitante) from public.eventos where evento = 'visita' and dia = d::date) as visitas,
      (select count(*) from public.perfis where (criado at time zone 'America/Sao_Paulo')::date = d::date and email <> 'produtorts@gmail.com') as contas
    from generate_series((now() at time zone 'America/Sao_Paulo')::date - (least(coalesce(p_dias, 7), 90) - 1), (now() at time zone 'America/Sao_Paulo')::date, interval '1 day') d
  )
  select json_build_object(
    'campanhas', coalesce((select json_agg(l order by l.visitas desc, l.contas desc) from linhas l), '[]'::json),
    'dias', coalesce((select json_agg(d order by d.dia) from por_dia d), '[]'::json)
  );
$$;
revoke all on function public.painel_funil_admin(int) from public, anon, authenticated;
grant execute on function public.painel_funil_admin(int) to service_role;
