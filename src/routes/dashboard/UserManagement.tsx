/**
 * Old App.tsx still lazy-imports this file. The screen is AdminHome
 * (user list → Modify user). Keep this path so a tab that loaded the old
 * chunk does not 404.
 */
export { AdminHome as UserManagement } from './admin/AdminHome';
