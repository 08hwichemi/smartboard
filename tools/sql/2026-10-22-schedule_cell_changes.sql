-- 나이스 변경수업 "칸 그대로" 기록(10/22): 짝이 나이스 표에 안 보이는 교체(시수 맞추려 다른 요일 수업을 당겨 하는 날 등)를
-- 나이스 표에 적힌 그대로 "이 날 이 교시 이 반은 ○○ 선생님 ○○ 과목"으로 담는다. 권한은 schedule_changes와 같다.
create table if not exists public.schedule_cell_changes (
  id bigserial primary key,
  change_date date not null,
  period smallint not null check (period between 1 and 7),
  room text not null,
  teacher_from text not null default '',
  teacher_to text not null,
  subject text not null default '',
  created_by text not null default my_teacher_name(),
  created_at timestamptz not null default now()
);
alter table public.schedule_cell_changes enable row level security;
create policy "로그인한 사람 읽기" on public.schedule_cell_changes for select to authenticated using (true);
create policy "로그인한 사람 등록" on public.schedule_cell_changes for insert to authenticated with check (true);
create policy "관리자·수업변경 담당·작성자만 삭제" on public.schedule_cell_changes for delete to authenticated
  using (is_admin() or is_schedule_manager() or created_by = my_teacher_name());
create index if not exists schedule_cell_changes_date on public.schedule_cell_changes (change_date);
