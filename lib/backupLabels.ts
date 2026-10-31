// Namn på tabellerna i säkerhetskopiorna, för texter i appen. Ligger för sig
// så att webbläsaren inte drar in serverns komprimering.
export const TABLE_LABEL: Record<string, string> = {
  areas: 'områden', schools: 'boenden', arenas: 'spelplatser', classrooms: 'rum', team_assignments: 'lag',
  participants: 'deltagare', arena_matches: 'matcher', referees: 'domare', tasks: 'uppgifter', incidents: 'incidenter',
  shifts: 'pass', messages: 'meddelanden', channels: 'kanaler', documents: 'dokument', news_posts: 'nyheter',
  room_issues: 'felanmälningar', night_rounds: 'nattronder', room_keys: 'nycklar', stock_items: 'lagervaror',
  stock_movements: 'lagerrörelser', vehicles: 'fordon', transport_jobs: 'transporter', transport_job_items: 'transportrader',
  dining_halls: 'matsalar', meal_services: 'måltider', meal_entitlements: 'måltidsrätter', meal_checkins: 'måltidsregistreringar',
  budget_lines: 'budgetrader', cost_entries: 'kostnader', emergency_contacts: 'nödnummer', on_call_shifts: 'jourpass',
  absences: 'frånvaro', availability: 'tillgänglighet', shift_swaps: 'passbyten', checklist_templates: 'checklistmallar',
  checklist_runs: 'checklistor', checklist_items: 'checklistpunkter', onboarding_items: 'introduktion',
  task_comments: 'uppgiftskommentarer', incident_comments: 'incidentkommentarer', crowd_counts: 'publikräkningar',
  security_logs: 'säkerhetsloggar', security_cars: 'säkerhetsbilar', car_routes: 'bilrutter', attachments: 'bilagor'
};

export function describeRestore(r: Record<string, number>): string {
  const parts = Object.entries(r).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${TABLE_LABEL[t] ?? t}`);
  return parts.length ? parts.join(', ') : 'Inget saknas';
}

