-- Run once in the Supabase SQL editor.
create extension if not exists pgcrypto;

create table if not exists sources (
  id          uuid primary key default gen_random_uuid(),
  platform    text not null check (platform in ('youtube','tiktok')),
  url         text not null,
  title       text,
  position    int  not null default 0,
  status      text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts    int  not null default 0,
  variants    text[] not null default '{pad}',  -- pad = blurred backdrop, fill = centre-crop
  plan        jsonb,                      -- Gemini's clip plan; lets a source resume across function runs
  rendered    int  not null default 0,    -- how many planned clips are already rendered
  duration_s  numeric,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (platform, url)
);
create index if not exists sources_queue_idx on sources (platform, status, position, created_at);

create table if not exists clips (
  id                uuid primary key,
  source_id         uuid references sources(id) on delete cascade,
  platform          text not null check (platform in ('youtube','tiktok')),
  idx               int  not null default 0,
  start_s           numeric,
  end_s             numeric,
  headline          text,
  title             text,
  description       text,
  hashtags          text[] not null default '{}',
  variant           text not null default 'pad',
  storage_provider  text,
  storage_key       text,
  storage_url       text,
  status            text not null default 'ready' check (status in ('ready','posting','posted','failed')),
  scheduled_at      timestamptz,
  posted_at         timestamptz,
  platform_post_id  text,
  attempts          int  not null default 0,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists clips_due_idx on clips (platform, status, scheduled_at);

create table if not exists kv (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);

alter table sources enable row level security;
alter table clips   enable row level security;
alter table kv      enable row level security;

insert into storage.buckets (id, name, public) values ('clips', 'clips', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- users (email sign-in for the dashboard)
-- Safe to run again on an existing database.
create table if not exists users (
  id          uuid primary key,              -- the Supabase Auth user id
  email       text unique not null,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);
alter table users enable row level security;
alter table sources add column if not exists created_by uuid references users(id) on delete set null;
