-- Internal maintenance alert (not guest-facing): approved.
-- Guest/management templates are DRAFTS (approved = 0) for the owner to review and replace.
-- The welcome template is NOT seeded: paste the existing saved template via PUT /admin/templates/welcome.

INSERT INTO email_templates (name, subject, html, text, approved, updated_at) VALUES
('maintenance_alert',
 'Little Slate House booking system: {{issue_count}} issue(s) on {{date}}',
 '<p>Daily maintenance check for {{date}} found:</p><pre>{{issues}}</pre>',
 'Daily maintenance check for {{date}} found:\n\n{{issues}}\n',
 1, '2026-10-11T00:00:00Z'),
('confirmation',
 'DRAFT Booking confirmed: Little Slate House, {{arrival_date}}',
 '<p>Dear {{guest_name}},</p><p>DRAFT: owner to supply wording. Booking {{booking_id}}: {{arrival_date}} to {{departure_date}} ({{nights}} nights), {{party_size}} guests. Paid: {{amount}}.</p>',
 'Dear {{guest_name}},\n\nDRAFT: owner to supply wording. Booking {{booking_id}}: {{arrival_date}} to {{departure_date}} ({{nights}} nights), {{party_size}} guests. Paid: {{amount}}.\n',
 0, '2026-10-11T00:00:00Z'),
('management_new_booking',
 'New confirmed booking {{booking_id}}: {{arrival_date}} to {{departure_date}}',
 '<p>New confirmed booking for Little Slate House.</p><ul><li>Booking: {{booking_id}}</li><li>Guest: {{guest_name}}</li><li>Arrive: {{arrival_date}} (3pm)</li><li>Depart: {{departure_date}}</li><li>Nights: {{nights}}</li><li>Party size: {{party_size}}</li></ul>',
 'New confirmed booking for Little Slate House.\n\nBooking: {{booking_id}}\nGuest: {{guest_name}}\nArrive: {{arrival_date}} (3pm)\nDepart: {{departure_date}}\nNights: {{nights}}\nParty size: {{party_size}}\n',
 0, '2026-10-11T00:00:00Z');
