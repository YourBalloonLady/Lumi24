insert into public."Products" (name, type, price, stock, image, description)
select
  'Semaglutide 30mg Vial',
  'semaglutide',
  100.00,
  5,
  'https://qketnqhfjfxbqiuqevnh.supabase.co/storage/v1/object/public/product-images/WhatsApp%20Image%202026-08-14%20at%2000.37.04%20(1).jpeg',
  E'Semaglutide is a GLP-1 receptor agonist peptide commonly studied in laboratory models of metabolic regulation and glucose metabolism. Research often focuses on its role in insulin signalling pathways and appetite-related hormonal responses.\n\nSupplied for laboratory research purposes.'
where not exists (
  select 1 from public."Products"
  where lower(name) = lower('Semaglutide 30mg Vial')
);

insert into public."Products" (name, type, price, stock, image, description)
select
  'Semaglutide 30mg Pen',
  'semaglutide',
  100.00,
  5,
  'https://qketnqhfjfxbqiuqevnh.supabase.co/storage/v1/object/public/product-images/WhatsApp%20Image%202026-08-14%20at%2000.37.04.jpeg',
  E'Semaglutide is a GLP-1 receptor agonist peptide commonly studied in laboratory models of metabolic regulation and glucose metabolism. Research often focuses on its role in insulin signalling pathways and appetite-related hormonal responses.\n\nSupplied for laboratory research purposes.'
where not exists (
  select 1 from public."Products"
  where lower(name) = lower('Semaglutide 30mg Pen')
);
