-- 나이스 바뀐 칸(schedule_cell_changes)이 들어오거나 빠지면 켜 둔 보드마다 바로 알려 주기(실시간) — 10/23 사용자.
-- 읽기 권한(로그인한 사람 읽기)은 그대로라, 알림도 로그인한 보드에만 간다. 하루 한두 번(아침 조회) 몇십 줄이라 사용량은 거의 없다.
alter publication supabase_realtime add table public.schedule_cell_changes;
