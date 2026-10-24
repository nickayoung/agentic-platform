/// <reference path="../src/sql-modules.d.ts" />
import type { Migration } from '../src/migrate';
import core0001 from './0001_core.sql';
import core0002 from './0002_phase1_staff.sql';

export const coreMigrations: readonly Migration[] = [
  { id: '0001_core', sql: core0001 },
  { id: '0002_phase1_staff', sql: core0002 },
];
