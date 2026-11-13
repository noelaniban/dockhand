-- Pilot schema (Postgres 16). The POC keeps the same shapes in memory (lib/orchestrator/store.ts).
-- Design rules:
--   * Every agent step and every tool call is a row, so the audit trail is a query, not a log scrape.
--   * Approvals are rows with a person on them. Nothing books without one unless the site's
--     autonomy policy allows it, and the policy in force is recorded on the step.
--   * Customer emails hold personal data under the PDPA: keep bodies in one table with a
--     retention date, and reference them by id everywhere else.

create table sites (
  id            text primary key,              -- 'shah-alam-dc'
  name          text not null,
  autonomy      text not null default 'approve' check (autonomy in ('approve', 'auto')),
  benchmark_cap numeric(4,2) not null default 1.00  -- auto-run never books above benchmark x cap
);

create table carriers (
  id             text primary key,
  name           text not null,
  equipment      text[] not null,
  apad_permit_no text,
  permit_valid_to date,                         -- checked on every quote request
  rate_per_km    numeric(6,2),
  on_time_pct    numeric(5,2)
);

create table emails (
  id           text primary key,
  site_id      text not null references sites(id),
  from_name    text,
  company      text,
  subject      text,
  body         text not null,                   -- personal data: purge after retain_until
  received_at  timestamptz not null default now(),
  retain_until date not null default (now() + interval '180 days')
);

create table requests (
  id          text primary key,
  email_id    text not null references emails(id),
  site_id     text not null references sites(id),
  state       text not null check (state in ('needs_you', 'agents_working', 'waiting_on_customer', 'booked', 'cancelled')),
  arrived_at  timestamptz not null default now(),
  booked_at   timestamptz
);

-- One row per agent step. data holds the Order, Plan or Deal as JSON (lib/domain/types.ts).
create table steps (
  id          bigserial primary key,
  request_id  text not null references requests(id),
  step        text not null check (step in ('intake', 'dispatch', 'carrier', 'booking')),
  status      text not null check (status in ('running', 'review', 'approved', 'blocked', 'done')),
  source      text not null check (source in ('model', 'scripted', 'seeded')),
  model       text,                             -- e.g. claude-sonnet-5-5, for evals and cost
  data        jsonb,
  notes       text[] not null default '{}',     -- guardrail interventions, fallbacks
  autonomy    text not null,                    -- policy in force when the step ran
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (request_id, step)
);

create table approvals (
  id          bigserial primary key,
  step_id     bigint not null references steps(id),
  decided_by  text not null,                    -- user id, or 'agent' under auto-run
  decision    text not null check (decision in ('approved', 'asked_customer', 'rejected')),
  decided_at  timestamptz not null default now()
);

-- Every tool call any agent made, with what it saw. This is the audit trail.
create table tool_calls (
  id          bigserial primary key,
  step_id     bigint not null references steps(id),
  tool        text not null,                    -- tms_open_loads, carriers_send_counter, ...
  input       jsonb not null,
  output      jsonb,
  called_at   timestamptz not null default now()
);

create table loads (
  id           text primary key,                -- LD-2291
  site_id      text not null references sites(id),
  destination  text not null,
  temp         text not null check (temp in ('ambient', 'chilled', 'frozen')),
  pallets      int not null check (pallets between 0 and 26),
  pickup       text,
  carrier_id   text references carriers(id),
  rate_rm      numeric(10,2),
  status       text not null check (status in ('planned', 'booked', 'cancelled')),
  reserved_by  text references requests(id)      -- held while a plan waits for approval
);

create table load_orders (
  load_id     text not null references loads(id),
  request_id  text not null references requests(id),
  pallets     int not null,
  primary key (load_id, request_id)
);

create index on steps (request_id);
create index on tool_calls (step_id);
create index on requests (site_id, state);
