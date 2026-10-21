// Usage: node scripts/hash-password.mjs "<password>" "<username>" "<Display Name>"
// Prints the SQL to create a leader account. Run the SQL with:
//   npx wrangler d1 execute calvary-db --remote --command "<the SQL>"
import { hashPassword } from '../src/auth.js';

const [password, username, name] = process.argv.slice(2);
if (!password || !username || !name || password.length < 10) {
  console.error('Usage: node scripts/hash-password.mjs "<password (10+ chars)>" "<username>" "<Display Name>"');
  process.exit(1);
}
const esc = (s) => s.replace(/'/g, "''");
const hash = await hashPassword(password);
console.log(`INSERT INTO admins (username, name, role, password_hash, created_at) VALUES ('${esc(username)}', '${esc(name)}', 'admin', '${hash}', ${Date.now()});`);
