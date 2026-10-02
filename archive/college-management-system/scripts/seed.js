// Adds sample data so you can explore the system. Safe to run once on a fresh install.
//   npm run seed
const { db, hashPassword } = require('../src/db');

if (db.prepare('SELECT COUNT(*) n FROM students').get().n > 0) {
  console.log('Students already exist – skipping demo data.');
  process.exit(0);
}

const ins = (table, row) => {
  const k = Object.keys(row);
  return db.prepare(`INSERT INTO ${table} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => row[x])).lastInsertRowid;
};

db.transaction(() => {
  const depts = [
    ['CS', 'Computer Science'], ['BUS', 'Business Studies'], ['ENG', 'Engineering'], ['HSC', 'Health Sciences']
  ].map(([code, name]) => ins('departments', { code, name, email: `${code.toLowerCase()}@college.edu` }));

  const tNames = [['Grace', 'Wanjiru'], ['Peter', 'Otieno'], ['Amina', 'Hassan'], ['John', 'Mwangi'], ['Mary', 'Achieng']];
  const teachers = tNames.map(([f, l], i) => ins('teachers', {
    staff_no: `STF${String(i + 1).padStart(3, '0')}`, first_name: f, last_name: l, email: `${f.toLowerCase()}.${l.toLowerCase()}@college.edu`,
    phone: `07${String(10000000 + i * 1234567).slice(0, 8)}`, department_id: depts[i % depts.length], designation: i === 0 ? 'Senior Lecturer' : 'Lecturer',
    status: 'Active', hire_date: `20${15 + i}-01-10`, gender: i % 2 ? 'Male' : 'Female'
  }));
  depts.forEach((d, i) => db.prepare('UPDATE departments SET head_id = ? WHERE id = ?').run(teachers[i], d));

  const courses = [
    ['CS101', 'Introduction to Programming', 0], ['CS201', 'Data Structures', 0], ['BUS101', 'Principles of Accounting', 1],
    ['ENG110', 'Engineering Mathematics', 2], ['HSC120', 'Human Anatomy', 3]
  ].map(([code, title, d], i) => ins('courses', { code, title, department_id: depts[d], teacher_id: teachers[i % teachers.length], credits: 3, semester: '1' }));

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  courses.forEach((c, i) => ins('timetable', { course_id: c, day: days[i], start_time: '08:00', end_time: '10:00', room: `LH${i + 1}` }));

  const first = ['Brian', 'Faith', 'Kevin', 'Joy', 'Dennis', 'Mercy', 'Collins', 'Sharon', 'Ian', 'Lucy', 'Victor', 'Esther'];
  const last = ['Kamau', 'Njeri', 'Omondi', 'Chebet', 'Kiprop', 'Atieno', 'Mutua', 'Wambui', 'Onyango', 'Nduta', 'Kibet', 'Moraa'];
  const students = first.map((f, i) => ins('students', {
    reg_no: `TC/2026/${String(i + 1).padStart(3, '0')}`, first_name: f, last_name: last[i], email: `${f.toLowerCase()}@student.college.edu`,
    gender: i % 2 ? 'Female' : 'Male', department_id: depts[i % depts.length], program: 'Diploma', year_of_study: String((i % 3) + 1),
    admission_date: '2026-01-12', status: i === 11 ? 'Deferred' : 'Active'
  }));

  const statuses = ['Present', 'Present', 'Present', 'Late', 'Absent'];
  students.forEach((s, i) => {
    const c = courses[i % courses.length];
    ins('enrollments', { student_id: s, course_id: c, academic_year: '2026/2027', status: 'Enrolled' });
    for (let d = 1; d <= 5; d++) ins('attendance', { student_id: s, course_id: c, date: `2026-09-0${d}`, status: statuses[(i + d) % statuses.length] });
    const score = 45 + ((i * 7) % 50);
    ins('grades', { student_id: s, course_id: c, assessment: 'CAT 1', term: 'Sem 1 2026', score, max_score: 100, grade: score >= 70 ? 'A' : score >= 60 ? 'B' : score >= 50 ? 'C' : 'D' });
    const paid = [45000, 20000, 0][i % 3];
    ins('fees', { student_id: s, description: 'Tuition – Semester 1', amount: 45000, paid, due_date: '2026-10-01', status: paid >= 45000 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid' });
  });

  ins('notices', { title: 'Welcome to the new semester', audience: 'Everyone', publish_date: '2026-09-01', pinned: 1, body: 'Classes begin on Monday. Please check your timetable.' });
  ins('notices', { title: 'Staff meeting', audience: 'Staff', publish_date: '2026-09-05', pinned: 0, body: 'All staff meet in the boardroom at 2pm on Friday.' });
  ins('notices', { title: 'Fee deadline', audience: 'Students', publish_date: '2026-09-10', pinned: 0, body: 'Semester 1 fees are due by 1st October.' });

  const pw = hashPassword('password123');
  ins('users', { name: 'College Admin', email: 'admin@college.edu', role: 'admin', password: pw, active: 1 });
  ins('users', { name: 'Grace Wanjiru', email: 'teacher@college.edu', role: 'teacher', password: pw, teacher_id: teachers[0], active: 1 });
  ins('users', { name: 'Brian Kamau', email: 'student@college.edu', role: 'student', password: pw, student_id: students[0], active: 1 });
})();

console.log('Demo data added. Extra logins (password: password123):');
console.log('  admin@college.edu   teacher@college.edu   student@college.edu');
