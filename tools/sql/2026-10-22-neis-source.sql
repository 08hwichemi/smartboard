-- 나이스에서 가져온 기록 표시(10/22): 매일 나이스 변경수업에 맞출 때(바뀐 것·취소된 것) 확장 프로그램이 가져온 기록만 고치고,
-- 수업변경 담당이 손으로 넣은 기록은 건드리지 않으려고. 비어 있으면(null) 손으로 넣은 것.
alter table public.schedule_changes add column if not exists source text;
alter table public.schedule_cell_changes add column if not exists source text;
-- 10/22 시험으로 가져온 것(이용휘, 16:31)에 표시
update public.schedule_changes set source = 'neis' where created_by = '이용휘' and created_at >= '2026-10-22 07:30:00+00' and created_at < '2026-10-22 07:33:00+00' and source is null;
update public.schedule_cell_changes set source = 'neis' where source is null;
