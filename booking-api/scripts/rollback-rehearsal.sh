#!/usr/bin/env bash
# Rehearses the D1 backup/restore rollback using wrangler's LOCAL D1 (no Cloudflare account needed).
# Same commands work against the real database by swapping --local for --remote.
set -euo pipefail
cd "$(dirname "$0")/.."
STATE=$(mktemp -d)   # holds the backup file
rm -rf .wrangler/state   # local-only D1 state (gitignored)
DB=lsh-booking-test
W="npx wrangler --env test"
q() { $W d1 execute $DB --local --json --command "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))'; }

echo "1. apply migrations"
$W d1 migrations apply $DB --local >/dev/null 2>&1
echo "2. seed a fictional confirmed booking"
$W d1 execute $DB --local --command "INSERT INTO bookings (id,guest_name,guest_surname,guest_email,party_size,arrival,departure,nights,amount_pence,status,source,created_at,updated_at) VALUES ('LSH-TEST-1','Test','Guest','guest@test.invalid',2,'2027-01-01','2027-01-03',2,1000,'confirmed','import','2026-10-11T00:00:00Z','2026-10-11T00:00:00Z')" >/dev/null 2>&1
BEFORE=$(q "SELECT id,status FROM bookings")
echo "   before: $BEFORE"
echo "3. backup (d1 export)"
$W d1 export $DB --local --output "$STATE/backup.sql" >/dev/null 2>&1
echo "4. simulate a bad change"
$W d1 execute $DB --local --command "UPDATE bookings SET status='cancelled'; DELETE FROM email_templates;" >/dev/null 2>&1
echo "   damaged: $(q "SELECT id,status FROM bookings")"
echo "5. restore: drop tables, re-import backup"
TABLES=$(q "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).map(r=>`DROP TABLE IF EXISTS "${r.name}";`).join(" ")))')
$W d1 execute $DB --local --command "PRAGMA foreign_keys=OFF; $TABLES" >/dev/null 2>&1
$W d1 execute $DB --local --file "$STATE/backup.sql" >/dev/null 2>&1
AFTER=$(q "SELECT id,status FROM bookings")
TPL=$(q "SELECT COUNT(*) AS n FROM email_templates")
echo "   after:  $AFTER  templates: $TPL"
rm -rf "$STATE" .wrangler/state
if [ "$BEFORE" = "$AFTER" ] && [ "$TPL" = '[{"n":3}]' ]; then echo "ROLLBACK REHEARSAL: PASS"; else echo "ROLLBACK REHEARSAL: FAIL"; exit 1; fi
