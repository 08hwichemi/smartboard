-- 🗓 교외체험학습 현황판(11/10): 결석계의 "교외체험학습" 기록을, 관리자가 정한 "쓰는 학년"(app_settings trip_board.grades)에서는
-- 개인 자료 대신 서버 표에 함께 둔다. 그 반 담임·관리자는 넣고 고치고, "학년 전체 보기"(teachers.trip_viewer, 3학년 부장)는 보기만.
-- 질병·인정·기타결석은 그대로 개인 자료(user_data_items, 본인만)라 바뀌는 것이 없다.

alter table public.teachers add column if not exists trip_viewer boolean not null default false;

create or replace function public.is_trip_viewer()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select trip_viewer from public.teachers where id = auth.uid()), false)
$$;

create or replace function public.is_homeroom_of(p_grade smallint, p_class smallint)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.teachers where id = auth.uid() and role = '담임' and homeroom_grade = p_grade and homeroom_class = p_class)
$$;

-- 관리자 설정 trip_board = { "grades": [3], "periods": { "3": [{ "from": "2026-12-01", "to": "2026-12-11" }, …] } }
create or replace function public.trip_grades()
returns smallint[] language sql stable security definer set search_path to 'public' as $$
  select coalesce((select array(select (jsonb_array_elements_text(value->'grades'))::smallint) from public.app_settings where key = 'trip_board'), '{}'::smallint[])
$$;

create or replace function public.trip_can_see(p_grade smallint, p_class smallint)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.is_admin() or public.is_homeroom_of(p_grade, p_class) or (public.is_trip_viewer() and p_grade = any(public.trip_grades()))
$$;

create or replace function public.trip_can_edit(p_grade smallint, p_class smallint)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select public.is_admin() or public.is_homeroom_of(p_grade, p_class)
$$;

-- 교외체험학습 기록(결석계 기록과 같은 모양). id는 결석계 기록 id 그대로(개인 자료에서 옮겨도 같은 id).
create table if not exists public.trip_records (
  id text primary key,
  grade smallint not null,
  class_no smallint not null,
  num smallint not null,
  name text not null default '',
  from_date date not null,
  to_date date not null,
  days smallint,                       -- 직접 고친 일수(null이면 토·일·휴일 빼고 자동)
  written date,
  detail text not null default '',
  proof text not null default '',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.trip_records enable row level security;
drop policy if exists "볼 수 있는 사람 읽기" on public.trip_records;
create policy "볼 수 있는 사람 읽기" on public.trip_records for select to authenticated using (public.trip_can_see(grade, class_no));
drop policy if exists "그 반 담임·관리자 등록" on public.trip_records;
create policy "그 반 담임·관리자 등록" on public.trip_records for insert to authenticated with check (public.trip_can_edit(grade, class_no));
drop policy if exists "그 반 담임·관리자 고치기" on public.trip_records;
create policy "그 반 담임·관리자 고치기" on public.trip_records for update to authenticated using (public.trip_can_edit(grade, class_no)) with check (public.trip_can_edit(grade, class_no));
drop policy if exists "그 반 담임·관리자 지우기" on public.trip_records;
create policy "그 반 담임·관리자 지우기" on public.trip_records for delete to authenticated using (public.trip_can_edit(grade, class_no));
create index if not exists trip_records_class on public.trip_records (grade, class_no, from_date);

-- 직접 적은 "기존사용" 일수(결석계에 안 넣은 과거 사용분 보정). 표시되는 기존 = 올해 기록 자동 합 + 이 값.
create table if not exists public.trip_prior (
  grade smallint not null,
  class_no smallint not null,
  num smallint not null,
  days smallint not null default 0,
  memo text not null default '',
  updated_by uuid default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (grade, class_no, num)
);
alter table public.trip_prior enable row level security;
drop policy if exists "볼 수 있는 사람 읽기" on public.trip_prior;
create policy "볼 수 있는 사람 읽기" on public.trip_prior for select to authenticated using (public.trip_can_see(grade, class_no));
drop policy if exists "그 반 담임·관리자 등록" on public.trip_prior;
create policy "그 반 담임·관리자 등록" on public.trip_prior for insert to authenticated with check (public.trip_can_edit(grade, class_no));
drop policy if exists "그 반 담임·관리자 고치기" on public.trip_prior;
create policy "그 반 담임·관리자 고치기" on public.trip_prior for update to authenticated using (public.trip_can_edit(grade, class_no)) with check (public.trip_can_edit(grade, class_no));
drop policy if exists "그 반 담임·관리자 지우기" on public.trip_prior;
create policy "그 반 담임·관리자 지우기" on public.trip_prior for delete to authenticated using (public.trip_can_edit(grade, class_no));

-- 학년 공통 휴일(학교 지정 체험학습일 등): 계정마다 다른 "직접 더한 휴일" 대신 이걸로 세어 모두 같은 일수가 나오게.
create table if not exists public.trip_holidays (
  grade smallint not null,
  day date not null,
  name text not null default '휴일',
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (grade, day)
);
alter table public.trip_holidays enable row level security;
drop policy if exists "로그인한 사람 읽기" on public.trip_holidays;
create policy "로그인한 사람 읽기" on public.trip_holidays for select to authenticated using (true);
drop policy if exists "그 학년 담임·관리자 등록" on public.trip_holidays;
create policy "그 학년 담임·관리자 등록" on public.trip_holidays for insert to authenticated
  with check (public.is_admin() or exists (select 1 from public.teachers where id = auth.uid() and role = '담임' and homeroom_grade = trip_holidays.grade));
drop policy if exists "그 학년 담임·관리자 지우기" on public.trip_holidays;
create policy "그 학년 담임·관리자 지우기" on public.trip_holidays for delete to authenticated
  using (public.is_admin() or exists (select 1 from public.teachers where id = auth.uid() and role = '담임' and homeroom_grade = trip_holidays.grade));

-- 관리자: "학년 전체 보기" 체크(보기만)
create or replace function public.admin_set_trip_viewer(p_teacher_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.assert_admin();
  update public.teachers set trip_viewer = coalesce(p_on, false) where id = p_teacher_id;
  if not found then raise exception '그런 계정이 없습니다'; end if;
end;
$$;
revoke execute on function public.admin_set_trip_viewer(uuid, boolean) from anon;

-- 담임이 넣으면 부장·관리자 화면에 바로 보이게(실시간)
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'trip_records') then
    alter publication supabase_realtime add table public.trip_records;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'trip_prior') then
    alter publication supabase_realtime add table public.trip_prior;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'trip_holidays') then
    alter publication supabase_realtime add table public.trip_holidays;
  end if;
end $$;
