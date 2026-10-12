-- Internal maintenance alert (not guest-facing): approved.
-- Guest/management templates are DRAFTS (approved = 0) for the owner to review and replace.
-- The welcome template is NOT seeded: paste the existing saved template via PUT /admin/templates/welcome.

INSERT INTO email_templates (name, subject, html, text, approved, updated_at) VALUES
('maintenance_alert',
 'Little Slate House booking system: {{issue_count}} issue(s) on {{date}}',
 '<p>Daily maintenance check for {{date}} found:</p><pre>{{issues}}</pre>',
 'Daily maintenance check for {{date}} found:

{{issues}}
',
 1, '2026-10-11T00:00:00Z'),
('confirmation',
 'DRAFT Booking confirmed: Little Slate House, {{arrival_date}}',
 '<p>Dear {{guest_name}},</p><p>DRAFT: owner to supply wording. Booking {{booking_id}}: {{arrival_date}} to {{departure_date}} ({{nights}} nights), {{party_size}} guests. Paid: {{amount}}.</p>',
 'Dear {{guest_name}},

DRAFT: owner to supply wording. Booking {{booking_id}}: {{arrival_date}} to {{departure_date}} ({{nights}} nights), {{party_size}} guests. Paid: {{amount}}.
',
 0, '2026-10-11T00:00:00Z'),
('management_new_booking',
 'New confirmed booking {{booking_id}}: {{arrival_date}} to {{departure_date}}',
 '<p>New confirmed booking for Little Slate House.</p><ul><li>Booking: {{booking_id}}</li><li>Guest: {{guest_name}}</li><li>Arrive: {{arrival_date}} (3pm)</li><li>Depart: {{departure_date}}</li><li>Nights: {{nights}}</li><li>Party size: {{party_size}}</li></ul>',
 'New confirmed booking for Little Slate House.

Booking: {{booking_id}}
Guest: {{guest_name}}
Arrive: {{arrival_date}} (3pm)
Depart: {{departure_date}}
Nights: {{nights}}
Party size: {{party_size}}
',
 0, '2026-10-11T00:00:00Z'),
('owner_authorization',
 'Action needed: card authorised for {{booking_id}} ({{arrival_date}} to {{departure_date}})',
 '<p>A guest has authorised payment of {{amount}} for {{booking_id}}: {{arrival_date}} to {{departure_date}} ({{nights}} nights, {{party_size}} guests). Nothing has been charged yet.</p><p>Next step: {{next_step}}</p><p>Once Travel Chapter shows the dates as blocked (or you have confirmed with them), confirm the booking to capture payment. Card authorisations usually lapse after 7 days.</p>',
 'A guest has authorised payment of {{amount}} for {{booking_id}}: {{arrival_date}} to {{departure_date}} ({{nights}} nights, {{party_size}} guests). Nothing has been charged yet.

Next step: {{next_step}}

Once Travel Chapter shows the dates as blocked (or you have confirmed with them), confirm the booking to capture payment. Card authorisations usually lapse after 7 days.
',
 1, '2026-10-11T00:00:00Z'),
('authorization_received',
 'DRAFT Payment authorised: Little Slate House, {{arrival_date}}',
 '<p>Dear {{guest_name}},</p><p>DRAFT: owner to supply wording. We have received your payment authorisation for {{arrival_date}} to {{departure_date}}. Your card will be charged once we confirm the dates.</p>',
 'Dear {{guest_name}},

DRAFT: owner to supply wording. We have received your payment authorisation for {{arrival_date}} to {{departure_date}}. Your card will be charged once we confirm the dates.
',
 0, '2026-10-11T00:00:00Z'),
('management_cancellation',
 'DRAFT Booking released: {{booking_id}} ({{arrival_date}} to {{departure_date}})',
 '<p>DRAFT: owner to supply wording. Booking {{booking_id}} for {{arrival_date}} to {{departure_date}} has been cancelled and the dates released after coordination with Travel Chapter. Please cancel any cleaning scheduled for this stay.</p>',
 'DRAFT: owner to supply wording. Booking {{booking_id}} for {{arrival_date}} to {{departure_date}} has been cancelled and the dates released after coordination with Travel Chapter. Please cancel any cleaning scheduled for this stay.
',
 0, '2026-10-11T00:00:00Z');
