-- ===================================================================
-- EduNexus Pro: plans and subscriptions.
-- Run once in the Supabase SQL Editor. Safe to run twice.
--
-- The plan lives on the profile so every screen can check it cheaply,
-- but only the payment provider's webhook (service role) or an admin in
-- the SQL editor can change it. Nobody can upgrade themselves.
-- ===================================================================

alter table public.profiles add column if not exists plan            text not null default 'free'
  check (plan in ('free','pro'));
alter table public.profiles add column if not exists plan_interval   text check (plan_interval in ('monthly','yearly'));
alter table public.profiles add column if not exists plan_renews_at  timestamptz;

create table if not exists public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  provider            text not null default 'stripe',
  provider_ref        text,                    -- the provider's subscription id
  interval            text not null check (interval in ('monthly','yearly')),
  status              text not null default 'active'
                      check (status in ('active','past_due','canceled','trialing')),
  amount_cents        int,
  currency            text default 'USD',
  current_period_end  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists subs_user_idx on public.subscriptions(user_id, created_at desc);

alter table public.subscriptions enable row level security;
drop policy if exists p_subs_own on public.subscriptions;
create policy p_subs_own on public.subscriptions for select using (user_id = auth.uid());
-- writes come from the payment webhook using the service role, which bypasses RLS

-- a signed-in user can never change their own plan
create or replace function public.protect_plan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('authenticated','anon') then
    if tg_op = 'INSERT' then
      new.plan := 'free'; new.plan_interval := null; new.plan_renews_at := null;
    else
      new.plan := old.plan; new.plan_interval := old.plan_interval; new.plan_renews_at := old.plan_renews_at;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists protect_plan on public.profiles;
create trigger protect_plan before insert or update on public.profiles
  for each row execute function public.protect_plan();

-- what the webhook calls once a payment succeeds or a subscription ends
create or replace function public.set_plan(target uuid, new_plan text, new_interval text, renews timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set plan = new_plan,
         plan_interval = case when new_plan = 'pro' then new_interval else null end,
         plan_renews_at = case when new_plan = 'pro' then renews else null end
   where id = target;
end $$;
revoke execute on function public.set_plan(uuid, text, text, timestamptz) from public, anon, authenticated;

-- handy while testing: grant Pro to one account by email
-- select public.set_plan(
--   (select id from auth.users where lower(email) = lower('someone@school.lk')),
--   'pro', 'monthly', now() + interval '1 month');
