create table if not exists payment_transactions (
  id uuid primary key default gen_random_uuid(),
  order_no text unique not null,
  ksher_order_no text,
  device_id text,
  amount integer not null,
  total_fee integer not null,
  currency text not null default 'THB',
  status text not null default 'PENDING',
  qr_text text,
  ksher_result text,
  raw_create jsonb,
  raw_status jsonb,
  raw_notify jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz,
  cancelled_at timestamptz
);

create index if not exists payment_transactions_status_idx
  on payment_transactions(status);

create index if not exists payment_transactions_created_at_idx
  on payment_transactions(created_at desc);

create table if not exists payment_logs (
  id bigserial primary key,
  order_no text,
  event_type text not null,
  status text,
  message text,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payment_logs_order_no_idx
  on payment_logs(order_no);

create index if not exists payment_logs_created_at_idx
  on payment_logs(created_at desc);
