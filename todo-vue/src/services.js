// Display metadata per service in the cascade.
export const SERVICES = {
  laravel: { label: 'Laravel', lang: 'PHP · queue job', color: '#f05340' },
  node: { label: 'Node', lang: 'Express 5', color: '#3c873a' },
  go: { label: 'Go', lang: 'net/http', color: '#00a7d0' },
  django: { label: 'Django', lang: 'Python', color: '#1f7a55' },
  dotnet: { label: '.NET', lang: 'ASP.NET Core 9', color: '#6a4bd8' },
  spring: { label: 'Spring', lang: 'Java · Boot 3.5', color: '#5e9e2f' },
};

export const STATUS_LABEL = {
  queued: 'Queued', running: 'Running', ok: 'OK', error: 'Error', skipped: 'Not called', pending: 'Pending',
};
