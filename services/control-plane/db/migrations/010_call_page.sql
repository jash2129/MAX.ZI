-- The customer call page (portal /c/<dealership>?deal=<deal_id>). No account: a valid deal link is the
-- ticket. Every call costs money (video, speech, avatar, AI), so a link starts at most 3 calls
-- (reconnects) within its 2-hour life.
alter table deal add column if not exists starts int not null default 0;

-- Uses one start of a deal link: its vehicle and first name if the deal is this dealership's,
-- unexpired, and under the start limit; nothing otherwise.
create function app.claim_deal(deal_ref uuid, d text) returns table (vehicle jsonb, customer_first_name text)
language plpgsql volatile security definer set search_path = public, app as $$
begin
  return query
    update deal set starts = deal.starts + 1
     where deal.id = deal_ref and deal.dealership_id = d and deal.expires_at > now() and deal.starts < 3
    returning deal.vehicle, deal.customer_first_name;
end $$;

-- What a customer's page may show about a dealership (nothing private): its name, Max's name, branding,
-- the approved product terms for the coverage panels, and whether it takes calls (all three versions
-- live). Unknown dealerships return null.
create function app.call_page(d text) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select jsonb_build_object(
    'id', x.id,
    'name', x.name,
    'max_display_name', x.max_display_name,
    'branding', x.branding,
    'products', coalesce((select products from price_ladder_version where dealership_id = x.id and status = 'live'), '[]'::jsonb),
    'ready', exists (select 1 from script_version where dealership_id = x.id and status = 'live')
         and exists (select 1 from price_ladder_version where dealership_id = x.id and status = 'live')
         and exists (select 1 from kb_version where dealership_id = x.id and status = 'live'))
  from dealership x where x.id = d
$$;

revoke all on function app.claim_deal(uuid, text), app.call_page(text) from public;
grant execute on function app.claim_deal(uuid, text), app.call_page(text) to app_user;
