import bcrypt from 'bcryptjs';
import { badRequest } from './errors.js';
export const hashPassword = (p) => bcrypt.hash(p, 12);
export const verifyPassword = (p, h) => bcrypt.compare(p, h);
export function checkPasswordPolicy(p, minLength = 10) {
  if (typeof p !== 'string' || p.length < minLength) throw badRequest(`Password must be at least ${minLength} characters.`);
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) throw badRequest('Password must contain both letters and numbers.');
  if (p.length > 200) throw badRequest('Password is too long.');
}
