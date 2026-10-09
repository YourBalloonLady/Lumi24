-- Stop the old paid-order trigger from awarding referral credit.
-- Existing customer balances, referral codes, and past order rows stay as they are.

drop trigger if exists trg_award_referrer_on_paid on public."Orders";
