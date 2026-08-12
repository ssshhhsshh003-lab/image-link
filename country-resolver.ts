import type { IncomingMessage } from 'http';

export interface CountryInfo {
  code: string;
  name: string;
}

const COUNTRY_NAMES: Record<string, string> = {
  PK: 'Pakistan',
  IN: 'India',
  US: 'United States',
  GB: 'United Kingdom',
  AE: 'United Arab Emirates',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  SA: 'Saudi Arabia',
  BD: 'Bangladesh',
  NP: 'Nepal',
  LK: 'Sri Lanka',
  PH: 'Philippines',
  MY: 'Malaysia',
  SG: 'Singapore',
};

export async function detectCountryFromRequest(req: IncomingMessage): Promise<CountryInfo> {
  try {
    // 1. Check standard Vercel / Cloudflare / Nginx headers
    const headerCountry =
      (req.headers['x-vercel-ip-country'] as string) ||
      (req.headers['cf-ipcountry'] as string) ||
      (req.headers['x-country-code'] as string);

    if (headerCountry && headerCountry.length === 2 && headerCountry !== 'XX') {
      const code = headerCountry.toUpperCase();
      const name = COUNTRY_NAMES[code] || code;
      return { code, name };
    }

    // 2. If IP lookup is required via API, perform fast server-side fetch with timeout
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      (req.headers['x-real-ip'] as string) ||
      req.socket.remoteAddress;

    if (ip && ip !== '::1' && ip !== '127.0.0.1') {
      const apiKey = process.env.GEOLOCATION_API_KEY;
      if (apiKey) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000); // 1s fast timeout

        try {
          const res = await fetch(`https://api.ipgeolocation.io/ipgeo?apiKey=${apiKey}&ip=${ip}&fields=country_code2,country_name`, {
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          if (res.ok) {
            const data = await res.json();
            if (data.country_code2) {
              return {
                code: data.country_code2.toUpperCase(),
                name: data.country_name || data.country_code2,
              };
            }
          }
        } catch {
          // Timeout or API error fallback
        }
      }
    }
  } catch {
    // Silent catch to guarantee non-blocking visitor redirect
  }

  return { code: 'XX', name: 'Unknown' };
}
