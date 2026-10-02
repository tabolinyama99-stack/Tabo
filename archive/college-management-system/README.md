# College Management System

A complete, self-hosted college management system with a **Super Admin** who can change anything: logo, colours, names, module labels, permissions, custom fields and every record, including deleting them.

## Features

| Area | What you get |
|---|---|
| **Academics** | Students, Teachers, Departments, Courses, Enrollments, Timetable |
| **Records** | Attendance, Grades (letter grade calculated from your grading scale), Fees (status updates automatically: Unpaid / Partial / Paid) |
| **Communication** | Notices for Everyone, Students, Teachers or Staff, with pinning |
| **Users & roles** | Super Admin, Admin, Teacher, Student. A student login is linked to a student record and only shows that student's fees, grades and attendance |
| **Every list** | Search (including by linked names), sorting, pagination, view / add / edit / delete, bulk delete, CSV export, CSV import, print |
| **Dashboard** | Totals, fee collection, attendance breakdown, students by department, notices and recent activity |

### Super Admin powers
- **Branding & Logo**: upload the college logo, favicon and login background, and set the college name, tagline, colours, login message and footer.
- **Modules & Permissions**: rename any module or field, change its icon, hide it, and choose which roles can view or edit it.
- **Custom Fields**: add your own fields to any module (text, number, date, dropdown, yes/no, image, colour…).
- **General Settings**: contact details, academic year, currency and grading scale.
- **Backup & Danger Zone**: download a full backup, restore one, or delete every record in a module.
- **Audit Log**: see who created, edited, deleted or logged in, and when.
- **Delete anything**: deleting a record also deletes the records that belong to it (for example, deleting a student removes their fees, grades and attendance). The last super admin account is protected so you can't lock yourself out.

## Getting started

Requires **Node.js 18 or newer**.

```bash
npm install
npm run seed     # optional: adds demo departments, teachers, students, fees...
npm start
```

Open **http://localhost:3000** and sign in:

| Role | Email | Password |
|---|---|---|
| Super Admin | `superadmin@college.edu` | `admin123` |
| Admin (demo) | `admin@college.edu` | `password123` |
| Teacher (demo) | `teacher@college.edu` | `password123` |
| Student (demo) | `student@college.edu` | `password123` |

> **Change the super admin password right away** (click your name at the top right → *My Profile*).
> You can also set your own credentials before the first run:
> `SUPERADMIN_EMAIL=you@college.edu SUPERADMIN_PASSWORD=strongpass npm start`

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `DATA_DIR` | `./data` | Where the SQLite database (`college.db`) lives |
| `UPLOAD_DIR` | `./uploads` | Uploaded logos and photos |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | see above | Used only when no super admin exists yet |

Back up the `data/` and `uploads/` folders, or use *Backup & Danger Zone → Download backup*.

## Tests

```bash
npm test
```

This runs an end-to-end API check against a throwaway database. It covers login, branding and logo upload, CRUD, validation, custom fields, permissions, cascading deletes, and backup/restore.

## Project layout

```
server.js          Express API (auth, CRUD, settings, uploads, backup, audit)
src/schema.js      Module and field definitions – tables, API and forms are generated from this
src/db.js          SQLite setup, migrations, password hashing
public/            Single-page web app (no build step)
scripts/seed.js    Demo data
test/smoke.js      End-to-end API test
```

To add a built-in field, add it to `src/schema.js` and restart. The column is added to the database automatically.
