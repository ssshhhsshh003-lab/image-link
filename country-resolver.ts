import type { IncomingMessage } from 'http';

export interface CountryInfo {
  code: string;
  name: string;
}

const COUNTRY_NAMES: Record<string, string> = {
  AF: 'Afghanistan',
  AL: 'Albania',
  DZ: 'Algeria',
  AO: 'Angola',
  AR: 'Argentina',
  AU: 'Australia',
  AT: 'Austria',
  AZ: 'Azerbaijan',
  BD: 'Bangladesh',
  BE: 'Belgium',
  BR: 'Brazil',
  BG: 'Bulgaria',
  CA: 'Canada',
  CL: 'Chile',
  CN: 'China',
  CO: 'Colombia',
  HR: 'Croatia',
  CZ: 'Czech Republic',
  DK: 'Denmark',
  EG: 'Egypt',
  ET: 'Ethiopia',
  FI: 'Finland',
  FR: 'France',
  DE: 'Germany',
  GH: 'Ghana',
  GR: 'Greece',
  GT: 'Guatemala',
  HK: 'Hong Kong',
  HU: 'Hungary',
  IN: 'India',
  ID: 'Indonesia',
  IR: 'Iran',
  IQ: 'Iraq',
  IE: 'Ireland',
  IL: 'Israel',
  IT: 'Italy',
  JP: 'Japan',
  JO: 'Jordan',
  KZ: 'Kazakhstan',
  KE: 'Kenya',
  KW: 'Kuwait',
  LB: 'Lebanon',
  LY: 'Libya',
  MY: 'Malaysia',
  MX: 'Mexico',
  MA: 'Morocco',
  MM: 'Myanmar',
  NL: 'Netherlands',
  NZ: 'New Zealand',
  NG: 'Nigeria',
  NO: 'Norway',
  OM: 'Oman',
  PK: 'Pakistan',
  PE: 'Peru',
  PH: 'Philippines',
  PL: 'Poland',
  PT: 'Portugal',
  QA: 'Qatar',
  RO: 'Romania',
  RU: 'Russia',
  SA: 'Saudi Arabia',
  SN: 'Senegal',
  RS: 'Serbia',
  SG: 'Singapore',
  ZA: 'South Africa',
  KR: 'South Korea',
  ES: 'Spain',
  LK: 'Sri Lanka',
  SD: 'Sudan',
  SE: 'Sweden',
  CH: 'Switzerland',
  SY: 'Syria',
  TW: 'Taiwan',
  TZ: 'Tanzania',
  TH: 'Thailand',
  TN: 'Tunisia',
  TR: 'Turkey',
  UG: 'Uganda',
  UA: 'Ukraine',
  AE: 'United Arab Emirates',
  GB: 'United Kingdom',
  US: 'United States',
  UZ: 'Uzbekistan',
  VE: 'Venezuela',
  VN: 'Vietnam',
  YE: 'Yemen',
  ZM: 'Zambia',
  ZW: 'Zimbabwe',
  XX: 'Unknown',
};

// Always returns a CountryInfo, never throws.
// Falls back to Unknown on any failure — ensuring country stats are always recorded.
export async function detectCountryFromRequest(req: IncomingMessage): Promise<CountryInfo> {
  try {
    // 1. Check standard Vercel / Cloudflare / Nginx headers (fastest path, no external call)
    const headerCountry =
      (req.headers['x-vercel-ip-country'] as string) ||
      (req.headers['cf-ipcountry'] as string) ||
      (req.headers['x-country-code'] as string);

    if (headerCountry && typeof headerCountry === 'string') {
      const trimmed = headerCountry.trim().toUpperCase();
      // Accept valid 2-letter ISO codes (XX is legitimate "unknown" from Vercel)
      if (trimmed.length === 2 && /^[A-Z]{2}$/.test(trimmed) && trimmed !== 'XX' && trimmed !== 'T1') {
        const name = COUNTRY_NAMES[trimmed] || trimmed;
        return { code: trimmed, name };
      }
    }

    // 2. Optional: IP-based geolocation API fallback (only if API key configured)
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.socket?.remoteAddress;

    if (ip && ip !== '::1' && ip !== '127.0.0.1' && !ip.startsWith('10.') && !ip.startsWith('192.168.') && !ip.startsWith('172.')) {
      const apiKey = process.env.GEOLOCATION_API_KEY;
      if (apiKey) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500); // 1.5s timeout

        try {
          const apiRes = await fetch(
            `https://api.ipgeolocation.io/ipgeo?apiKey=${apiKey}&ip=${ip}&fields=country_code2,country_name`,
            { signal: controller.signal }
          );
          clearTimeout(timeoutId);

          if (apiRes.ok) {
            const data = await apiRes.json();
            if (data?.country_code2 && typeof data.country_code2 === 'string') {
              const code = data.country_code2.toUpperCase();
              const name = data.country_name || COUNTRY_NAMES[code] || code;
              if (code.length === 2 && /^[A-Z]{2}$/.test(code)) {
                return { code, name };
              }
            }
          }
        } catch {
          // Timeout, network error, JSON parse error — fall through to Unknown
        } finally {
          clearTimeout(timeoutId);
        }
      }
    }
  } catch {
    // Any unexpected error — fall through to Unknown
  }

  // Final guaranteed fallback: always record as Unknown rather than losing the click
  return { code: 'XX', name: 'Unknown' };
}

