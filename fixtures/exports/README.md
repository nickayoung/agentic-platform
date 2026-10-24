# Payroll export fixtures (Gusto CSV, spec §18.8)

`gusto_employees.example.csv` illustrates the employee file Kairos produces for one biweekly pay period
(2027-03-01 → 2027-03-14) using the **placeholder** headers in `docs/spec/04b-example-configs.md`
(`tenant.payroll_export`). Real headers and the workweek cell format must be copied from the tenant's own
Gusto CSV template at onboarding (Q-14); the golden-file tests regenerate this file from fixed hours records.

Row meaning (with `split_by_kind: true` and `job_names`): Priya's first row is her "Front Desk" hours and her second her "Yoga Teacher" hours
for the same workweek. She worked 42.25 h that week; the last 2.25 h in time order were teaching, so they are
classified as overtime on the teaching row. The `bonus` and `reimbursement` columns are not owned by Kairos and stay
blank, so a re-upload never changes values entered in Gusto.
