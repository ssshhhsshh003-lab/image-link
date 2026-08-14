const SOCIAL_CRAWLER_USER_AGENTS = [
  'facebookexternalhit',
  'facebookcatalog',
  'facebot',
  'twitterbot',
  'linkedinbot',
  'whatsapp',
  'telegrambot',
  'slackbot',
  'discordbot',
  'pinterest',
  'skypeuripreview',
  'bingpreview',
  'googlebot',
];

export function isSocialCrawler(userAgent?: string | null): boolean {
  if (!userAgent || typeof userAgent !== 'string') return false;
  const lower = userAgent.toLowerCase();
  return SOCIAL_CRAWLER_USER_AGENTS.some((crawler) => lower.includes(crawler));
}

