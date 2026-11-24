// Intentionally empty by default.
// Add Drizzle tables here when the site actually needs a database.
// See examples/d1/db/schema.ts for an opt-in example.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
export const operations = sqliteTable('operations', {
 code: text('code').primaryKey(), client: text('client').notNull(), account: text('account').notNull(),
 date: text('date').notNull(), time: text('time').notNull(), cents: integer('cents').notNull(),
 channel: text('channel').notNull(), raw: text('raw').notNull(), filename: text('filename').notNull(),
 status: text('status').notNull().default('Pendiente'), document: text('document').notNull().default('Sin asignar'),
 reference: text('reference').notNull().default(''), rate: integer('rate').notNull().default(100),
});
export const imports = sqliteTable('imports', { id:text('id').primaryKey(), filename:text('filename').notNull(), created:text('created').notNull(), added:integer('added').notNull(), duplicates:integer('duplicates').notNull(), conflicts:integer('conflicts').notNull() });
