import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

// ─── HTML / CSS Sanitization Helpers ───
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sanitizeCssValue(value: string): string {
  // Strip anything that could break out of a CSS value context
  return value.replace(/[;{}()<>\\/"'`]/g, "");
}

function sanitizeFontName(name: string): string {
  // Allow only alphanumeric, spaces, and hyphens in font names
  return name.replace(/[^a-zA-Z0-9 -]/g, "");
}

function isAllowedUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// ─── Stripe Webhook ───
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function computeHmacSha256(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

async function verifyStripeSignature(
  body: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  const parts = sigHeader.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  const v1Sig = parts.find((p) => p.startsWith("v1="))?.slice(3);
  if (!timestamp || !v1Sig) return false;

  // Check timestamp is within 5 minutes
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) return false;

  const expected = await computeHmacSha256(secret, `${timestamp}.${body}`);
  if (expected.length !== v1Sig.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ v1Sig.charCodeAt(i);
  }
  return mismatch === 0;
}

http.route({
  path: "/stripe-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!webhookSecret) {
      console.error("STRIPE_WEBHOOK_SECRET not configured");
      return new Response("Webhook secret not configured", { status: 500 });
    }

    const body = await request.text();
    const sigHeader = request.headers.get("stripe-signature") || "";

    const valid = await verifyStripeSignature(body, sigHeader, webhookSecret);
    if (!valid) {
      console.error("Invalid Stripe webhook signature");
      return new Response("Invalid signature", { status: 400 });
    }

    let event;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.userId || session.client_reference_id;
      const amount = Number(session.metadata?.amount) || Number(session.amount_total) || 899;

      if (userId && session.id) {
        await ctx.runMutation(internal.payments.recordPayment, {
          userId,
          stripeSessionId: session.id,
          amount,
        });
      }
    }

    return new Response("ok", { status: 200 });
  }),
});

http.route({
  pathPrefix: "/p/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const slug = url.pathname.split("/").pop()?.trim().toLowerCase() || "";

    if (!slug) {
      return new Response("Not found", { status: 404 });
    }

    const portfolio = await ctx.runQuery(api.portfolio.getPublicPortfolioBySlug, {
      slug,
    });

    if (!portfolio) {
      return new Response("Not found", { status: 404 });
    }

    // Add noise SVG directly to the CSS
    const noiseSvg = "data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E";

    const projectsHtml = portfolio.highlightedProjects.map((p: any) => {
      const stackHtml = p.stack.map((s: string) => `<span>${escapeHtml(s)}</span>`).join("");
      const safeImageUrl = p.imageUrl && isAllowedUrl(p.imageUrl) ? escapeHtml(p.imageUrl) : "";
      const imageHtml = safeImageUrl
        ? `<div class="project-image-container"><img src="${safeImageUrl}" alt="${escapeHtml(p.name)}" class="project-image" /></div>`
        : "";
      const safeGameUrl = p.gameUrl && isAllowedUrl(p.gameUrl) ? escapeHtml(p.gameUrl) : "";
      const gameLinkHtml = safeGameUrl
        ? `<a href="${safeGameUrl}" target="_blank" rel="noopener noreferrer" class="game-link">[ PLAY EXPERIENCE ] <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg></a>`
        : "";

      return `
        <div class="project">
          ${imageHtml}
          <div class="project-content-wrapper">
            <div class="project-meta">
              <h3>${escapeHtml(p.name)}</h3>
              <div class="stack">${stackHtml}</div>
            </div>
            <div class="details">
              <div class="summary">${escapeHtml(p.summary)}</div>
              <div class="impact">${escapeHtml(p.impact)}</div>
              ${gameLinkHtml}
            </div>
          </div>
        </div>
      `;
    }).join("");

    const skillsHtml = portfolio.skills.map((s: string) => `<div class="skill">${escapeHtml(s)}</div>`).join("");

    const sectionsHtml = portfolio.sectionBlocks && portfolio.sectionBlocks.length > 0
      ? `
      <section class="section">
        <div class="section-title">04 / More</div>
        <div class="extra-grid">
          ${portfolio.sectionBlocks.map((b: any) => `
            <div class="extra-block">
              <h4>${escapeHtml(b.title)}</h4>
              <p>${escapeHtml(b.body)}</p>
            </div>
          `).join("")}
        </div>
      </section>
      `
      : "";

    const defaultTheme = {
      bg: "#050505",
      bgSurface: "#0a0a0c",
      ink: "#f4f4f5",
      accent: "#ccff00",
      fontBody: "Outfit",
      fontDisplay: "Syne",
      radius: "0px",
    };
    const t = portfolio.theme || defaultTheme;
    const safeFontBody = sanitizeFontName(t.fontBody);
    const safeFontDisplay = sanitizeFontName(t.fontDisplay);
    const fontBodyUrl = safeFontBody.replace(/\s+/g, "+");
    const fontDisplayUrl = safeFontDisplay.replace(/\s+/g, "+");

    const safeBg = sanitizeCssValue(t.bg);
    const safeBgSurface = sanitizeCssValue(t.bgSurface);
    const safeInk = sanitizeCssValue(t.ink);
    const safeAccent = sanitizeCssValue(t.accent);
    const safeRadius = sanitizeCssValue(t.radius);

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(portfolio.robloxUsername)} | Bloxfolio</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${fontBodyUrl}:wght@300;400;500;600;700&family=${fontDisplayUrl}:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg: ${safeBg};
  --bg-surface: ${safeBgSurface};
  --ink: ${safeInk};
  --accent: ${safeAccent};
  --border: rgba(255, 255, 255, 0.1);
  --font-body: '${safeFontBody}', ui-sans-serif, system-ui, sans-serif;
  --font-display: '${safeFontDisplay}', sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --radius-sm: ${safeRadius};
  --radius-md: ${safeRadius};
  --radius-lg: ${safeRadius};
}

body::before {
  content: "";
  position: fixed;
  top: 0; left: 0; width: 100vw; height: 100vh;
  pointer-events: none;
  z-index: 9999;
  opacity: 0.04;
  background-image: url("${noiseSvg}");
}

* { box-sizing: border-box; }
body { 
  margin: 0; 
  font-family: var(--font-body); 
  background: var(--bg); 
  color: var(--ink); 
  text-transform: none;
  overflow-x: hidden;
}

h1,h2,h3,h4 { font-family: var(--font-display); font-weight: 700; text-transform: uppercase; margin: 0; }
a { color: inherit; text-decoration: none; }

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2.5rem 4rem;
  border-bottom: 2px solid var(--border);
}
.logo { font-family: var(--font-display); font-weight: 800; font-size: 2rem; color: var(--accent); letter-spacing: -0.05em; text-transform: uppercase; }
.nav { display: flex; gap: 3rem; font-family: var(--font-mono); text-transform: uppercase; font-size: 0.9rem; font-weight: 600; }
.nav a:hover { color: var(--accent); }

.hero {
  min-height: 80vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 4rem;
  border-bottom: 2px solid var(--border);
  background: radial-gradient(circle at 10% 90%, rgba(204,255,0,0.08), transparent 50%);
}
.headline { font-size: clamp(4rem, 10vw, 9rem); line-height: 0.85; letter-spacing: -0.04em; margin-bottom: 2rem; max-width: 1400px; }
.pitch { font-size: clamp(1.5rem, 3vw, 2.5rem); color: #888; line-height: 1.4; max-width: 800px; font-weight: 300; }

.section {
  padding: 8rem 4rem;
  border-bottom: 2px solid var(--border);
  display: grid;
  grid-template-columns: 1fr 3fr;
  gap: 4rem;
}
.section-title { font-size: clamp(2.5rem, 5vw, 4rem); color: var(--accent); position: sticky; top: 4rem; align-self: start; line-height: 1; }

.about { font-size: 1.75rem; line-height: 1.6; max-width: 800px; color: #ddd; font-weight: 300; }

.projects { display: grid; grid-template-columns: 1fr; gap: 4rem; }
.project { background: #000; border: 1px solid rgba(255,255,255,0.2); display: flex; flex-direction: column; transition: all 0.3s; position: relative; overflow: hidden; }
.project:hover { border-color: var(--accent); transform: translateY(-5px); box-shadow: 10px 10px 0 var(--accent); }
.project-image-container { width: 100%; aspect-ratio: 16 / 9; overflow: hidden; border-bottom: 1px solid rgba(255, 255, 255, 0.2); }
.project-image { width: 100%; height: 100%; object-fit: cover; filter: grayscale(100%) contrast(1.2); transition: all 0.5s ease; }
.project:hover .project-image { filter: grayscale(0%) contrast(1); transform: scale(1.05); }
.project-content-wrapper { padding: 4rem; display: flex; flex-direction: column; gap: 2rem; }
.project-meta { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 2rem; }
.project h3 { font-size: 3rem; line-height: 1; }
.stack { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.stack span { font-family: var(--font-mono); font-size: 0.85rem; padding: 0.5rem 1rem; border: 1px solid rgba(255,255,255,0.2); text-transform: uppercase; color: var(--accent); }
.details { display: flex; flex-direction: column; gap: 1.5rem; border-top: 1px dashed rgba(255,255,255,0.2); padding-top: 2rem; }
.summary { font-size: 1.25rem; color: #ccc; line-height: 1.6; }
.impact { font-family: var(--font-mono); font-size: 1.1rem; color: #fff; background: rgba(255,255,255,0.1); padding: 1.5rem; border-left: 4px solid var(--accent); }
.game-link { display: inline-flex; align-items: center; gap: 0.75rem; font-family: var(--font-mono); font-size: 1rem; color: #000; background: var(--accent); padding: 1rem 1.5rem; text-transform: uppercase; text-decoration: none; font-weight: 700; letter-spacing: 0.05em; border: 2px solid var(--accent); transition: all 0.2s; align-self: flex-start; margin-top: 1rem; }
.game-link:hover { background: transparent; color: var(--accent); box-shadow: 4px 4px 0 var(--accent); transform: translate(-2px, -2px); }

.skills { display: flex; flex-wrap: wrap; gap: 1.5rem; }
.skill { font-family: var(--font-display); font-size: 2.5rem; padding: 1.5rem 2.5rem; border: 2px solid rgba(255,255,255,0.2); text-transform: uppercase; }

.extra-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 3rem; }
.extra-block { background: rgba(255,255,255,0.03); padding: 3rem; border: 1px solid rgba(255,255,255,0.1); }
.extra-block h4 { font-size: 2rem; margin-bottom: 1.5rem; color: var(--accent); }
.extra-block p { font-size: 1.1rem; color: #bbb; line-height: 1.7; }

.footer { padding: 10rem 4rem 4rem; background: var(--accent); color: #000; }
.cta { font-size: clamp(3rem, 8vw, 7rem); line-height: 0.9; margin-bottom: 6rem; max-width: 1200px; }
.footer-bottom { display: flex; justify-content: space-between; border-top: 2px solid rgba(0,0,0,0.2); padding-top: 2rem; font-family: var(--font-mono); font-weight: 700; text-transform: uppercase; font-size: 1rem; }

@media (max-width: 900px) {
  .section { grid-template-columns: 1fr; gap: 2rem; }
  .header, .hero, .section, .footer, .project { padding: 2rem; }
}
</style>
</head>
<body>
  <header class="header">
    <div class="logo">PORTFOLIO</div>
    <nav class="nav">
      <a href="#about">About</a>
      <a href="#projects">Work</a>
      <a href="#skills">Expertise</a>
    </nav>
  </header>

  <section class="hero">
    <h1 class="headline">${escapeHtml(portfolio.headline)}</h1>
    <p class="pitch">${escapeHtml(portfolio.elevatorPitch)}</p>
  </section>

  <section id="about" class="section">
    <div class="section-title">01 / About</div>
    <div class="about"><p>${escapeHtml(portfolio.about)}</p></div>
  </section>

  <section id="projects" class="section">
    <div class="section-title">02 / Selected Works</div>
    <div class="projects">
      ${projectsHtml}
    </div>
  </section>

  <section id="skills" class="section">
    <div class="section-title">03 / Expertise</div>
    <div class="skills">${skillsHtml}</div>
  </section>

  ${sectionsHtml}

  <footer class="footer">
    <h2 class="cta">${escapeHtml(portfolio.cta)}</h2>
    <div class="footer-bottom">
      <span>© ${new Date().getFullYear()} ${escapeHtml(portfolio.robloxUsername)}</span>
      <span>Built with Bloxfolio</span>
    </div>
  </footer>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=60",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' https: data:; script-src 'none';",
      },
    });
  }),
});

export default http;
