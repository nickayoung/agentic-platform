// kairos-dev-gateway: a preview-only stand-in for the tenant's gateway in front of BookingVendor and ShiftTool
// (§18.3). It serves the normalised read contract kairos-sync polls (apps/sync/src/adapters.ts) with a realistic month
// of Lotus & Line classes, built from the reference timetable (§4b.1) with teachers assigned. Read-only, demo data.
import { addDays, fromLocal, toLocal, weekdayOf } from '@kairos/core';

const NY = 'America/New_York';
const DAYS = 28;

interface Series {
  key: string;
  template: string;
  location: string;
  room: string;
  days: string[];
  at: string;
  minutes: number;
  /** teacher per weekday, or one for all days */
  teacher: string | Record<string, string>;
}

// The reference timetable (fixtures/configs/lotus_line.yaml `timetable`), run from today rather than 2027-03-01.
const SERIES: Series[] = [
  { key: 'ps_vinyasa_0700', template: 'vinyasa_60', location: 'park_slope', room: 'ps_studio_1', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '07:00', minutes: 60,
    teacher: { mon: 'maya', tue: 'maya', wed: 'maya', thu: 'maya', fri: 'guest' } },
  { key: 'ps_vinyasa_0800_wknd', template: 'vinyasa_60', location: 'park_slope', room: 'ps_studio_1', days: ['sat', 'sun'], at: '08:00', minutes: 60, teacher: 'ana' },
  { key: 'ps_vinyasa_0900', template: 'vinyasa_60', location: 'park_slope', room: 'ps_studio_1', days: ['mon', 'tue', 'wed', 'thu', 'fri'], at: '09:00', minutes: 60, teacher: 'ben' },
  { key: 'ps_hot_1800', template: 'hot_75', location: 'park_slope', room: 'ps_studio_2', days: ['mon', 'tue', 'wed', 'thu'], at: '18:00', minutes: 75,
    teacher: { mon: 'priya', tue: 'cleo', wed: 'priya', thu: 'cleo' } },
  { key: 'wb_vinyasa_1830', template: 'vinyasa_60', location: 'williamsburg', room: 'wb_studio', days: ['mon', 'tue', 'wed', 'thu'], at: '18:30', minutes: 60, teacher: 'ana' },
  { key: 'db_flow_1215', template: 'flow_pooled_60', location: 'dumbo', room: 'db_studio', days: ['tue', 'thu'], at: '12:15', minutes: 60, teacher: 'maya' },
  { key: 'ps_prenatal_sat', template: 'prenatal_60', location: 'park_slope', room: 'ps_studio_1', days: ['sat'], at: '11:00', minutes: 60, teacher: 'amara' },
];

const NAMES: Record<string, string> = {
  maya: 'Maya Ross', ana: 'Ana Silva', ben: 'Ben Wolfe', priya: 'Priya Shah', cleo: 'Cleo Hart', amara: 'Amara Obi', guest: 'Guest Teacher',
};

function classes(today: string) {
  const out = [];
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(today, i);
    const wd = weekdayOf(date);
    for (const s of SERIES) {
      if (!s.days.includes(wd)) continue;
      const who = typeof s.teacher === 'string' ? s.teacher : s.teacher[wd]!;
      const start = fromLocal(date, s.at, NY);
      out.push({
        external_id: `bv_${s.key}_${date}`,
        external_version: '1',
        data: {
          template_key: s.template, location_key: s.location, room_key: s.room, start, end: start + s.minutes * 60_000,
          status: 'scheduled',
          teacher: { external_id: `bv_t_${who}`, email: who === 'guest' ? 'guest.teacher@elsewhere.example' : `${who}@lotusline.example`, name: NAMES[who] },
        },
      });
    }
  }
  return out;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const [system, entity] = parts.slice(-2);
    if (req.method !== 'GET' || !system || !entity) return Response.json({ error: 'not found' }, { status: 404 });
    if (system === 'booking_vendor' && entity === 'classes') {
      return Response.json({ records: classes(toLocal(Date.now(), NY).date), next_cursor: null });
    }
    if ((system === 'booking_vendor' && ['bookings', 'members'].includes(entity)) || (system === 'shift_tool' && entity === 'shifts')) {
      return Response.json({ records: [], next_cursor: null });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
} satisfies ExportedHandler;
