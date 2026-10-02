export class AppError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}
export const badRequest = (m, d) => new AppError(400, m, { code: 'BAD_REQUEST', details: d });
export const unauthorized = (m = 'Please sign in to continue.') => new AppError(401, m, { code: 'UNAUTHENTICATED' });
export const forbidden = (m = 'You do not have permission to perform this action.') => new AppError(403, m, { code: 'FORBIDDEN' });
export const notFound = (what = 'Record') => new AppError(404, `${what} not found.`, { code: 'NOT_FOUND' });
export const conflict = (m) => new AppError(409, m, { code: 'CONFLICT' });
export const unprocessable = (m, d) => new AppError(422, m, { code: 'UNPROCESSABLE', details: d });

/** Translate database errors into messages a user can act on. */
export function fromDbError(err) {
  if (err instanceof AppError) return err;
  const m = err?.message || '';
  switch (err?.code) {
    case 'P0002': return unprocessable('Journal cannot be posted because debits and credits do not balance.');
    case 'P0003': return conflict(m);
    case 'P0004': return conflict('Financial period is locked. Ask an authorised user to reopen it, or use a date in an open period.');
    case 'P0001': return forbidden(m);
    case 'P0005': return badRequest('One of the accounts does not belong to this company.');
    case '23505': return conflict(`A record with the same unique value already exists${err.constraint ? ` (${err.constraint.replace(/_/g, ' ')})` : ''}.`);
    case '23503': return conflict('This record is linked to other records and cannot be changed or removed this way.');
    case '23514': return unprocessable(`A value failed validation (${(err.constraint || 'check').replace(/_/g, ' ')}).`);
    case '22P02': return badRequest('One of the values has an invalid format.');
    case '22003': return badRequest('A number is too large.');
    case '22007': case '22008': return badRequest('One of the dates is not valid. Use the format YYYY-MM-DD.');
    case '2201W': case '2201X': return badRequest('Invalid paging values.');
    default: return null;
  }
}
