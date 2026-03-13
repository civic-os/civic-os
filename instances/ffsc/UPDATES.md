Updates to make to the FFSC instance following the 2026-03-12 meeting:

- [x] Rename 'editor' role to 'Site Coordinator', 'user' to 'Seasonal Staff', and add a 'Bookkeeper' role *(scripts 12+13)*
- [ ] Troubleshoot the Welcome email not working
- [ ] Troubleshoot S3 config (upload doesn't work)
- [x] Keep users logged in for up to 3 months *(manual Keycloak config)*
- [x] Incident Reports: automatically default "Reported By" and don't show on create, Add Incident Report to dashboard, Add Status (New, Reviewed, Closed) *(script 14)*
- [x] Add Reimbursement notifications to Bookkeeper role *(script 14)*
- [x] Add Staff Directory View that allows any logged in user to see any user's Name, Email, Phone, Role(s), and Site(s) *(script 14)*
- [x] Tell Pilot story on Anonymous welcome page *(script 14)*
- [x] Staff Tasks: color-coded priority (High, Medium, Low) and assign by site, role, or staff member *(script 14)*
- [x] Bookkeeper permissions: read reimbursements, time entries, staff, sites; update reimbursements *(script 14)*
- [x] Bookkeeper RLS: see all reimbursements and time entries *(script 14)*
- [x] Role delegation: admin and manager can assign Bookkeeper *(script 14)*


Also build:
- [ ] File Admin (with filtering by entity properties)
- [x] Default Dashboard by Role *(v0.37.0 migration + script 14)*
- [ ] Static Assets (and responsive images) feature to support Markdown pages
- [x] Allow hiding Title on dashboards *(v0.37.0 migration)*
- [x] Fix managed_users VIEW to show display_name instead of role_key *(v0.36.0 patch)*
