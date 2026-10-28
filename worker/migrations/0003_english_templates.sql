-- Shared starter templates in English only.
INSERT INTO templates (site_id, name, subject, html, text, updated_at) VALUES
('*', 'login_code',
 'Your {{site_name}} sign-in code',
 '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111"><p>Your {{site_name}} sign-in code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0">{{code}}</p><p>This code expires in {{expires_minutes}} minutes.</p><p style="color:#666;font-size:13px">If you didn''t request this code, you can safely ignore this email.</p></div>',
 'Your {{site_name}} sign-in code is: {{code}}

This code expires in {{expires_minutes}} minutes.

If you didn''t request this code, you can safely ignore this email.',
 datetime('now')),
('*', 'password_reset',
 'Reset your {{site_name}} password',
 '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;padding:24px;color:#111"><p>We received a request to reset your {{site_name}} password.</p><p><a href="{{reset_url}}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">Reset password</a></p><p>Or paste this link into your browser:<br><a href="{{reset_url}}">{{reset_url}}</a></p><p>This link expires in {{expires_minutes}} minutes.</p><p style="color:#666;font-size:13px">If you didn''t request a password reset, you can safely ignore this email.</p></div>',
 'We received a request to reset your {{site_name}} password.

Reset it here (expires in {{expires_minutes}} minutes):
{{reset_url}}

If you didn''t request a password reset, you can safely ignore this email.',
 datetime('now'))
ON CONFLICT (site_id, name) DO UPDATE SET
  subject = excluded.subject, html = excluded.html, text = excluded.text, updated_at = excluded.updated_at;
