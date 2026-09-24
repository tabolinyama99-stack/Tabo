// Entity definitions. The database tables, the REST API and the admin UI
// are all generated from this file, so adding a field here is enough to
// make it appear everywhere.
//
// Field types: text, textarea, number, date, time, email, select, ref,
// boolean, image, password, color
//
// Roles: super_admin (can do everything), admin, teacher, student

const ROLES = ['super_admin', 'admin', 'teacher', 'student'];
const STAFF = ['admin', 'teacher'];
const EVERYONE = ['admin', 'teacher', 'student'];

const entities = {
  departments: {
    label: 'Departments', singular: 'Department', icon: '🏛️',
    display: ['code', 'name'],
    read: EVERYONE, write: ['admin'],
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, unique: true, list: true },
      { name: 'name', label: 'Name', type: 'text', required: true, list: true },
      { name: 'head_id', label: 'Head of Department', type: 'ref', ref: 'teachers', onDelete: 'null', list: true },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'email', label: 'Email', type: 'email', list: true },
      { name: 'description', label: 'Description', type: 'textarea' }
    ]
  },

  teachers: {
    label: 'Teachers', singular: 'Teacher', icon: '👩‍🏫',
    display: ['staff_no', 'first_name', 'last_name'],
    read: EVERYONE, write: ['admin'],
    fields: [
      { name: 'photo', label: 'Photo', type: 'image', list: true },
      { name: 'staff_no', label: 'Staff No.', type: 'text', required: true, unique: true, list: true },
      { name: 'first_name', label: 'First Name', type: 'text', required: true, list: true },
      { name: 'last_name', label: 'Last Name', type: 'text', required: true, list: true },
      { name: 'email', label: 'Email', type: 'email', list: true },
      { name: 'phone', label: 'Phone', type: 'text', list: true },
      { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'] },
      { name: 'department_id', label: 'Department', type: 'ref', ref: 'departments', onDelete: 'null', list: true },
      { name: 'designation', label: 'Designation', type: 'text', list: true },
      { name: 'qualification', label: 'Qualification', type: 'text' },
      { name: 'hire_date', label: 'Hire Date', type: 'date' },
      { name: 'salary', label: 'Salary', type: 'number', hideFrom: ['teacher', 'student'] },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'On Leave', 'Retired', 'Resigned'], default: 'Active', list: true },
      { name: 'address', label: 'Address', type: 'textarea' }
    ]
  },

  students: {
    label: 'Students', singular: 'Student', icon: '🎓',
    display: ['reg_no', 'first_name', 'last_name'],
    read: EVERYONE, write: ['admin'],
    scope: { student: 'id' },
    fields: [
      { name: 'photo', label: 'Photo', type: 'image', list: true },
      { name: 'reg_no', label: 'Reg. No.', type: 'text', required: true, unique: true, list: true },
      { name: 'first_name', label: 'First Name', type: 'text', required: true, list: true },
      { name: 'last_name', label: 'Last Name', type: 'text', required: true, list: true },
      { name: 'email', label: 'Email', type: 'email', list: true },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Other'], list: true },
      { name: 'dob', label: 'Date of Birth', type: 'date' },
      { name: 'national_id', label: 'National ID / Passport', type: 'text' },
      { name: 'department_id', label: 'Department', type: 'ref', ref: 'departments', onDelete: 'null', list: true },
      { name: 'program', label: 'Program', type: 'text', list: true },
      { name: 'year_of_study', label: 'Year of Study', type: 'select', options: ['1', '2', '3', '4', '5', '6'], list: true },
      { name: 'admission_date', label: 'Admission Date', type: 'date' },
      { name: 'status', label: 'Status', type: 'select', options: ['Active', 'Suspended', 'Graduated', 'Deferred', 'Discontinued'], default: 'Active', list: true },
      { name: 'guardian_name', label: 'Guardian Name', type: 'text' },
      { name: 'guardian_phone', label: 'Guardian Phone', type: 'text' },
      { name: 'address', label: 'Address', type: 'textarea' }
    ]
  },

  courses: {
    label: 'Courses', singular: 'Course', icon: '📚',
    display: ['code', 'title'],
    read: EVERYONE, write: ['admin'],
    fields: [
      { name: 'code', label: 'Code', type: 'text', required: true, unique: true, list: true },
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'department_id', label: 'Department', type: 'ref', ref: 'departments', onDelete: 'null', list: true },
      { name: 'teacher_id', label: 'Lecturer', type: 'ref', ref: 'teachers', onDelete: 'null', list: true },
      { name: 'credits', label: 'Credits', type: 'number', list: true },
      { name: 'semester', label: 'Semester', type: 'select', options: ['1', '2', '3'], list: true },
      { name: 'description', label: 'Description', type: 'textarea' }
    ]
  },

  enrollments: {
    label: 'Enrollments', singular: 'Enrollment', icon: '📝',
    display: ['id'],
    read: EVERYONE, write: ['admin'],
    scope: { student: 'student_id' },
    fields: [
      { name: 'student_id', label: 'Student', type: 'ref', ref: 'students', required: true, onDelete: 'cascade', list: true },
      { name: 'course_id', label: 'Course', type: 'ref', ref: 'courses', required: true, onDelete: 'cascade', list: true },
      { name: 'academic_year', label: 'Academic Year', type: 'text', list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Enrolled', 'Completed', 'Dropped'], default: 'Enrolled', list: true }
    ]
  },

  timetable: {
    label: 'Timetable', singular: 'Class Session', icon: '🗓️',
    display: ['day', 'start_time'],
    read: EVERYONE, write: ['admin'],
    fields: [
      { name: 'course_id', label: 'Course', type: 'ref', ref: 'courses', required: true, onDelete: 'cascade', list: true },
      { name: 'day', label: 'Day', type: 'select', required: true, options: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], list: true },
      { name: 'start_time', label: 'Start', type: 'time', required: true, list: true },
      { name: 'end_time', label: 'End', type: 'time', required: true, list: true },
      { name: 'room', label: 'Room', type: 'text', list: true }
    ]
  },

  attendance: {
    label: 'Attendance', singular: 'Attendance Record', icon: '✅',
    display: ['date'],
    read: EVERYONE, write: STAFF,
    scope: { student: 'student_id' },
    fields: [
      { name: 'student_id', label: 'Student', type: 'ref', ref: 'students', required: true, onDelete: 'cascade', list: true },
      { name: 'course_id', label: 'Course', type: 'ref', ref: 'courses', required: true, onDelete: 'cascade', list: true },
      { name: 'date', label: 'Date', type: 'date', required: true, list: true },
      { name: 'status', label: 'Status', type: 'select', options: ['Present', 'Absent', 'Late', 'Excused'], default: 'Present', required: true, list: true },
      { name: 'remarks', label: 'Remarks', type: 'text' }
    ]
  },

  grades: {
    label: 'Grades', singular: 'Grade', icon: '🏅',
    display: ['assessment'],
    read: EVERYONE, write: STAFF,
    scope: { student: 'student_id' },
    fields: [
      { name: 'student_id', label: 'Student', type: 'ref', ref: 'students', required: true, onDelete: 'cascade', list: true },
      { name: 'course_id', label: 'Course', type: 'ref', ref: 'courses', required: true, onDelete: 'cascade', list: true },
      { name: 'assessment', label: 'Assessment', type: 'select', options: ['CAT 1', 'CAT 2', 'Assignment', 'Mid-term', 'Final Exam', 'Overall'], list: true },
      { name: 'term', label: 'Term / Semester', type: 'text', list: true },
      { name: 'score', label: 'Score', type: 'number', required: true, list: true },
      { name: 'max_score', label: 'Out Of', type: 'number', default: 100, list: true },
      { name: 'grade', label: 'Grade (blank = auto)', type: 'text', list: true },
      { name: 'remarks', label: 'Remarks', type: 'text' }
    ]
  },

  fees: {
    label: 'Fees', singular: 'Fee Record', icon: '💰',
    display: ['description'],
    read: ['admin', 'student'], write: ['admin'],
    scope: { student: 'student_id' },
    fields: [
      { name: 'student_id', label: 'Student', type: 'ref', ref: 'students', required: true, onDelete: 'cascade', list: true },
      { name: 'description', label: 'Description', type: 'text', required: true, list: true },
      { name: 'amount', label: 'Amount Due', type: 'number', required: true, list: true },
      { name: 'paid', label: 'Amount Paid', type: 'number', default: 0, list: true },
      { name: 'due_date', label: 'Due Date', type: 'date', list: true },
      { name: 'payment_method', label: 'Payment Method', type: 'select', options: ['Cash', 'Bank', 'Mobile Money', 'Card', 'Scholarship'] },
      { name: 'reference', label: 'Receipt / Reference', type: 'text' },
      { name: 'status', label: 'Status (auto)', type: 'select', options: ['Unpaid', 'Partial', 'Paid'], readonly: true, list: true }
    ]
  },

  notices: {
    label: 'Notices', singular: 'Notice', icon: '📢',
    display: ['title'],
    read: EVERYONE, write: ['admin'],
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, list: true },
      { name: 'audience', label: 'Audience', type: 'select', options: ['Everyone', 'Students', 'Teachers', 'Staff'], default: 'Everyone', list: true },
      { name: 'publish_date', label: 'Publish Date', type: 'date', list: true },
      { name: 'pinned', label: 'Pinned', type: 'boolean', list: true },
      { name: 'body', label: 'Message', type: 'textarea', required: true }
    ]
  },

  users: {
    label: 'Users & Logins', singular: 'User', icon: '🔐',
    display: ['name', 'email'],
    read: ['admin'], write: ['admin'],
    fields: [
      { name: 'avatar', label: 'Avatar', type: 'image', list: true },
      { name: 'name', label: 'Full Name', type: 'text', required: true, list: true },
      { name: 'email', label: 'Email (login)', type: 'email', required: true, unique: true, list: true },
      { name: 'role', label: 'Role', type: 'select', options: ROLES, required: true, default: 'student', list: true },
      { name: 'password', label: 'Password (leave blank to keep)', type: 'password' },
      { name: 'student_id', label: 'Linked Student', type: 'ref', ref: 'students', onDelete: 'null', list: true },
      { name: 'teacher_id', label: 'Linked Teacher', type: 'ref', ref: 'teachers', onDelete: 'null', list: true },
      { name: 'active', label: 'Active', type: 'boolean', default: 1, list: true }
    ]
  }
};

const FIELD_TYPES = ['text', 'textarea', 'number', 'date', 'time', 'email', 'select', 'boolean', 'image', 'color'];

// Branding and system settings the super admin can edit.
const defaultSettings = {
  college_name: 'Tabo College',
  short_name: 'TC',
  tagline: 'Knowledge • Integrity • Excellence',
  logo: '/default-logo.svg',
  favicon: '/default-logo.svg',
  login_background: '',
  primary_color: '#2952cc',
  sidebar_color: '#101c3d',
  address: '',
  phone: '',
  email: '',
  website: '',
  academic_year: '2026/2027',
  currency: 'KES',
  footer_text: '© Tabo College. All rights reserved.',
  login_message: 'Welcome! Sign in to continue.',
  grading_scale: 'A:70, B:60, C:50, D:40, E:0',
  modules: '{}'
};

module.exports = { ROLES, entities, FIELD_TYPES, defaultSettings };
