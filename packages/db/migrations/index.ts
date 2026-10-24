import type { Migration } from '../src/migrate';
import core0001 from './0001_core.sql';

export const coreMigrations: readonly Migration[] = [{ id: '0001_core', sql: core0001 }];
