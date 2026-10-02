// End-to-end API smoke test against a throwaway database.
//   npm test
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.SUPERADMIN_EMAIL = 'root@test.edu';
process.env.SUPERADMIN_PASSWORD = 'rootpass';
const origLog = console.log;
console.log = () => {};
const app = require('../server');
console.log = origLog;

function client(base) {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const su = client(base);
  let r;
  let passed = 0;
  const step = (name, fn) => fn().then(() => { passed++; console.log('  ✔', name); });

  try {
    await step('rejects wrong password', async () => {
      r = await su('POST', '/api/login', { email: 'root@test.edu', password: 'nope' });
      assert.strictEqual(r.status, 401);
    });
    await step('super admin logs in', async () => {
      r = await su('POST', '/api/login', { email: 'root@test.edu', password: 'rootpass' });
      assert.strictEqual(r.status, 200); assert.strictEqual(r.data.user.role, 'super_admin');
    });
    await step('edits branding and uploads a logo', async () => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      r = await su('POST', '/api/upload', { dataUrl: png });
      assert.strictEqual(r.status, 200);
      r = await su('PUT', '/api/settings', { college_name: 'Test Uni', logo: r.data.url, primary_color: '#ff0000' });
      assert.strictEqual(r.data.college_name, 'Test Uni');
      assert.ok(r.data.logo.startsWith('/uploads/'));
      const img = await fetch(base + r.data.logo);
      assert.strictEqual(img.status, 200);
    });
    let dept, student, course;
    await step('creates department, student, course', async () => {
      r = await su('POST', '/api/data/departments', { code: 'CS', name: 'Computer Science' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data)); dept = r.data.row.id;
      r = await su('POST', '/api/data/students', { reg_no: 'S1', first_name: 'Ann', last_name: 'Lee', department_id: dept });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data)); student = r.data.row.id;
      assert.strictEqual(r.data.row.status, 'Active');
      r = await su('POST', '/api/data/courses', { code: 'CS101', title: 'Programming', department_id: dept });
      course = r.data.row.id;
    });
    await step('enforces required + unique fields', async () => {
      r = await su('POST', '/api/data/students', { reg_no: 's1', first_name: 'X', last_name: 'Y' });
      assert.strictEqual(r.status, 409);
      r = await su('POST', '/api/data/students', { reg_no: 'S9' });
      assert.strictEqual(r.status, 400);
    });
    await step('auto computes fee status and grade', async () => {
      r = await su('POST', '/api/data/fees', { student_id: student, description: 'Tuition', amount: 100, paid: 40 });
      assert.strictEqual(r.data.row.status, 'Partial');
      r = await su('PUT', `/api/data/fees/${r.data.row.id}`, { paid: 100 });
      assert.strictEqual(r.data.row.status, 'Paid');
      r = await su('POST', '/api/data/grades', { student_id: student, course_id: course, score: 65, max_score: 100 });
      assert.strictEqual(r.data.row.grade, 'B');
    });
    await step('custom fields are stored and returned', async () => {
      r = await su('POST', '/api/custom-fields', { entity: 'students', label: 'Blood Group', type: 'select', options: 'A,B,O', list: true });
      assert.strictEqual(r.status, 200);
      r = await su('PUT', `/api/data/students/${student}`, { x_blood_group: 'O' });
      assert.strictEqual(r.data.row.x_blood_group, 'O');
      r = await su('GET', '/api/data/students?q=Ann');
      assert.strictEqual(r.data.total, 1); assert.strictEqual(r.data.rows[0].x_blood_group, 'O');
    });
    await step('search finds records through linked names', async () => {
      r = await su('GET', '/api/data/grades?q=Ann');
      assert.strictEqual(r.data.total, 1);
      assert.ok(r.data.labels.student_id[student].includes('Ann'));
    });
    await step('renames and hides a module', async () => {
      r = await su('PUT', '/api/settings', { modules: JSON.stringify({ timetable: { label: 'Class Schedule', hidden: true } }) });
      r = await su('GET', '/api/meta');
      assert.strictEqual(r.data.entities.timetable.label, 'Class Schedule');
      assert.strictEqual(r.data.entities.timetable.hidden, true);
    });
    const stu = client(base);
    await step('student sees only their own records', async () => {
      r = await su('POST', '/api/data/students', { reg_no: 'S2', first_name: 'Bob', last_name: 'Ray' });
      await su('POST', '/api/data/fees', { student_id: r.data.row.id, description: 'Other', amount: 5 });
      r = await su('POST', '/api/data/users', { name: 'Ann Lee', email: 'ann@test.edu', role: 'student', password: 'secret1', student_id: student });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      assert.strictEqual(r.data.row.password, undefined);
      r = await stu('POST', '/api/login', { email: 'ann@test.edu', password: 'secret1' });
      assert.strictEqual(r.status, 200);
      r = await stu('GET', '/api/data/fees');
      assert.strictEqual(r.data.total, 1);
      r = await stu('GET', '/api/data/students');
      assert.strictEqual(r.data.total, 1);
      r = await stu('GET', '/api/meta');
      assert.ok(!r.data.entities.timetable, 'hidden module should not be visible');
      assert.ok(!r.data.entities.users);
    });
    await step('student cannot write or use super admin tools', async () => {
      r = await stu('POST', '/api/data/students', { reg_no: 'H', first_name: 'H', last_name: 'H' });
      assert.strictEqual(r.status, 403);
      r = await stu('PUT', '/api/settings', { college_name: 'hacked' });
      assert.strictEqual(r.status, 403);
      r = await stu('GET', '/api/backup');
      assert.strictEqual(r.status, 403);
    });
    await step('admin cannot touch the super admin', async () => {
      await su('POST', '/api/data/users', { name: 'Adm', email: 'adm@test.edu', role: 'admin', password: 'secret1' });
      const adm = client(base);
      await adm('POST', '/api/login', { email: 'adm@test.edu', password: 'secret1' });
      r = await adm('PUT', '/api/data/users/1', { name: 'pwned' });
      assert.strictEqual(r.status, 403);
      r = await adm('POST', '/api/data/users', { name: 'X', email: 'x@test.edu', role: 'super_admin', password: 'secret1' });
      assert.strictEqual(r.status, 403);
      r = await adm('DELETE', '/api/data/users/1');
      assert.strictEqual(r.status, 403);
    });
    await step('super admin cannot delete themself or the last super admin', async () => {
      r = await su('DELETE', '/api/data/users/1');
      assert.strictEqual(r.status, 400);
    });
    await step('deleting a student cascades to their records', async () => {
      r = await su('DELETE', `/api/data/students/${student}`);
      assert.strictEqual(r.status, 200); assert.ok(r.data.cascaded >= 2);
      r = await su('GET', '/api/data/grades');
      assert.strictEqual(r.data.total, 0);
      r = await su('GET', '/api/data/users?q=ann');
      assert.strictEqual(r.data.rows[0].student_id, null);
    });
    await step('backup, wipe and restore', async () => {
      const backup = (await su('GET', '/api/backup')).data;
      assert.ok(backup.tables.students.length >= 1);
      r = await su('POST', '/api/data/students/wipe');
      assert.ok(r.data.deleted >= 1);
      r = await su('POST', '/api/restore', backup);
      assert.strictEqual(r.status, 200);
      r = await su('GET', '/api/data/students');
      assert.strictEqual(r.data.total, backup.tables.students.length);
    });
    await step('audit log records actions', async () => {
      r = await su('GET', '/api/audit');
      assert.ok(r.data.total > 5);
    });
    await step('serves the web app', async () => {
      const res = await fetch(base + '/students/anything');
      assert.ok((await res.text()).includes('app.js'));
    });
    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('\n✘ FAILED:', e.message, r ? JSON.stringify(r.data).slice(0, 300) : '');
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
