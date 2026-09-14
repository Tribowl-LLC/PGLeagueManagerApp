import { FC, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Trash2, Loader2, CheckCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
    } catch (error) {
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
      <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
        <Card className="w-full max-w-md mt-4 sm:mt-0">
          <CardHeader spacing="relaxed" className="text-center">
            <div className="flex justify-center">
              <CheckCircle className="size-12 text-success-500" />
            </div>
            <CardTitle size="xl">Request Received</CardTitle>
            <CardDescription>
              Your account deletion request has been submitted. If an account exists with the provided email, we will process your request within 30 days.{" "}
              {notifyOnCompletion
                ? "You will receive a confirmation email once your account and associated data have been deleted."
                : "Per your request, we will not send a confirmation email when your data is deleted."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button variant="outline" onClick={() => setLocation("/login")}>
              Return to Login
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-start sm:items-center justify-center p-4 pt-6 sm:pt-4">
      <Card className="w-full max-w-md mt-4 sm:mt-0">
        <CardHeader spacing="tight" padding="standard">
          <div className="flex items-center gap-2 mb-2">
            <Button variant="ghost" size="sm" spacing="tight" onClick={handleBack}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
          </div>
          <CardTitle size="xl" weight="bold" iconSpacing>
            <Trash2 className="size-5 text-destructive" />
            Request Account Deletion
          </CardTitle>
          <CardDescription>
            Submit a request to permanently delete your LeagueVault account and all associated data. This action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                placeholder="Enter your account email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                Enter the email address associated with your account.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="reason">Reason (optional)</Label>
              <Textarea
                id="reason"
                placeholder="Let us know why you'd like to delete your account"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
            </div>

            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <p className="font-medium mb-1">What will be deleted:</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>Your user account and login credentials</li>
                <li>Profile information and avatar</li>
                <li>Payment history and saved cards</li>
                <li>Bowler profile linkage</li>
              </ul>
            </div>

            <div className="flex items-start gap-2 rounded-md border border-input p-3">
              <Checkbox
                id="notify-on-completion"
                checked={notifyOnCompletion}
                onCheckedChange={(checked) =>
                  setNotifyOnCompletion(checked === true)
                }
                className="mt-0.5"
              />
              <div className="space-y-1">
                <Label
                  htmlFor="notify-on-completion"
                  className="cursor-pointer"
                >
                  Email me a confirmation when my data is deleted
                </Label>
                <p className="text-xs text-muted-foreground">
                  Uncheck this if you do not want any further email at this
                  address, for example if it has been compromised, or if
                  you no longer have access to it. We will still process the
                  deletion either way.
                </p>
              </div>
            </div>

            <Button
              type="submit"
              variant="destructive"
              className="w-full"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin mr-2" />
                  Submitting…
                </>
              ) : (
                "Submit Deletion Request"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};

export default DeleteAccountPage;
