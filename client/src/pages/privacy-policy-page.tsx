import { FC } from "react";
import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { PublicPageLayout } from "@/components/public-page-layout";

const PrivacyPolicyPage: FC = () => {
  const [, setLocation] = useLocation();

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation("/login");
    }
  };

  return (
    <PublicPageLayout wide topAligned>
      <article className="public-flow-card">
        <button type="button" className="public-flow-link mb-7" onClick={handleBack}>
          <ArrowLeft className="size-3.5" />
          Back
        </button>

        <p className="public-flow-eyebrow">Your information</p>
        <h1 className="public-flow-title">Privacy Policy</h1>
        <p className="public-flow-date">Last updated: March 30, 2026</p>

        <div className="my-7 border-y border-navigation-200 py-6">
          <p className="public-flow-description mb-0">
            How we handle your information when you use LeagueVault.
          </p>
        </div>

        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              1. Introduction
            </h2>
            <p className="text-sm leading-relaxed text-navigation-600">
              LeagueVault ("we," "our," or "us") is a bowling league management platform. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our web application, mobile application, and related services (collectively, the "Service"). By using the Service, you agree to the collection and use of information in accordance with this policy.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              2. Information We Collect
            </h2>
            <p className="mb-3 text-sm leading-relaxed text-navigation-600">
              We collect the following types of information:
            </p>
            <h3 className="mb-2 text-sm font-semibold text-navigation-800">Personal Information</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-navigation-600">
              <li>Full name</li>
              <li>Email address</li>
              <li>Phone number</li>
              <li>Profile photo (optional)</li>
              <li>League and team membership information</li>
              <li>Bowling scores and performance data</li>
            </ul>
            <h3 className="mb-2 mt-5 text-sm font-semibold text-navigation-800">Payment Information</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-navigation-600">
              <li>Payment card details are processed securely by Square, Inc. and are never stored on our servers</li>
              <li>Transaction history, payment amounts, and payment schedules</li>
              <li>Square customer identifiers for recurring payment functionality</li>
            </ul>
            <h3 className="mb-2 mt-5 text-sm font-semibold text-navigation-800">Automatically Collected Information</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-navigation-600">
              <li>Device type and operating system</li>
              <li>Browser type and version</li>
              <li>IP address</li>
              <li>Usage patterns and feature interactions</li>
              <li>Error and crash reports</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              3. How We Use Your Information
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-navigation-600">
              <li>To provide and maintain the Service, including league management, team rosters, and score tracking</li>
              <li>To process payments and manage payment schedules through Square</li>
              <li>To send transactional emails such as registration invitations, payment confirmations, and account notifications</li>
              <li>To authenticate your identity and manage your account</li>
              <li>To improve the Service through error tracking and usage analytics</li>
              <li>To respond to your inquiries and provide customer support</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              4. Third-Party Services
            </h2>
            <p className="mb-3 text-sm leading-relaxed text-navigation-600">
              We use the following third-party services to operate the platform:
            </p>
            <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-navigation-600">
              <li>
                <span className="font-semibold text-navigation-800">Square, Inc.</span>: Processes credit card payments, manages saved cards on file, and handles Apple Pay and Google Pay transactions. Square's privacy policy applies to payment data they process.
              </li>
              <li>
                <span className="font-semibold text-navigation-800">SendGrid (Twilio)</span>: Delivers transactional emails including registration invitations, welcome messages, and account notifications.
              </li>
              <li>
                <span className="font-semibold text-navigation-800">Sentry</span>: Monitors application errors and performance to help us maintain service reliability. Sentry may receive technical data such as error messages, stack traces, and device information.
              </li>
            </ul>
            <p className="mt-3 text-sm leading-relaxed text-navigation-600">
              Each third-party service operates under its own privacy policy. We encourage you to review those policies for more information on how they handle your data.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              5. Data Security
            </h2>
            <p className="text-sm leading-relaxed text-navigation-600">
              We implement appropriate technical and organizational measures to protect your personal information. These include encrypted data transmission (HTTPS/TLS), secure session management, hashed passwords, and access controls. Payment card data is handled entirely by Square and is never stored on our servers. However, no method of electronic transmission or storage is 100% secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              6. Data Retention
            </h2>
            <p className="text-sm leading-relaxed text-navigation-600">
              We retain your personal information for as long as your account is active or as needed to provide the Service. League and payment records may be retained for accounting, legal, and operational purposes. If you wish to have your data deleted, please contact us using the information below.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              7. Your Rights
            </h2>
            <p className="mb-3 text-sm leading-relaxed text-navigation-600">
              Depending on your jurisdiction, you may have the following rights regarding your personal data:
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-navigation-600">
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate or incomplete data</li>
              <li>Request deletion of your personal data</li>
              <li>Object to or restrict the processing of your data</li>
              <li>Request a copy of your data in a portable format</li>
            </ul>
            <p className="mt-3 text-sm leading-relaxed text-navigation-600">
              To exercise any of these rights, please contact us using the information provided below.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              8. Children's Privacy
            </h2>
            <p className="text-sm leading-relaxed text-navigation-600">
              The Service is not intended for use by children under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected data from a child under 13, we will take steps to delete that information promptly.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              9. Changes to This Policy
            </h2>
            <p className="text-sm leading-relaxed text-navigation-600">
              We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the updated policy on this page and updating the "Last updated" date. Your continued use of the Service after any changes constitutes your acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-lg font-semibold leading-tight tracking-tight text-navigation-800">
              10. Contact Us
            </h2>
            <p className="text-sm leading-relaxed text-navigation-600">
              If you have any questions or concerns about this Privacy Policy or our data practices, please contact us at:
            </p>
            <p className="mt-3 text-sm text-navigation-600">
              <span className="font-semibold text-navigation-800">Email:</span> support@leaguevault.app
            </p>
          </section>
        </div>
      </article>
    </PublicPageLayout>
  );
};

export default PrivacyPolicyPage;
