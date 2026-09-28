import { FileQuestion, Home, LogIn } from "lucide-react";
import { Link } from "wouter";
import { PublicPageLayout } from "@/components/public-page-layout";

export default function NotFound() {
  return (
    <PublicPageLayout>
      <article className="public-flow-card">
        <div className="public-flow-icon"><FileQuestion className="size-6" aria-hidden="true" /></div>
        <p className="public-flow-eyebrow">Page not found</p>
        <h1 className="public-flow-title">We couldn’t find that page.</h1>
        <p className="public-flow-description">The link may be out of date, or the page may have moved. Choose a place to continue.</p>
        <div className="public-flow-actions-stack">
          <Link href="/sign-up" className="public-flow-primary"><Home className="size-4" aria-hidden="true" />Go to home</Link>
          <Link href="/login" className="public-flow-secondary"><LogIn className="size-4" aria-hidden="true" />Sign in</Link>
        </div>
      </article>
    </PublicPageLayout>
  );
}
