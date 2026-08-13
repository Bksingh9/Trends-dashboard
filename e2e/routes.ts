/** The route inventory, shared by the spec files. */
export const ROUTES = [
  { path: '/', title: 'Is Companion healthy today?' },
  { path: '/sales', title: 'Sales' },
  { path: '/journey', title: 'Journey' },
  { path: '/journey/events', title: 'Event dictionary' },
  { path: '/stores', title: 'Stores' },
  { path: '/catalogue', title: 'Catalogue' },
  { path: '/app-health', title: 'App Health' },
  { path: '/issues', title: 'Issues' },
  { path: '/insights', title: 'AI Insights' },
  { path: '/connectors', title: 'Connectors' },
  { path: '/reference', title: 'Reference' },
  { path: '/settings', title: 'Settings' },
] as const;
