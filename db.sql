create table if not exists users (
  id bigserial primary key,
  tg_user_id bigint unique not null,
  tg_username text,
  base_currency text not null default 'SAR',
  created_at timestamptz not null default now()
);

create table if not exists categories (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique(user_id, name)
);

create table if not exists vendors (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique(user_id, name)
);

create table if not exists transactions (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  vendor_id bigint references vendors(id),
  category_id bigint references categories(id),
  tx_date date not null,
  amount numeric(12,2) not null,
  currency text not null default 'SAR',
  description text,
  raw_text text,
  hash text,
  created_at timestamptz not null default now()
);

create unique index if not exists ux_transactions_user_hash
on transactions(user_id, hash) where hash is not null;

create table if not exists budgets (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  category_id bigint not null references categories(id) on delete cascade,
  month date not null,
  amount numeric(12,2) not null,
  currency text not null default 'SAR',
  created_at timestamptz not null default now(),
  unique(user_id, category_id, month)
);

create table if not exists alerts_log (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  alert_type text not null,
  alert_key text not null,
  created_at timestamptz not null default now(),
  unique(user_id, alert_type, alert_key)
);
