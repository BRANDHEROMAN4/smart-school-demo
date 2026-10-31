alter table guardians_subscription add column if not exists plan_name text;

update guardians_subscription
set plan_name = case
  when amount_dzd = 300 then 'الاشتراك الشهري'
  when amount_dzd = 750 then 'الاشتراك الثلاثي'
  when amount_dzd = 2500 then 'الاشتراك السنوي'
  else plan_name
end
where plan_name is null;
