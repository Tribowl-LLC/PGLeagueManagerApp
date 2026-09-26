function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type ResultTone = "success" | "declined" | "error";

export function renderPage(opts: {
  status: number;
  title: string;
  heading: string;
  message: string;
  appUrl?: string | null;
  tone?: ResultTone;
}): { status: number; html: string } {
  const safeTitle = escapeHtml(opts.title);
  const safeHeading = escapeHtml(opts.heading);
  const safeMessage = escapeHtml(opts.message);
  const tone = opts.tone ?? (opts.status >= 200 && opts.status < 300 ? "success" : "error");
  const stateLabel = tone === "success" ? "Success" : tone === "declined" ? "Declined" : "Needs attention";
  const stateIcon =
    tone === "success"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>'
      : tone === "declined"
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.5v5M12 16.5h.01" /><path d="M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3l-7.5-13.1a2 2 0 0 0-3.4 0Z" /></svg>';
  const cta = opts.appUrl
    ? `<a class="result-primary" href="${escapeHtml(opts.appUrl)}">Open in app</a>`
    : "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      @font-face {
        font-family: "Instrument Sans";
        src: url("/fonts/instrument-sans-variable.ttf") format("truetype");
        font-style: normal;
        font-weight: 400 700;
        font-display: swap;
      }

      :root {
        --result-navy: #0f172a;
        --result-ink: #17253b;
        --result-muted: #52647a;
        --result-canvas: #f8fafc;
        --result-line: #e2e8f0;
        --result-success: #166641;
        --result-success-surface: #e5f4eb;
        --result-declined: #8e392f;
        --result-declined-surface: #f9eae7;
        --result-error: #855d16;
        --result-error-surface: #fff7df;
      }

      *, *::before, *::after { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        background: #fff;
        color: var(--result-ink);
        font-family: "Instrument Sans", ui-sans-serif, system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      a:focus-visible {
        outline: 3px solid #4d7db6;
        outline-offset: 3px;
      }
      .result-layout {
        display: grid;
        grid-template-columns: 40% 60%;
        min-height: 100dvh;
        max-width: 1256px;
        margin: 0 auto;
        overflow: hidden;
        border-radius: 14px;
        box-shadow: 0 14px 42px rgb(15 23 42 / .08);
      }
      .result-story {
        display: flex;
        flex-direction: column;
        min-width: 0;
        padding: 48px;
        background: var(--result-navy);
        color: #fff;
      }
      .result-brand {
        width: fit-content;
        color: #fff;
        font-size: 27px;
        font-weight: 650;
        letter-spacing: -.02em;
        line-height: 1.1;
      }
      .result-brand-mobile { display: none; }
      .result-brand-mobile img {
        display: block;
        width: min(210px, 100%);
        height: auto;
      }
      .result-story-copy {
        max-width: 345px;
        margin: auto 0;
        padding: 64px 0;
      }
      .result-story-copy h2 {
        max-width: 330px;
        margin: 0;
        font-size: clamp(34px, 3vw, 40px);
        font-weight: 600;
        letter-spacing: -.025em;
        line-height: 1.18;
      }
      .result-story-copy p {
        max-width: 320px;
        margin: 23px 0 0;
        color: #d6e1ef;
        font-size: 15px;
        line-height: 1.7;
      }
      .result-main {
        display: grid;
        align-items: center;
        min-width: 0;
        padding: 42px 36px;
        background: var(--result-canvas);
      }
      .result-card {
        width: 100%;
        max-width: 448px;
        margin: auto;
        padding: 38px 40px;
        border: 1px solid var(--result-line);
        border-radius: 12px;
        background: #fff;
        box-shadow: 0 5px 20px rgb(15 23 42 / .035);
        animation: result-arrive 260ms cubic-bezier(.22, 1, .36, 1) both;
      }
      .result-state {
        display: grid;
        place-items: center;
        width: 48px;
        height: 48px;
        margin-bottom: 19px;
        border-radius: 50%;
      }
      .result-state svg {
        width: 25px;
        height: 25px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.9;
      }
      .result-state-success { background: var(--result-success-surface); color: var(--result-success); }
      .result-state-declined { background: var(--result-declined-surface); color: var(--result-declined); }
      .result-state-error { background: var(--result-error-surface); color: var(--result-error); }
      .result-state-label {
        margin: 0 0 11px;
        color: var(--result-muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: .12em;
        line-height: 1.4;
        text-transform: uppercase;
      }
      .result-title {
        max-width: 390px;
        margin: 0 0 12px;
        color: var(--result-ink);
        font-size: clamp(28px, 2.4vw, 31px);
        font-weight: 600;
        letter-spacing: -.025em;
        line-height: 1.2;
      }
      .result-message {
        max-width: 65ch;
        margin: 0;
        color: var(--result-muted);
        font-size: 15px;
        line-height: 1.6;
      }
      .result-actions { margin-top: 26px; }
      .result-primary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-height: 50px;
        padding: 12px 18px;
        border: 1px solid var(--result-navy);
        border-radius: 8px;
        background: var(--result-navy);
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.4;
        text-decoration: none;
        transition: background 180ms ease, box-shadow 180ms ease, transform 180ms ease;
      }
      .result-primary:hover { background: #1e3555; box-shadow: 0 5px 15px rgb(15 23 42 / .14); }
      .result-primary:active { transform: translateY(1px); }
      .result-footer {
        margin: 32px 0 0;
        color: var(--result-muted);
        font-size: 12px;
        line-height: 1.5;
        text-align: center;
      }
      @keyframes result-arrive {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (max-width: 800px) {
        .result-layout {
          display: block;
          min-height: 100dvh;
          margin: 0;
          border-radius: 0;
          box-shadow: none;
        }
        .result-story {
          align-items: center;
          justify-content: center;
          min-height: 76px;
          padding: 12px 22px;
        }
        .result-brand {
          display: flex;
          justify-content: center;
          width: 100%;
          font-size: 25px;
        }
        .result-brand-desktop { display: none; }
        .result-brand-mobile {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
        }
        .result-story-copy { display: none; }
        .result-main {
          min-height: calc(100dvh - 76px);
          padding: 30px 18px 44px;
          align-items: start;
        }
        .result-card { max-width: 460px; padding: 30px 26px; }
      }
      @media (max-width: 400px) {
        .result-main { padding: 24px 14px 38px; }
        .result-card { padding: 28px 22px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .result-card { animation: none; }
        .result-primary { transition: none; }
      }
    </style>
  </head>
  <body>
    <div class="result-layout">
      <aside class="result-story">
        <div class="result-brand">
          <span class="result-brand-desktop">League Manager</span>
          <span class="result-brand-mobile"><img src="/perfect-game-dark-logo.png" alt="Perfect Game"></span>
        </div>
        <div class="result-story-copy">
          <h2>League payments, simplified.</h2>
          <p>Make payments and track your history all in one place.</p>
        </div>
      </aside>
      <main class="result-main">
        <section class="result-card" aria-labelledby="result-title">
          <div class="result-state result-state-${tone}" role="img" aria-label="${escapeHtml(stateLabel)}">${stateIcon}</div>
          <p class="result-state-label">${escapeHtml(stateLabel)}</p>
          <h1 class="result-title" id="result-title">${safeHeading}</h1>
          <p class="result-message">${safeMessage}</p>
          ${cta ? `<div class="result-actions">${cta}</div>` : ""}
          <p class="result-footer">Powered by LeagueVault</p>
        </section>
      </main>
    </div>
  </body>
</html>`;
  return { status: opts.status, html };
}
