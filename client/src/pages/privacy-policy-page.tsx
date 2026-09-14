import { FC } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

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
    <div className="min-h-screen bg-background flex justify-center p-4 py-8">
      <Card className="w-full max-w-3xl">
        <CardHeader spacing="tight" padding="standard">
          <div className="flex items-center gap-2 mb-2">
            <Button variant="ghost" size="sm" spacing="tight" onClick={handleBack}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
          </div>
          <CardTitle size="2xl" weight="bold">Privacy Policy</CardTitle>
          <p className="text-sm text-muted-foreground">Last updated: March 30, 2026</p>
        </CardHeader>
        <CardContent spacing="loose" typography="prose" className="max-w-none">
          <section>
            <h3 className="text-lg font-semibold mb-2">1. Introduction</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              LeagueVault ("we," "our," or "us") is a bowling league management platform. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our web application, mobile application, and related services (collectively, the "Service"). By using the Service, you agree to the collection and use of information in accordance with this policy.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">2. Information We Collect</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-2">
              We collect the following types of information:
            </p>
            <h4 className="text-sm font-semibold mb-1">Personal Information</h4>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
              <li>Full name</li>
              <li>Email address</li>
              <li>Phone number</li>
              <li>Profile photo (optional)</li>
              <li>League and team membership information</li>
              <li>Bowling scores and performance data</li>
            </ul>
            <h4 className="text-sm font-semibold mt-3 mb-1">Payment Information</h4>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
              <li>Payment card details are processed securely by Square, Inc. and are never stored on our servers</li>
              <li>Transaction history, payment amounts, and payment schedules</li>
              <li>Square customer identifiers for recurring payment functionality</li>
            </ul>
            <h4 className="text-sm font-semibold mt-3 mb-1">Automatically Collected Information</h4>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
              <li>Device type and operating system</li>
              <li>Browser type and version</li>
              <li>IP address</li>
              <li>Usage patterns and feature interactions</li>
              <li>Error and crash reports</li>
            </ul>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">3. How We Use Your Information</h3>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
              <li>To provide and maintain the Service, including league management, team rosters, and score tracking</li>
              <li>To process payments and manage payment schedules through Square</li>
              <li>To send transactional emails such as registration invitations, payment confirmations, and account notifications</li>
              <li>To authenticate your identity and manage your account</li>
              <li>To improve the Service through error tracking and usage analytics</li>
              <li>To respond to your inquiries and provide customer support</li>
            </ul>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">4. Third-Party Services</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-2">
              We use the following third-party services to operate the platform:
            </p>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-2">
              <li>
                <span className="font-medium text-foreground">Square, Inc.</span>: Processes credit card payments, manages saved cards on file, and handles Apple Pay and Google Pay transactions. Square's privacy policy applies to payment data they process.
              </li>
              <li>
                <span className="font-medium text-foreground">SendGrid (Twilio)</span>: Delivers transactional emails including registration invitations, welcome messages, and account notifications.
              </li>
              <li>
                <span className="font-medium text-foreground">Sentry</span>: Monitors application errors and performance to help us maintain service reliability. Sentry may receive technical data such as error messages, stack traces, and device information.
              </li>
            </ul>
            <p className="text-sm text-muted-foreground leading-relaxed mt-2">
              Each third-party service operates under its own privacy policy. We encourage you to review those policies for more information on how they handle your data.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">5. Data Security</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We implement appropriate technical and organizational measures to protect your personal information. These include encrypted data transmission (HTTPS/TLS), secure session management, hashed passwords, and access controls. Payment card data is handled entirely by Square and is never stored on our servers. However, no method of electronic transmission or storage is 100% secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">6. Data Retention</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We retain your personal information for as long as your account is active or as needed to provide the Service. League and payment records may be retained for accounting, legal, and operational purposes. If you wish to have your data deleted, please contact us using the information below.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">7. Your Rights</h3>
            <p className="text-sm text-muted-foreground leading-relaxed mb-2">
              Depending on your jurisdiction, you may have the following rights regarding your personal data:
            </p>
            <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-1">
              <li>Access the personal information we hold about you</li>
              <li>Request correction of inaccurate or incomplete data</li>
              <li>Request deletion of your personal data</li>
              <li>Object to or restrict the processing of your data</li>
              <li>Request a copy of your data in a portable format</li>
            </ul>
            <p className="text-sm text-muted-foreground leading-relaxed mt-2">
              To exercise any of these rights, please contact us using the information provided below.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">8. Children's Privacy</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The Service is not intended for use by children under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected data from a child under 13, we will take steps to delete that information promptly.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">9. Changes to This Policy</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We may update this Privacy Policy from time to time. We will notify you of any material changes by posting the updated policy on this page and updating the "Last updated" date. Your continued use of the Service after any changes constitutes your acceptance of the updated policy.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold mb-2">10. Contact Us</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you have any questions or concerns about this Privacy Policy or our data practices, please contact us at:
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              <span className="font-medium text-foreground">Email:</span> support@leaguevault.app
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
};

export default PrivacyPolicyPage;
