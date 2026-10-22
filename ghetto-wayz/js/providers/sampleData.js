// SAMPLE DATA — hand-authored for the demo. Not live map data, not verified.
// Everything exported here is flagged `sample: true` so the UI can label it honestly.

export const SAMPLE_PLACES = [
  { id: 'p-station', name: 'Coventry Railway Station', sub: 'Station Square, Coventry', lat: 52.4008, lng: -1.5134, kind: 'transport' },
  { id: 'p-cathedral', name: 'Coventry Cathedral', sub: 'Priory St, Coventry', lat: 52.4083, lng: -1.5075, kind: 'landmark' },
  { id: 'p-uni', name: 'Coventry University', sub: 'Priory St, Coventry', lat: 52.4067, lng: -1.5030, kind: 'education' },
  { id: 'p-broadgate', name: 'Broadgate', sub: 'City centre, Coventry', lat: 52.4084, lng: -1.5103, kind: 'landmark' },
  { id: 'p-park', name: 'War Memorial Park', sub: 'Kenilworth Rd, Coventry', lat: 52.3963, lng: -1.5210, kind: 'park' },
  { id: 'p-pool', name: 'Pool Meadow Bus Station', sub: 'Fairfax St, Coventry', lat: 52.4100, lng: -1.5050, kind: 'transport' },
  { id: 'p-herbert', name: 'Herbert Art Gallery & Museum', sub: 'Jordan Well, Coventry', lat: 52.4077, lng: -1.5065, kind: 'landmark' },
  { id: 'p-transport', name: 'Coventry Transport Museum', sub: 'Millennium Place, Coventry', lat: 52.4116, lng: -1.5102, kind: 'landmark' },
  { id: 'p-spon', name: 'Spon Street', sub: 'Medieval quarter, Coventry', lat: 52.4082, lng: -1.5165, kind: 'landmark' },
  { id: 'p-fargo', name: 'FarGo Village', sub: 'Far Gosford St, Coventry', lat: 52.4095, lng: -1.4940, kind: 'shopping' },
];

// Sample routes between known places. Geometry is approximate and illustrative.
// `basis` explains what the route is built from so the UI never implies "verified" or "safe".
export const SAMPLE_ROUTES = [
  {
    from: 'p-station', to: 'p-cathedral',
    routes: [
      {
        label: 'Quickest', basis: 'Sample route following public streets and the pedestrian city-centre precinct.',
        geometry: [[52.4008, -1.5134], [52.4022, -1.5131], [52.4034, -1.5128], [52.4046, -1.5121], [52.4058, -1.5112], [52.4070, -1.5106], [52.4084, -1.5103], [52.4083, -1.5088], [52.4083, -1.5075]],
        steps: [
          { text: 'Head north on Station Square', dist: 160 },
          { text: 'Continue along Warwick Row past Greyfriars Green', dist: 330 },
          { text: 'Enter the pedestrian precinct at Hertford Street', dist: 230 },
          { text: 'Turn right at Broadgate', dist: 120 },
          { text: 'Follow Priory Street to the Cathedral', dist: 150 },
        ],
      },
      {
        label: 'More verified paths', basis: 'Sample route that uses a community-added path which moderators have reviewed and approved. Approval means the path appears on public map data — it is not a safety rating.',
        geometry: [[52.4008, -1.5134], [52.4022, -1.5131], [52.4034, -1.5128], [52.4040, -1.5110], [52.4050, -1.5095], [52.4062, -1.5085], [52.4072, -1.5080], [52.4083, -1.5075]],
        steps: [
          { text: 'Head north on Station Square', dist: 160 },
          { text: 'Turn right along Greyfriars Green footpath', dist: 200 },
          { text: 'Take the community-added cut-through toward Little Park Street', dist: 260 },
          { text: 'Continue along Earl Street and Bayley Lane', dist: 240 },
          { text: 'Arrive at Coventry Cathedral', dist: 90 },
        ],
        usesCommunityPaths: ['path-greyfriars-cut'],
      },
    ],
  },
  {
    from: 'p-station', to: 'p-park',
    routes: [
      {
        label: 'Quickest', basis: 'Sample route following Kenilworth Road footway and cycle lane.',
        geometry: [[52.4008, -1.5134], [52.4001, -1.5146], [52.3992, -1.5162], [52.3983, -1.5178], [52.3975, -1.5192], [52.3968, -1.5202], [52.3963, -1.5210]],
        steps: [
          { text: 'Head south-west on Eaton Road', dist: 190 },
          { text: 'Continue onto Kenilworth Road, use the shared path', dist: 520 },
          { text: 'Enter War Memorial Park at the main gate', dist: 110 },
        ],
      },
    ],
  },
  {
    from: 'p-broadgate', to: 'p-fargo',
    routes: [
      {
        label: 'Quickest', basis: 'Sample route via the city-centre precinct and Far Gosford Street.',
        geometry: [[52.4084, -1.5103], [52.4082, -1.5080], [52.4078, -1.5060], [52.4080, -1.5040], [52.4084, -1.5015], [52.4088, -1.4990], [52.4092, -1.4965], [52.4095, -1.4940]],
        steps: [
          { text: 'Head east along High Street and Jordan Well', dist: 320 },
          { text: 'Continue along Gosford Street', dist: 350 },
          { text: 'Cross the ring road using the subway/crossing', dist: 120 },
          { text: 'Follow Far Gosford Street to FarGo Village', dist: 330 },
        ],
      },
      {
        label: 'Quieter streets', basis: 'Sample alternative using side streets. "Quieter" is an estimate from road classification only.',
        geometry: [[52.4084, -1.5103], [52.4088, -1.5085], [52.4092, -1.5062], [52.4096, -1.5040], [52.4098, -1.5010], [52.4100, -1.4985], [52.4097, -1.4960], [52.4095, -1.4940]],
        steps: [
          { text: 'Head north-east via Hales Street', dist: 290 },
          { text: 'Take Cox Street and the canal-side path', dist: 410 },
          { text: 'Turn right toward Far Gosford Street', dist: 400 },
        ],
      },
    ],
  },
];

// Community-approved sample paths — appear on the map as "Community-added · approved".
export const SAMPLE_APPROVED_PATHS = [
  {
    id: 'path-greyfriars-cut', name: 'Greyfriars Green cut-through',
    type: 'footpath', surface: 'paved',
    points: [[52.4034, -1.5128], [52.4040, -1.5110], [52.4050, -1.5095]],
    status: 'approved', createdBy: 'u-sample-1', createdAt: '2026-09-28T10:12:00Z', reviewedAt: '2026-10-01T09:00:00Z',
    note: 'Paved path across the green, open to the public.', sample: true,
  },
];

export const SAMPLE_PENDING_PATHS = [
  {
    id: 'path-canal-link', name: 'Canal basin link',
    type: 'shared', surface: 'gravel',
    points: [[52.4120, -1.5078], [52.4126, -1.5060], [52.4130, -1.5045]],
    status: 'pending', createdBy: 'u-sample-2', createdAt: '2026-10-19T17:40:00Z',
    note: 'Towpath link behind the leisure centre.', sample: true,
  },
];

export const SAMPLE_ALERTS = [
  { id: 'a-1', category: 'blocked', lat: 52.4078, lng: -1.5060, note: 'Scaffolding across the footway, narrow gap only.', status: 'verified', createdBy: 'u-sample-1', createdAt: '2026-10-20T08:15:00Z', confirmations: ['u-sample-2', 'u-sample-3'], sample: true },
  { id: 'a-2', category: 'lighting', lat: 52.4042, lng: -1.5102, note: 'Lamp out on the underpass ramp.', status: 'pending', createdBy: 'u-sample-2', createdAt: '2026-10-21T19:30:00Z', confirmations: [], sample: true },
  { id: 'a-3', category: 'pothole', lat: 52.3988, lng: -1.5170, note: 'Deep pothole in the cycle lane near the park.', status: 'pending', createdBy: 'u-sample-3', createdAt: '2026-10-22T07:05:00Z', confirmations: ['u-sample-1'], sample: true },
  { id: 'a-4', category: 'closure', lat: 52.4124, lng: -1.5070, note: 'Towpath closed for repairs until further notice.', status: 'verified', createdBy: 'u-sample-1', createdAt: '2026-10-15T12:00:00Z', confirmations: ['u-sample-2'], sample: true },
];

export const SAMPLE_USERS = [
  { id: 'u-sample-1', alias: 'kerbhopper', points: 180, leaderboardOptIn: true, sample: true },
  { id: 'u-sample-2', alias: 'nightcycler', points: 95, leaderboardOptIn: true, sample: true },
  { id: 'u-sample-3', alias: 'towpathtom', points: 40, leaderboardOptIn: true, sample: true },
  { id: 'u-sample-4', alias: 'quietmode', points: 310, leaderboardOptIn: false, sample: true },
];
