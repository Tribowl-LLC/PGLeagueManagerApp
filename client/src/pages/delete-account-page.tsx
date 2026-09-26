import { FC, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, CheckCircle, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PublicPageLayout } from "@/components/public-page-layout";

const DeleteAccountPage: FC = () => {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  // Task #349: requester can opt out of the post-deletion confirmation
  // email. Default true so the existing GDPR/CCPA "we confirm we
  // deleted your data" flow keeps working unless the user explicitly
  // turns it off (e.g. harassment victims who do not want any further
  // contact at the address being scrubbed).
  const [notifyOnCompletion, setNotifyOnCompletion] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      setLocation("/login");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email.trim()) {
      toast({
        title: "Email required",
        description: "Please enter the email address associated with your account.",
        variant: "destructive",
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/account/request-deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          reason: reason.trim(),
          notifyOnCompletion,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || "Failed to submit request");
      }

      setIsSubmitted(true);
    } catch {
      toast({
        title: "Request submitted",
        description: "If an account exists with this email, your deletion request has been recorded.",
        variant: "default",
      });
      setIsSubmitted(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
    return (
      <PublicPageLayout>
        <article className="public-flow-card text-center">
          <div className="public-flow-icon public-flow-icon-success mx-auto">
            <CheckCircle className="size-6" />
          </div>
          <p className="public-flow-eyebrow">Account deletion</p>
          <h1 className="public-flow-title mx-auto">Request received.</h1>
          <p className="public-flow-description">
            Your account deletion request has been submitted. If an account exists with the provided email, we will process your request within 30 days.{" "}
            {notifyOnCompletion
              ? "After processing, we will request a confirmation email. Delivery may vary."
              : "Per your request, we will not request a confirmation email after processing."}
          </p>
          <button type="button" className="public-flow-secondary" onClick={() => setLocation("/login")}>
            Return to Login
          </button>
        </article>
      </PublicPageLayout>
    );
  }

  return (
    <PublicPageLayout topAligned>
      <article className="public-flow-card">
        <button type="button" className="public-flow-link mb-7" onClick={handleBack}>
          <ArrowLeft className="size-3.5" />
          Back
        </button>

        <div className="public-flow-icon public-flow-icon-danger">
          <Trash2 className="size-6" />
        </div>
        <p className="public-flow-eyebrow">Account deletion</p>
        <h1 className="public-flow-title">Request account deletion.</h1>
        <p className="public-flow-description">
          Submit a request to permanently delete your LeagueVault account and all associated data. This action cannot be undone.
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email">Email address</Label>
            <Input
              id="email"
              type="email"
              placeholder="Enter your account email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <p className="text-xs leading-relaxed text-navigation-600">
              Use the email address associated with your account.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reason">Reason <span className="font-normal text-navigation-600">(optional)</span></Label>
            <Textarea
              id="reason"
              placeholder="Tell us why you’d like to delete your account"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>

          <div className="public-flow-inset public-flow-inset-danger">
            <strong>What will be deleted</strong>
            <ul className="list-disc space-y-1 pl-4">
              <li>Your user account and login credentials</li>
              <li>Profile information and avatar</li>
              <li>Payment history and saved cards</li>
              <li>Bowler profile linkage</li>
            </ul>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-navigation-200 p-4">
            <Checkbox
              id="notify-on-completion"
              checked={notifyOnCompletion}
              onCheckedChange={(checked) => setNotifyOnCompletion(checked === true)}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor="notify-on-completion" className="cursor-pointer">
                Email me a confirmation when my data is deleted
              </Label>
              <p className="text-xs leading-relaxed text-navigation-600">
                Uncheck this if you do not want any further email at this address, for example if it has been compromised, or if you no longer have access to it. We will still process the deletion either way.
              </p>
            </div>
          </div>

          <button type="submit" className="public-flow-primary" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Submitting…
              </>
            ) : (
              <>
                Submit deletion request
                <ArrowRight className="size-4" />
              </>
            )}
          </button>
        </form>
      </article>
    </PublicPageLayout>
  );
};

export default DeleteAccountPage;
