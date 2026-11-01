# Database migrations

When the database must change (a new column or table), add a file here named `NNNN_what_it_does.sql`, numbered after the
last one (the first is `0005_...`: everything up to v4 is already inside `schema.sql`).

Rules, so no church ever breaks:
1. **Additive only**: add tables/columns, do not rename or delete. The old code keeps working until the new code is deployed.
2. **Also update `schema.sql`** to the same final shape. New churches are created from `schema.sql` and have all existing migration files marked as done.
3. Push to GitHub: "2. Update all churches" applies each new file once to every church, then deploys. If a migration fails, that church is NOT redeployed.
