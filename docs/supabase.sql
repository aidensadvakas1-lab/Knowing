-- Tables for the Knowing Telegram bot.
-- Run this once in Supabase: SQL Editor > New query > paste > Run.
-- Only the server touches these tables (with the service-role key), so
-- row level security is on with no policies: nothing is readable from a browser.

create table if not exists bot_users (
  id bigint primary key,                 -- Telegram user id
  facts jsonb not null default '[]',     -- lasting things they've mentioned
  turns jsonb not null default '[]',     -- last few questions and answers
  awaiting_words_for text,               -- save id waiting for "what it says", or "fix:<id>" for a correction
  updated_at timestamptz not null default now()
);

create table if not exists saves (
  id text primary key,
  user_id bigint not null references bot_users (id) on delete cascade,
  title text not null default '',
  topic text not null default '',
  type text not null default 'info',
  summary text not null default '',
  steps jsonb not null default '[]',
  details text not null default '',
  needs_words boolean not null default false,
  source_url text not null default '',
  words text not null default '',
  practiced int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists saves_user_created on saves (user_id, created_at desc);

alter table bot_users enable row level security;
alter table saves enable row level security;

-- The video's own words (transcript + caption), kept so nothing a summary
-- dropped is lost. Searched through save_chunks below.
alter table saves add column if not exists source text not null default '';

-- Today's usage per user, for the daily limits ({day, videos, questions}).
alter table bot_users add column if not exists usage jsonb not null default '{}';

-- When the latest video of the current scroll session was saved ({last}), so
-- the bot can send a wrap-up once someone stops sharing. Empty when there's
-- nothing to wrap up.
alter table bot_users add column if not exists sitting jsonb;

-- Extra videos and questions bought with Telegram Stars ({videos, questions, paid}),
-- and the payments behind them, for refunds. Kept apart from usage so a slow
-- save of the user row can't undo a payment.
alter table bot_users add column if not exists wallet jsonb not null default '{}';

-- The weekly flashback setting ({on, offered, sent, quiet}). Off until they turn it on.
alter table bot_users add column if not exists digest jsonb not null default '{}';

-- Who invited them and how many friends earned them free videos ({by, name, credited, rewarded}).
alter table bot_users add column if not exists referral jsonb not null default '{}';

-- The folder each save is filed in. Empty means the first part of its topic
-- (saves from before folders could be moved).
alter table saves add column if not exists folder text not null default '';

-- Their filing rules ([{folder, about}]), like "anything about cars goes in Car mods".
alter table bot_users add column if not exists filing jsonb not null default '[]';

-- Their collections ([{name, ids}]): lists they make themselves, like Date night. A video can be in many.
alter table bot_users add column if not exists collections jsonb not null default '[]';

-- Retrieval (RAG): each save is split into chunks with an embedding (meaning)
-- and a full-text index (exact words). match_chunks merges both rankings.
create extension if not exists vector;

create table if not exists save_chunks (
  id bigint generated always as identity primary key,
  save_id text not null references saves (id) on delete cascade,
  user_id bigint not null,
  kind text not null,                    -- card, details or source
  content text not null,
  embedding vector(1536),                -- text-embedding-3-small; null when no embeddings key
  fts tsvector generated always as (to_tsvector('simple', content)) stored
);

create index if not exists save_chunks_user on save_chunks (user_id);
create index if not exists save_chunks_fts on save_chunks using gin (fts);
create index if not exists save_chunks_embedding on save_chunks using hnsw (embedding vector_cosine_ops);
alter table save_chunks enable row level security;

-- Hybrid search: reciprocal rank fusion of vector and full-text rankings.
create or replace function match_chunks(p_user_id bigint, p_query text, p_embedding vector(1536), p_k int default 12)
returns table (save_id text, kind text, content text, score float)
language sql stable as $$
  with by_meaning as (
    select c.id, row_number() over (order by c.embedding <=> p_embedding) as rank
    from save_chunks c
    where c.user_id = p_user_id and p_embedding is not null and c.embedding is not null
      and (c.embedding <=> p_embedding) < 0.75  -- skip chunks that aren't close in meaning
    order by c.embedding <=> p_embedding
    limit 50
  ),
  by_words as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, q) desc) as rank
    from save_chunks c, websearch_to_tsquery('simple', p_query) q
    where c.user_id = p_user_id and c.fts @@ q
    order by ts_rank_cd(c.fts, q) desc
    limit 50
  ),
  -- Loose word match too, so "mira setup bank" still hits a chunk with only "Mira" and "Bank".
  by_any_word as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, q) desc) as rank
    from save_chunks c,
      to_tsquery('simple', nullif(array_to_string(array(select quote_literal(w) from regexp_split_to_table(lower(p_query), '[^a-z0-9]+') w where length(w) > 1), ' | '), '')) q
    where c.user_id = p_user_id and q is not null and c.fts @@ q
    order by ts_rank_cd(c.fts, q) desc
    limit 50
  ),
  fused as (
    select id, sum(1.0 / (60 + rank)) as score
    from (select * from by_meaning union all select * from by_words union all select * from by_any_word) r
    group by id
  )
  select c.save_id, c.kind, c.content, f.score
  from fused f join save_chunks c on c.id = f.id
  order by f.score desc
  limit p_k;
$$;

-- Every chat (what they said and what the bot answered), so the bot remembers
-- conversations, not just videos. Found again by match_memories below.
-- Deleting the user (/delete) deletes these too.
create table if not exists chat_memories (
  id bigint generated always as identity primary key,
  user_id bigint not null references bot_users (id) on delete cascade,
  said text not null,
  answered text not null default '',
  embedding vector(1536),                -- null when no embeddings key
  fts tsvector generated always as (to_tsvector('simple', said || ' ' || answered)) stored,
  created_at timestamptz not null default now()
);

create index if not exists chat_memories_user on chat_memories (user_id, created_at desc);
create index if not exists chat_memories_fts on chat_memories using gin (fts);
create index if not exists chat_memories_embedding on chat_memories using hnsw (embedding vector_cosine_ops);
alter table chat_memories enable row level security;

-- Older chats that match a message: close in meaning, or containing all its words.
create or replace function match_memories(p_user_id bigint, p_query text, p_embedding vector(1536), p_k int default 6)
returns table (said text, answered text, created_at timestamptz, score float)
language sql stable as $$
  with by_meaning as (
    select m.id, row_number() over (order by m.embedding <=> p_embedding) as rank
    from chat_memories m
    where m.user_id = p_user_id and p_embedding is not null and m.embedding is not null
      and (m.embedding <=> p_embedding) < 0.75
    order by m.embedding <=> p_embedding
    limit 50
  ),
  by_words as (
    select m.id, row_number() over (order by ts_rank_cd(m.fts, q) desc) as rank
    from chat_memories m, websearch_to_tsquery('simple', p_query) q
    where m.user_id = p_user_id and m.fts @@ q
    order by ts_rank_cd(m.fts, q) desc
    limit 50
  ),
  fused as (
    select id, sum(1.0 / (60 + rank)) as score
    from (select * from by_meaning union all select * from by_words) r
    group by id
  )
  select m.said, m.answered, m.created_at, f.score
  from fused f join chat_memories m on m.id = f.id
  order by f.score desc
  limit p_k;
$$;

-- Using up a video or question happens in one step inside the database, so many
-- messages at once (forwarding 20 videos together) can't use more than someone has.
-- Order: today's Knowing Plus, then a free one, then a bought one.
-- Returns 'plan', 'free', 'wallet', or null when there's none left.
create or replace function bot_spend(p_id bigint, p_kind text, p_free int, p_plan_daily int, p_day text)
returns text
language plpgsql as $$
declare
  u bot_users%rowtype;
  p jsonb;
  used int;
begin
  if p_kind not in ('videos', 'questions') then return null; end if;
  select * into u from bot_users where id = p_id for update;
  if not found then return null; end if;
  p := u.wallet -> 'plan';
  if p_plan_daily > 0 and jsonb_typeof(p) = 'object' then
    if coalesce(p ->> 'day', '') <> p_day then
      p := p || jsonb_build_object('day', p_day, 'videos', 0, 'questions', 0);
    end if;
    used := coalesce(floor((p ->> p_kind)::numeric), 0)::int;
    if used < p_plan_daily then
      update bot_users set wallet = jsonb_set(u.wallet, '{plan}', p || jsonb_build_object(p_kind, used + 1)) where id = p_id;
      return 'plan';
    end if;
  end if;
  used := coalesce(floor((u.usage ->> p_kind)::numeric), 0)::int;
  if used < p_free then
    update bot_users set usage = u.usage || jsonb_build_object(p_kind, used + 1, 'day', coalesce(nullif(u.usage ->> 'day', ''), p_day)) where id = p_id;
    return 'free';
  end if;
  used := coalesce(floor((u.wallet ->> p_kind)::numeric), 0)::int;
  if used > 0 then
    update bot_users set wallet = u.wallet || jsonb_build_object(p_kind, used - 1) where id = p_id;
    return 'wallet';
  end if;
  return null;
end $$;

-- Gives back a use that got them nothing (a video that couldn't be saved).
create or replace function bot_give_back(p_id bigint, p_kind text, p_from text, p_day text)
returns void
language plpgsql as $$
begin
  if p_kind not in ('videos', 'questions') then return; end if;
  if p_from = 'free' then
    update bot_users set usage = usage || jsonb_build_object(p_kind, greatest(0, coalesce(floor((usage ->> p_kind)::numeric), 0)::int - 1)) where id = p_id;
  elsif p_from = 'wallet' then
    update bot_users set wallet = wallet || jsonb_build_object(p_kind, coalesce(floor((wallet ->> p_kind)::numeric), 0)::int + 1) where id = p_id;
  elsif p_from = 'plan' then
    update bot_users
      set wallet = jsonb_set(wallet, '{plan}', (wallet -> 'plan') || jsonb_build_object(p_kind, greatest(0, coalesce(floor((wallet -> 'plan' ->> p_kind)::numeric), 0)::int - 1)))
      where id = p_id and jsonb_typeof(wallet -> 'plan') = 'object' and wallet -> 'plan' ->> 'day' = p_day;
  end if;
end $$;

-- Adds what a Knowing Plus use really cost to the month, in one step. Returns the new total (null with no plan).
create or replace function bot_plan_cost(p_id bigint, p_dollars numeric)
returns numeric
language plpgsql as $$
declare
  total numeric;
begin
  update bot_users
    set wallet = jsonb_set(wallet, '{plan,cost}', to_jsonb(coalesce((wallet -> 'plan' ->> 'cost')::numeric, 0) + greatest(p_dollars, 0)))
    where id = p_id and jsonb_typeof(wallet -> 'plan') = 'object'
    returning (wallet -> 'plan' ->> 'cost')::numeric into total;
  return total;
end $$;

-- Only the bot's server key may call them.
revoke execute on function bot_spend(bigint, text, int, int, text), bot_give_back(bigint, text, text, text), bot_plan_cost(bigint, numeric) from public, anon, authenticated;
grant execute on function bot_spend(bigint, text, int, int, text), bot_give_back(bigint, text, text, text), bot_plan_cost(bigint, numeric) to service_role;

-- What each video and question really cost, per person per day, for /stats.
-- Measured from what each AI call reports (lib/bot/meter.ts). Deleted with the user.
create table if not exists bot_costs (
  day date not null,
  user_id bigint not null references bot_users (id) on delete cascade,
  kind text not null,                    -- 'videos' or 'questions'
  uses int not null default 0,           -- watched or answered, failed ones included
  failed int not null default 0,         -- failed and given back
  dollars numeric not null default 0,
  primary key (day, user_id, kind)
);
alter table bot_costs enable row level security;

create or replace function bot_add_cost(p_id bigint, p_kind text, p_dollars numeric, p_ok boolean)
returns void
language sql as $$
  insert into bot_costs (day, user_id, kind, uses, failed, dollars)
  select (now() at time zone 'utc')::date, p_id, p_kind, 1, case when p_ok then 0 else 1 end, greatest(p_dollars, 0)
  where p_kind in ('videos', 'questions')
  on conflict (day, user_id, kind) do update
    set uses = bot_costs.uses + 1,
        failed = bot_costs.failed + excluded.failed,
        dollars = bot_costs.dollars + excluded.dollars;
$$;
revoke execute on function bot_add_cost(bigint, text, numeric, boolean) from public, anon, authenticated;
grant execute on function bot_add_cost(bigint, text, numeric, boolean) to service_role;
