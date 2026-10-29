-- Tables for the Knowing Telegram bot.
-- Run this once in Supabase: SQL Editor > New query > paste > Run.
-- Only the server touches these tables (with the service-role key), so
-- row level security is on with no policies: nothing is readable from a browser.

create table if not exists bot_users (
  id bigint primary key,                 -- Telegram user id
  goal text not null default '',
  turns jsonb not null default '[]',     -- last few questions and answers
  offer jsonb,                           -- pending keep / switch / both choice
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
