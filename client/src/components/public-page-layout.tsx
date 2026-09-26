import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { useBusinessContext } from '@/hooks/use-business-context';
import './public-page-layout.css';

type PublicPageLayoutProps = {
  children: ReactNode;
  welcome?: boolean;
  wide?: boolean;
  topAligned?: boolean;
};

/** The shared Familiar A shell for pages available without a login session. */
export function PublicPageLayout({ children, welcome = false, wide = false, topAligned = false }: PublicPageLayoutProps) {
  const { business } = useBusinessContext();
  const logo = business?.logo || '/perfect-game-logo.png';
  const darkLogo = business?.darkLogo || '/perfect-game-dark-logo.png';

  return (
    <div data-public-flow>
      <div className="public-flow-layout">
        <aside className="public-flow-story">
          <Link href="/sign-up" className="public-flow-wordmark" aria-label="League Manager welcome">
            <span className="public-flow-wordmark-desktop">League Manager</span>
            <span className="public-flow-wordmark-mobile">
              {welcome ? 'League Manager' : <img src={darkLogo} alt="Perfect Game" />}
            </span>
          </Link>
          <div className="public-flow-story-copy">
            <h2>League payments, simplified.</h2>
            <p>Make payments and track your history all in one place.</p>
          </div>
        </aside>
        <main className={`public-flow-main${welcome ? ' public-flow-main-welcome' : ''}${topAligned ? ' public-flow-main-top' : ''}`}>
          <div className={`public-flow-main-inner${wide ? ' public-flow-main-inner-wide' : ''}`}>
            {welcome ? <div className="public-flow-welcome-logo"><img src={logo} alt="Perfect Game" /></div> : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export function PublicProgress({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="public-flow-progress" aria-label={`Registration step ${step} of 3`}>
      <span>Step {step} of 3</span>
      <div aria-hidden="true">{[1, 2, 3].map(number => <i key={number} className={number <= step ? 'is-filled' : ''} />)}</div>
    </div>
  );
}
