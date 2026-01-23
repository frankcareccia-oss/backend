SELECT m."name", count(*) AS stores
FROM "Store" s
JOIN "Merchant" m ON m."id" = s."merchantId"
GROUP BY m."name"
ORDER BY m."name";

SELECT count(*) AS consumers FROM "Consumer";

SELECT count(*) AS phone_rows,
       sum(CASE WHEN "isPrimary" THEN 1 ELSE 0 END) AS primary_phones
FROM "ConsumerPhone";

SELECT c."email", cp."phoneE164", cp."isPrimary", cp."status"
FROM "Consumer" c
JOIN "ConsumerPhone" cp ON cp."consumerId" = c."id"
WHERE c."email" IN ('c03@example.com','c07@example.com')
ORDER BY c."email", cp."createdAt";

SELECT count(*) AS visits FROM "Visit";

SELECT c."email", count(*) AS primary_count
FROM "Consumer" c
JOIN "ConsumerPhone" cp ON cp."consumerId" = c."id"
WHERE cp."isPrimary" = true
GROUP BY c."email"
HAVING count(*) <> 1
ORDER BY c."email";
