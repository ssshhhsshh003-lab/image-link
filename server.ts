import express from 'express';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import {
  createImageLink,
  getImageLinkBySlug,
  getUserImageLinks,
  deleteImageLink,
  updateImageLink,
  getCountryStatsForLink,
  getImageLinkById,
  incrementTotalClicks,
  incrementCountryClicks,
  recordSuccessfulClick,
  hashIpAddress,
  checkAndIncrementIpRedirectLimit
} from './link-service';
import { isSocialCrawler } from './crawler-detector';
import { detectCountryFromRequest } from './country-resolver';
import { authenticateUser, generateSessionToken, verifySessionToken, ensureUsersTableSchema } from './auth';

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust proxy headers on Vercel / reverse proxies
app.set('trust proxy', true);

// Initialize users table schema and admin user asynchronously on startup
ensureUsersTableSchema().catch(err => console.error('[AUTH SCHEMA ERROR]', err));

function getAuthenticatedUserId(req: express.Request): string | null {
  const token = req.cookies?.auth_token;
  if (!token) return null;
  const session = verifySessionToken(token);
  return session ? session.userId : null;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = getAuthenticatedUserId(req);
  if (!userId) {
    if (req.path.startsWith('/api-')) {
      return res.status(401).json({ error: 'UNAUTHORIZED: Please log in.' });
    }
    return res.redirect('/login');
  }
  (req as any).userId = userId;
  next();
}

// Safely extract client IP from request headers in proxy environments
function getClientIp(req: express.Request): string {
  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    const raw = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    const clientIp = raw.split(',')[0].trim();
    if (clientIp) return clientIp;
  }
  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp) {
    const raw = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
    if (raw.trim()) return raw.trim();
  }
  return req.ip || req.socket.remoteAddress || '127.0.0.1';
}

// 1. PUBLIC ROUTE: Dynamic Link Lookup, Social Crawler Detection & Fast Redirect (NO AUTH REQUIRED)
app.get('/i/:slug', async (req, res) => {
  const { slug } = req.params;
  const link = await getImageLinkBySlug(slug);

  if (!link) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
        <head><title>404 - Link Not Found</title></head>
        <body style="font-family:sans-serif; text-align:center; padding:50px;">
          <h2>404 - Link Not Found</h2>
          <p>The requested image link does not exist or has been removed.</p>
        </body>
      </html>
    `);
  }

  const userAgent = req.headers['user-agent'] || '';
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const publicUrl = `${protocol}://${host}/i/${slug}`;

  // Check for Social Crawlers (Facebook, Twitter, WhatsApp, etc.)
  if (isSocialCrawler(userAgent)) {
    const title = (link.title || 'Simple Image Link')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const description = (link.description || 'Shared via Simple Image Links.')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const imageUrl = link.imageUrl;

    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:url" content="${publicUrl}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${imageUrl}">
<title>${title}</title>
</head>
<body></body>
</html>`);
  }

  // Normal Human Visitor: Check Per-IP Redirect Limit
  const clientIp = getClientIp(req);
  const ipHash = hashIpAddress(clientIp);
  const limitCheck = await checkAndIncrementIpRedirectLimit(link.id, ipHash, link.ipRedirectLimit);

  if (!limitCheck.allowed) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(429).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Visit Limit Reached</title>
        </head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif; text-align:center; padding:60px 20px; color:#333; background:#f9fafb;">
          <div style="max-width:400px; margin:0 auto; background:#fff; padding:32px; border-radius:12px; border:1px solid #e5e7eb; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <h2 style="margin-top:0; font-size:20px; font-weight:700;">Visit limit reached</h2>
            <p style="color:#6b7280; font-size:14px; margin-bottom:0;">Please try again later.</p>
          </div>
        </body>
      </html>
    `);
  }

  // Normal Human Visitor: Fire analytics async (redirect immediately, never wait for DB)
  // Country detection + DB write happen in background
  // recordSuccessfulClick atomically updates total_clicks AND country_stats in one transaction
  // so SUM(country_stats.clicks) always equals total_clicks
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.redirect(302, link.destinationUrl);

  // Analytics fire AFTER response is sent — never blocks visitor
  detectCountryFromRequest(req)
    .then(country => recordSuccessfulClick(link.id, country.code, country.name))
    .catch(err => {
      // Even if country detection throws, still record click as Unknown
      console.error('Country detection failed, recording as Unknown:', err);
      recordSuccessfulClick(link.id, 'XX', 'Unknown').catch(e =>
        console.error('recordSuccessfulClick fallback error:', e)
      );
    });
});

// 2. AUTHENTICATION ROUTES (LOGIN / LOGOUT)
app.get('/login', (req, res) => {
  if (getAuthenticatedUserId(req)) {
    return res.redirect('/');
  }
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Login - Simple Image Links</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-50 text-slate-900 min-h-screen flex items-center justify-center p-4 font-sans">
      <div class="border rounded-xl p-8 bg-white shadow-sm max-w-sm w-full space-y-6">
        <div class="text-center">
          <h1 class="text-2xl font-bold">Admin Login</h1>
          <p class="text-xs text-slate-500 mt-1">Sign in to manage your image links</p>
        </div>
        <form id="loginForm" onsubmit="submitLogin(event)" class="space-y-4">
          <div id="errorAlert" class="hidden text-xs bg-red-50 text-red-600 border border-red-200 p-2.5 rounded-md font-medium"></div>
          <div>
            <label class="block text-sm font-medium mb-1">Username</label>
            <input type="text" id="username" required class="w-full px-3 py-2 border rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="admin" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-1">Password</label>
            <input type="password" id="password" required class="w-full px-3 py-2 border rounded-md text-sm outline-none focus:ring-2 focus:ring-blue-500" placeholder="••••••••" />
          </div>
          <button type="submit" class="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-md transition-colors">Sign In</button>
        </form>
      </div>

      <script>
        async function submitLogin(e) {
          e.preventDefault();
          const errDiv = document.getElementById('errorAlert');
          errDiv.classList.add('hidden');

          const username = document.getElementById('username').value;
          const password = document.getElementById('password').value;

          const res = await fetch('/api-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });

          if (res.ok) {
            window.location.href = '/';
          } else {
            const data = await res.json();
            errDiv.textContent = data.error || 'Invalid credentials';
            errDiv.classList.remove('hidden');
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.post('/api-login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = await authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = generateSessionToken(user.id);
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.status(200).json({ success: true });
  } catch (err: any) {
    console.error('[LOGIN ERROR]', err);
    return res.status(500).json({ error: err?.message || 'Authentication failed due to database or server error.' });
  }
});

app.post('/api-logout', (req, res) => {
  res.clearCookie('auth_token');
  return res.status(200).json({ success: true });
});

// 3. PROTECTED API ENDPOINTS (REQUIRE AUTHENTICATION)
app.post('/api-create-link', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, description, destinationUrl, ipRedirectLimit } = req.body;
    if (!destinationUrl) {
      return res.status(400).json({ error: 'Please enter a valid destination URL.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Please select an image.' });
    }

    const userId = (req as any).userId;
    const createdLink = await createImageLink({
      userId,
      imageBuffer: req.file.buffer,
      imageFileName: req.file.originalname || 'uploaded_image.jpg',
      mimeType: req.file.mimetype || 'image/jpeg',
      destinationUrl,
      title,
      description,
      ipRedirectLimit: ipRedirectLimit !== undefined ? parseInt(ipRedirectLimit, 10) : 2
    });

    return res.status(201).json(createdLink);
  } catch (err: any) {
    console.error('API /api-create-link error:', err);
    return res.status(400).json({ error: err.message || 'Unable to create image link.' });
  }
});

app.get('/api-user-links', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const links = await getUserImageLinks(userId);
    return res.status(200).json(links);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch image links.' });
  }
});

app.delete('/api-user-links', requireAuth, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id || typeof id !== 'string') {
      return res.status(400).json({ error: 'Missing link ID.' });
    }
    const userId = (req as any).userId;
    await deleteImageLink(id, userId);
    return res.status(200).json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Unable to delete image link.' });
  }
});

app.post('/api-update-link', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { linkId, title, description, destinationUrl, ipRedirectLimit } = req.body;
    if (!linkId) {
      return res.status(400).json({ error: 'Missing link ID.' });
    }
    const userId = (req as any).userId;

    const updated = await updateImageLink(linkId, userId, {
      title: title || undefined,
      description: description || undefined,
      destinationUrl: destinationUrl || undefined,
      ipRedirectLimit: ipRedirectLimit !== undefined ? parseInt(ipRedirectLimit, 10) : undefined,
      newImageBuffer: req.file?.buffer,
      newImageFileName: req.file?.originalname,
      newMimeType: req.file?.mimetype,
    });

    return res.status(200).json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Unable to save changes.' });
  }
});

app.get('/api-analytics', requireAuth, async (req, res) => {
  try {
    const { linkId } = req.query;
    if (!linkId || typeof linkId !== 'string') {
      return res.status(400).json({ error: 'Missing link ID.' });
    }
    const userId = (req as any).userId;
    const link = await getImageLinkById(linkId, userId);
    if (!link) {
      return res.status(403).json({ error: 'UNAUTHORIZED' });
    }
    const countries = await getCountryStatsForLink(linkId, userId);
    return res.status(200).json({
      linkId: link.id,
      slug: link.slug,
      totalClicks: Number(link.totalClicks),
      ipRedirectLimit: link.ipRedirectLimit,
      countries: countries.map(c => ({
        countryCode: c.countryCode,
        countryName: c.countryName,
        clicks: Number(c.clicks),
      })),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Unable to fetch analytics.' });
  }
});

// 4. PROTECTED DASHBOARD HTML ROUTE (REQUIRE AUTHENTICATION)
app.get('/', requireAuth, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Simple Image Links</title>
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-50 text-slate-900 min-h-screen p-4 sm:p-6 font-sans">
      <div class="max-w-4xl mx-auto" id="app">
        <header class="flex items-center justify-between border-b pb-4 mb-6">
          <h1 class="text-2xl font-bold">Simple Image Links</h1>
          <div class="flex items-center gap-3">
            <button onclick="showCreate()" class="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-md">+ Create Link</button>
            <button onclick="logout()" class="px-3 py-1.5 border hover:bg-slate-100 text-slate-700 font-semibold text-sm rounded-md">Logout</button>
          </div>
        </header>

        <main id="content" class="space-y-6">
          <p class="text-sm text-slate-500">Loading your image links...</p>
        </main>
      </div>

      <script>
        let allLinks = [];

        async function logout() {
          await fetch('/api-logout', { method: 'POST' });
          window.location.href = '/login';
        }

        function formatLimitLabel(limit) {
          if (limit === 0) return 'Unlimited';
          return limit + ' / 24 hours';
        }

        async function loadLinks() {
          const res = await fetch('/api-user-links');
          if (res.status === 401) { window.location.href = '/login'; return; }
          const links = await res.json();
          allLinks = links;
          const content = document.getElementById('content');
          if (!links.length) {
            content.innerHTML = '<div class="border rounded-xl p-10 text-center space-y-3 bg-white"><p class="text-slate-500 text-sm">No image links created yet.</p><button onclick="showCreate()" class="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-md">Create Link</button></div>';
            return;
          }
          content.innerHTML = '<div class="space-y-4">' + links.map(l => \`
            <div class="border rounded-xl p-4 bg-white shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div class="flex items-center gap-4">
                <img src="\${l.imageUrl}" class="w-14 h-14 object-cover rounded-lg border bg-slate-100 flex-shrink-0" />
                <div>
                  <h3 class="font-bold text-base">\${l.title || 'Simple Image Link'}</h3>
                  <p class="text-xs font-mono text-blue-600">\${location.origin}/i/\${l.slug}</p>
                  <div class="flex items-center gap-3 text-xs text-slate-500 mt-1">
                    <span>Clicks: <strong>\${l.totalClicks}</strong></span>
                    <span>•</span>
                    <span>IP Limit: <strong>\${formatLimitLabel(l.ipRedirectLimit)}</strong></span>
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2 self-end sm:self-center">
                <button onclick="showEdit('\${l.id}')" class="px-2.5 py-1 text-xs font-semibold border rounded hover:bg-slate-100">Edit</button>
                <button onclick="copyLink('\${l.slug}')" class="px-2.5 py-1 text-xs font-semibold border rounded hover:bg-slate-100">Copy</button>
                <button onclick="loadAnalytics('\${l.id}')" class="px-2.5 py-1 text-xs font-semibold border rounded hover:bg-slate-100">Analytics</button>
                <button onclick="deleteLink('\${l.id}')" class="px-2.5 py-1 text-xs font-semibold text-red-600 border border-red-200 rounded hover:bg-red-50">Delete</button>
              </div>
            </div>
          \`).join('') + '</div>';
        }

        function showCreate() {
          document.getElementById('content').innerHTML = \`
            <div class="border rounded-xl p-6 bg-white shadow-sm max-w-xl mx-auto space-y-4">
              <h2 class="text-xl font-bold">Create Image Link</h2>
              <form id="createForm" onsubmit="submitCreate(event)" class="space-y-4">
                <div>
                  <label class="block text-sm font-medium mb-1">Upload Image *</label>
                  <input type="file" id="image" accept="image/*" required class="block w-full text-sm text-slate-500" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Title</label>
                  <input type="text" id="title" class="w-full px-3 py-2 border rounded-md text-sm" placeholder="Optional title" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Description</label>
                  <textarea id="description" rows="2" class="w-full px-3 py-2 border rounded-md text-sm" placeholder="Optional description"></textarea>
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Destination URL *</label>
                  <input type="url" id="destinationUrl" required class="w-full px-3 py-2 border rounded-md text-sm" placeholder="https://example.com" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Maximum redirects per IP</label>
                  <select id="ipRedirectLimit" class="w-full px-3 py-2 border rounded-md text-sm bg-white">
                    <option value="1">1 / 24 hours</option>
                    <option value="2" selected>2 / 24 hours (Default)</option>
                    <option value="3">3 / 24 hours</option>
                    <option value="5">5 / 24 hours</option>
                    <option value="10">10 / 24 hours</option>
                    <option value="0">Unlimited</option>
                  </select>
                </div>
                <div class="flex gap-2 pt-2">
                  <button type="button" onclick="loadLinks()" class="w-1/2 py-2 border text-sm font-semibold rounded-md">Cancel</button>
                  <button type="submit" class="w-1/2 py-2 bg-blue-600 text-white text-sm font-semibold rounded-md">Create Link</button>
                </div>
              </form>
            </div>
          \`;
        }

        async function submitCreate(e) {
          e.preventDefault();
          const formData = new FormData();
          formData.append('image', document.getElementById('image').files[0]);
          formData.append('destinationUrl', document.getElementById('destinationUrl').value);
          formData.append('title', document.getElementById('title').value);
          formData.append('description', document.getElementById('description').value);
          formData.append('ipRedirectLimit', document.getElementById('ipRedirectLimit').value);

          const res = await fetch('/api-create-link', { method: 'POST', body: formData });
          if (res.ok) {
            loadLinks();
          } else {
            const err = await res.json();
            alert(err.error || 'Error creating link');
          }
        }

        function showEdit(linkId) {
          const link = allLinks.find(l => l.id === linkId);
          if (!link) return;

          document.getElementById('content').innerHTML = \`
            <div class="border rounded-xl p-6 bg-white shadow-sm max-w-xl mx-auto space-y-4">
              <h2 class="text-xl font-bold">Edit Image Link</h2>
              <form id="editForm" onsubmit="submitEdit(event, '\${link.id}')" class="space-y-4">
                <div class="flex items-center gap-4 border p-3 rounded-lg bg-slate-50">
                  <img src="\${link.imageUrl}" class="w-16 h-16 object-cover rounded-md border" />
                  <div>
                    <label class="block text-xs font-medium text-slate-500 mb-1">Replace Image (Optional)</label>
                    <input type="file" id="newImage" accept="image/*" class="block w-full text-xs text-slate-500" />
                  </div>
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Title</label>
                  <input type="text" id="editTitle" class="w-full px-3 py-2 border rounded-md text-sm" value="\${(link.title || '').replace(/"/g, '&quot;')}" placeholder="Optional title" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Description</label>
                  <textarea id="editDescription" rows="2" class="w-full px-3 py-2 border rounded-md text-sm" placeholder="Optional description">\${link.description || ''}</textarea>
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Destination URL *</label>
                  <input type="url" id="editDestinationUrl" required class="w-full px-3 py-2 border rounded-md text-sm" value="\${link.destinationUrl}" placeholder="https://example.com" />
                </div>
                <div>
                  <label class="block text-sm font-medium mb-1">Maximum redirects per IP</label>
                  <select id="editIpRedirectLimit" class="w-full px-3 py-2 border rounded-md text-sm bg-white">
                    <option value="1" \${link.ipRedirectLimit === 1 ? 'selected' : ''}>1 / 24 hours</option>
                    <option value="2" \${link.ipRedirectLimit === 2 ? 'selected' : ''}>2 / 24 hours</option>
                    <option value="3" \${link.ipRedirectLimit === 3 ? 'selected' : ''}>3 / 24 hours</option>
                    <option value="5" \${link.ipRedirectLimit === 5 ? 'selected' : ''}>5 / 24 hours</option>
                    <option value="10" \${link.ipRedirectLimit === 10 ? 'selected' : ''}>10 / 24 hours</option>
                    <option value="0" \${link.ipRedirectLimit === 0 ? 'selected' : ''}>Unlimited</option>
                  </select>
                </div>
                <div class="flex gap-2 pt-2">
                  <button type="button" onclick="loadLinks()" class="w-1/2 py-2 border text-sm font-semibold rounded-md">Cancel</button>
                  <button type="submit" class="w-1/2 py-2 bg-blue-600 text-white text-sm font-semibold rounded-md">Save Changes</button>
                </div>
              </form>
            </div>
          \`;
        }

        async function submitEdit(e, linkId) {
          e.preventDefault();
          const formData = new FormData();
          formData.append('linkId', linkId);
          const fileInput = document.getElementById('newImage');
          if (fileInput.files.length > 0) {
            formData.append('image', fileInput.files[0]);
          }
          formData.append('title', document.getElementById('editTitle').value);
          formData.append('description', document.getElementById('editDescription').value);
          formData.append('destinationUrl', document.getElementById('editDestinationUrl').value);
          formData.append('ipRedirectLimit', document.getElementById('editIpRedirectLimit').value);

          const res = await fetch('/api-update-link', { method: 'POST', body: formData });
          if (res.ok) {
            loadLinks();
          } else {
            const err = await res.json();
            alert(err.error || 'Error updating link');
          }
        }

        async function loadAnalytics(linkId) {
          const res = await fetch('/api-analytics?linkId=' + linkId);
          const data = await res.json();
          document.getElementById('content').innerHTML = \`
            <div class="space-y-6">
              <div class="flex items-center justify-between border-b pb-4">
                <h2 class="text-2xl font-bold">Analytics</h2>
                <button onclick="loadLinks()" class="px-3 py-1.5 text-xs font-semibold border rounded-md">Back to Dashboard</button>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div class="border rounded-xl p-6 bg-white shadow-sm">
                  <span class="text-xs font-semibold text-slate-400 uppercase">Total Clicks</span>
                  <div class="text-4xl font-extrabold mt-1">\${data.totalClicks}</div>
                </div>
                <div class="border rounded-xl p-6 bg-white shadow-sm">
                  <span class="text-xs font-semibold text-slate-400 uppercase">IP Redirect Limit</span>
                  <div class="text-2xl font-bold mt-2">\${formatLimitLabel(data.ipRedirectLimit)}</div>
                </div>
              </div>
              <div class="border rounded-xl p-6 bg-white shadow-sm space-y-4">
                <h3 class="text-lg font-bold">Clicks by Country</h3>
                \${!data.countries.length ? '<p class="text-sm text-slate-500">No clicks yet.</p>' : \`
                  <table class="w-full text-left text-sm">
                    <thead><tr class="border-b text-xs text-slate-400 uppercase"><th class="py-2">Country</th><th class="py-2 text-right">Clicks</th></tr></thead>
                    <tbody class="divide-y">\${data.countries.map(c => \`<tr><td class="py-3 font-medium">\${c.countryName} (\${c.countryCode})</td><td class="py-3 text-right font-bold">\${c.clicks}</td></tr>\`).join('')}</tbody>
                  </table>
                \`}
              </div>
            </div>
          \`;
        }

        async function deleteLink(id) {
          if (!confirm('Delete this image link?')) return;
          const res = await fetch('/api-user-links?id=' + id, { method: 'DELETE' });
          if (res.ok) loadLinks();
        }

        function copyLink(slug) {
          navigator.clipboard.writeText(location.origin + '/i/' + slug);
          alert('Link copied to clipboard!');
        }

        loadLinks();
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`> Server running on http://localhost:${PORT}`);
});

export default app;


