-- 스마트보드 Supabase(pqreeimkjnphupqqwiqo) — 무료 요금제 안에서 50명 내외가 쓰도록 (2026-10-03)
-- Supabase 대시보드 → SQL Editor에 통째로 붙여 넣고 Run. (Claude의 apply_migration이 지우기 명령이 든 변경에서 계속 시간 초과돼서 손으로 실행)
-- 이미 적용된 것: is_device_local_key()에 'search-tt-%' 추가(마이그레이션 device_local_key_search_tt).
-- 지금 운영 중인 화면(main)과 같이 써도 안전한 변경만 있음.

begin;

-- 1) 변경 이력: 같은 칸이 2분 안에 또 바뀌면 남기지 않음(설정 클릭·연달아 저장은 첫 값만),
--    기기 전용 키(search-tt- 등)는 안 남김, 보관 14일(예전 30일).
--    10/3 실제 이력으로 계산: 양식 설정 609KB→101KB, 수행평가 163KB→24KB, 이름표 145KB→14KB(세특 같은 실제 글은 거의 그대로).
create or replace function public.user_data_items_record_history()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if old.value is not distinct from new.value or public.is_device_local_key(old.key) then
    return new;
  end if;
  if old.value is not null
     and exists (select 1 from public.user_data_history h
                 where h.teacher_id = old.teacher_id and h.key = old.key
                   and h.changed_at > clock_timestamp() - interval '2 minutes') then
    return new;
  end if;
  insert into public.user_data_history (teacher_id, key, old_value)
  values (old.teacher_id, old.key, old.value);
  delete from public.user_data_history
   where teacher_id = old.teacher_id and changed_at < clock_timestamp() - interval '14 days';
  return new;
end;
$function$;

-- 2) 다른 선생님 시간표 찾기 칸(search-tt-) — 볼 때마다 70칸을 저장하던 화면 값. 이제 기기 전용이라 서버 줄·이력 지움.
--    (10/3: 줄 1,191개, 이력 4,406개 — 이력 줄 수 1위)
delete from public.user_data_history where public.is_device_local_key(key);
delete from public.user_data_items where public.is_device_local_key(key);

-- 3) 9/29 항목별 저장(user_data_items)으로 바꾸기 전의 옛 표 — 9/29 09:33 이후 쓰기 없음, 앱 코드에서 안 씀.
alter publication supabase_realtime drop table public.user_backups;
drop function if exists public.merge_user_backup(jsonb, text[]);
drop table if exists public.user_backups_snapshot_20260929;
drop table if exists public.user_backups;

commit;

-- 확인(모두 true / 0 이면 됨)
select
  pg_get_functiondef('public.user_data_items_record_history'::regproc) like '%14 days%' as history_rule_ok,
  to_regclass('public.user_backups') is null as legacy_dropped,
  (select count(*) from public.user_data_items where key like 'search-tt-%') as search_rows_left,
  pg_size_pretty(pg_database_size(current_database())) as db_size;
