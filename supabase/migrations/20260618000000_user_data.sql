create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  store_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_memories (
  user_id uuid primary key references auth.users (id) on delete cascade,
  personal_info text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  text text not null default '',
  image_url text,
  photos jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.ai_memories enable row level security;
alter table public.chat_messages enable row level security;

create policy "profiles read own"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "profiles insert own"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "profiles update own"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "ai memories read own"
  on public.ai_memories for select
  using (auth.uid() = user_id);

create policy "ai memories insert own"
  on public.ai_memories for insert
  with check (auth.uid() = user_id);

create policy "ai memories update own"
  on public.ai_memories for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "chat messages read own"
  on public.chat_messages for select
  using (auth.uid() = user_id);

create policy "chat messages insert own"
  on public.chat_messages for insert
  with check (auth.uid() = user_id);

create policy "chat messages delete own"
  on public.chat_messages for delete
  using (auth.uid() = user_id);

create index if not exists idx_chat_messages_user_created
  on public.chat_messages (user_id, created_at);
