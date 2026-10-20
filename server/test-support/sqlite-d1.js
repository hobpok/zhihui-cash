import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const migrationDirectory = fileURLToPath(new URL('../../migrations/', import.meta.url));
const migrations = readdirSync(migrationDirectory).filter(name => /^\d+_.*\.sql$/.test(name)).sort();

export function applyMigrations(sqlite, { after, through } = {}) {
  for (const name of migrations) {
    if ((!after || name > after) && (!through || name <= through)) {
      sqlite.exec(readFileSync(fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), 'utf8'));
    }
  }
}

// Thin D1 binding facade over a real SQLite engine. SQL, triggers, uniqueness
// and rollback run in SQLite; only D1's async method signatures are adapted.
export function sqliteD1({ through } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  applyMigrations(sqlite, { through });
  return {
    sqlite,
    db: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        return {
          bind(...parameters) {
            return {
              async first() { return statement.get(...parameters) ?? null; },
              async all() { return { results: statement.all(...parameters) }; },
              async run() {
                if (/\bRETURNING\b/i.test(sql)) return { results: statement.all(...parameters) };
                const result = statement.run(...parameters);
                return { results: [], meta: { changes: Number(result.changes) } };
              },
            };
          },
        };
      },
    },
  };
}

export function seed(sqlite, id, email, status = 'active', role = 'member') {
  sqlite.prepare('INSERT INTO members(id, email, role, status) VALUES (?, ?, ?, ?)')
    .run(id, email, role, status);
}
