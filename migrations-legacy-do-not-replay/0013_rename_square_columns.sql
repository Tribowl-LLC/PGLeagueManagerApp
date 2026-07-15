ALTER TABLE "bowlers" RENAME COLUMN "square_customer_id" TO "payment_customer_id";
ALTER TABLE "payment_schedules" RENAME COLUMN "square_card_id" TO "payment_card_id";
ALTER TABLE "payments" RENAME COLUMN "square_payment_id" TO "provider_payment_id";
ALTER TABLE "leagues" RENAME COLUMN "square_lineage_item_variation_id" TO "lineage_item_variation_id";
ALTER TABLE "leagues" RENAME COLUMN "square_prize_fund_item_variation_id" TO "prize_fund_item_variation_id";
