import { ArrowRight } from 'lucide-react';
import { Link } from 'wouter';
import { PublicPageLayout } from '@/components/public-page-layout';

export default function WelcomePage() {
  return (
    <PublicPageLayout welcome>
      <section aria-labelledby="welcome-title" className="public-flow-welcome">
        <h1 id="welcome-title" className="sr-only">Welcome to Perfect Game</h1>
        <div className="public-flow-welcome-actions">
          <Link href="/register" className="public-flow-primary">
            I Need to Register <ArrowRight size={18} aria-hidden="true" />
          </Link>
          <Link href="/login" className="public-flow-secondary">I Have an Account</Link>
        </div>
      </section>
    </PublicPageLayout>
  );
}
