-- Tables for the Knowing Telegram bot.
-- Run this once in Supabase: SQL Editor > New query > paste > Run.
-- Only the server touches these tables (with the service-role key), so
-- row level security is on with no policies: nothing is readable from a browser.

create table if not exists bot_users (
  id bigint primary key,                 -- Telegram user id
  facts jsonb not null default '[]',     -- lasting things they've mentioned
  turns jsonb not null default '[]',     -- last few questions and answers
  awaiting_words_for text,               -- save id waiting for "what it says"
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
