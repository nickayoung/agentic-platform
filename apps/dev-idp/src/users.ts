// Demo staff for the preview tenant. The directory import (§18.3) uses the same list, so a demo user who signs in
// is also a person resource with the matching staff_key.
export interface DemoUser {
  sub: string;
  name: string;
  email: string;
  /** Directory groups; role mappings in the tenant identity turn these into platform and staff roles (§4.13). */
  groups: string[];
  studios?: string[];
}

const desk = (sub: string, name: string, studios: string[]): DemoUser =>
  ({ sub, name, email: `${sub}@lotusline.example`, groups: ['lotus-desk', 'lotus-staff'], studios });
const teacher = (sub: string, name: string, extra: string[] = []): DemoUser =>
  ({ sub, name, email: `${sub}@lotusline.example`, groups: ['lotus-teachers', 'lotus-staff', ...extra] });

export const USERS: DemoUser[] = [
  { sub: 'nina', name: 'Nina Park', email: 'nina@lotusline.example', groups: ['lotus-owners', 'lotus-staff'] },
  { sub: 'marco', name: 'Marco Diaz', email: 'marco@lotusline.example', groups: ['lotus-managers', 'lotus-staff'], studios: ['park_slope', 'dumbo'] },
  { sub: 'aisha', name: 'Aisha Bello', email: 'aisha@lotusline.example', groups: ['lotus-managers', 'lotus-staff'], studios: ['williamsburg'] },
  desk('sam', 'Sam Okafor', ['park_slope']),
  desk('lena', 'Lena Novak', ['park_slope']),
  desk('jo', 'Jo Ramirez', ['park_slope', 'dumbo']),
  desk('kai', 'Kai Tanaka', ['williamsburg']),
  desk('rosa', 'Rosa Lima', ['williamsburg']),
  desk('theo', 'Theo Brandt', ['dumbo']),
  desk('ivy', 'Ivy Chen', ['dumbo', 'williamsburg']),
  { ...desk('priya', 'Priya Shah', ['park_slope']), groups: ['lotus-desk', 'lotus-teachers', 'lotus-staff'] },
  teacher('maya', 'Maya Ross'),
  teacher('amara', 'Amara Obi'),
  teacher('ana', 'Ana Silva'),
  teacher('ben', 'Ben Wolfe'),
  teacher('cleo', 'Cleo Hart'),
];
