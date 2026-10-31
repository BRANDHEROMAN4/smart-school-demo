update schools
set name = 'ابتدائية صلاح الدين الأيوبي'
where code = 'EDUVIA-NOUR'
   or lower(trim(name)) in ('ابتدائية النور', 'ابتدائية النور (بنات)');
