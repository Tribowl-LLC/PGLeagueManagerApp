import type { Dispatch, SetStateAction } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Mail, Eye, EyeOff, Info, Send, Building2 } from "lucide-react";
import type { EmailTemplate, Organization, ApiResponse } from "@shared/schema";

const TEMPLATE_VARIABLES = [
  { name: "{{inviter_name}}", description: "The person who sent a payment-partner invitation" },
  { name: "{{invitee_name}}", description: "The person receiving a payment-partner invitation" },
  { name: "{{bowler_name}}", description: "The bowler's name (for bowler invite emails)" },
  { name: "{{admin_name}}", description: "The administrator's name (for org admin invite emails)" },
  { name: "{{user_name}}", description: "The end user's name (for org end user invite emails)" },
  { name: "{{organization_name}}", description: "The organization name" },
  { name: "{{organization_logo_url}}", description: "The organization's logo URL" },
  { name: "{{league_name}}", description: "The league name (if applicable)" },
  { name: "{{amount}}", description: "The payment amount, formatted as currency" },
  { name: "{{receipt_number}}", description: "The payment receipt number" },
  { name: "{{receipt_label}}", description: "The optional formatted receipt-number suffix" },
  { name: "{{receipt_url}}", description: "The Square-hosted receipt URL" },
  { name: "{{invite_link}}", description: "The password setup link (for invite emails)" },
  { name: "{{reset_link}}", description: "The password reset link" },
  { name: "{{register_link}}", description: "The account registration link" },
  { name: "{{confirm_link}}", description: "The email-change confirmation link" },
  { name: "{{login_link}}", description: "Link to the login page" },
  { name: "{{dashboard_link}}", description: "Link to the bowler dashboard" },
  { name: "{{accept_link}}", description: "Payment-partner invitation acceptance link" },
  { name: "{{decline_link}}", description: "Payment-partner invitation decline link" },
  { name: "{{app_link}}", description: "Link back to the LeagueVault app" },
  { name: "{{support_link}}", description: "Link to LeagueVault support" },
  { name: "{{forgot_link}}", description: "Link to the forgot-password page" },
  { name: "{{edit_link}}", description: "Link to edit the affected league" },
  { name: "{{review_link}}", description: "Link to the relevant administrator page" },
  { name: "{{new_email_masked}}", description: "The masked replacement email address" },
  { name: "{{subject}}", description: "The locale-resolved security-email subject" },
  { name: "{{greeting}}", description: "The locale-resolved greeting" },
  { name: "{{intro}}", description: "The locale-resolved security-email introduction" },
  { name: "{{performed_by_admin}}", description: "Administrator-change notice, when applicable" },
  { name: "{{when_label}}", description: "Localized label for the event timestamp" },
  { name: "{{changed_at}}", description: "When the password was changed" },
  { name: "{{locked_at}}", description: "When the account lockout began" },
  { name: "{{unlocks_at_label}}", description: "Localized label for the lockout expiry" },
  { name: "{{unlocks_at}}", description: "When the account lockout ends" },
  { name: "{{from_ip_label}}", description: "Localized IP-address label" },
  { name: "{{ip_address}}", description: "The coarse request IP address" },
  { name: "{{browser_label}}", description: "Localized browser label" },
  { name: "{{user_agent}}", description: "The truncated browser user-agent" },
  { name: "{{if_this_was_you}}", description: "Locale-resolved security confirmation text" },
  { name: "{{if_this_wasnt_you}}", description: "Locale-resolved suspicious-activity text" },
  { name: "{{reset_cta}}", description: "Localized password-reset button text" },
  { name: "{{footer}}", description: "Locale-resolved security-email footer" },
  { name: "{{email}}", description: "The account email address" },
  { name: "{{executed_at}}", description: "When account deletion was processed" },
  { name: "{{bowlers_anonymized}}", description: "Number of bowler records anonymized" },
  { name: "{{account_status}}", description: "Whether the login account was deleted" },
  { name: "{{payment_records_deleted}}", description: "Number of payment records removed" },
  { name: "{{email_change_requests_deleted}}", description: "Number of pending email-change requests removed" },
  { name: "{{request_email}}", description: "Email address from an account-deletion request" },
  { name: "{{created_at}}", description: "When an account-deletion request was submitted" },
  { name: "{{reason}}", description: "The account-deletion request reason" },
  { name: "{{item_count}}", description: "Number of recovered or affected items" },
  { name: "{{job_ids}}", description: "Affected Apple Pay job IDs" },
  { name: "{{item_ids}}", description: "Affected Apple Pay item IDs" },
  { name: "{{suppressed_line}}", description: "Optional rate-limit summary for an operational alert" },
  { name: "{{organization_id}}", description: "The affected organization ID" },
  { name: "{{location_id}}", description: "The affected Square location ID" },
  { name: "{{context}}", description: "The LeagueVault call site that raised an alert" },
  { name: "{{missing_items}}", description: "Rows describing missing Square catalog items" },
];

const SAMPLE_DATA: Record<string, string> = {
  "{{bowler_name}}": "John Smith",
  "{{inviter_name}}": "Jane Bowler",
  "{{invitee_name}}": "John Smith",
  "{{admin_name}}": "Jane Admin",
  "{{user_name}}": "Alex User",
  "{{organization_name}}": "Perfect Game Bowling",
  "{{organization_logo_url}}": "https://example.com/logo.png",
  "{{league_name}}": "Wednesday Night Mixed",
  "{{amount}}": "$42.00",
  "{{receipt_number}}": "R-10042",
  "{{receipt_label}}": " (receipt #R-10042)",
  "{{receipt_url}}": "https://squareup.com/receipt/example",
  "{{invite_link}}": "https://leaguevault.com/set-password?token=abc123",
  "{{reset_link}}": "https://leaguevault.com/set-password?token=reset123",
  "{{register_link}}": "https://leaguevault.com/sign-up",
  "{{confirm_link}}": "https://leaguevault.com/confirm-email?token=abc123",
  "{{login_link}}": "https://leaguevault.com/login",
  "{{dashboard_link}}": "https://leaguevault.com/bowler-dashboard",
  "{{accept_link}}": "https://leaguevault.com/api/bowler-link-respond/accept?token=abc123",
  "{{decline_link}}": "https://leaguevault.com/api/bowler-link-respond/decline?token=abc123",
  "{{app_link}}": "https://leaguevault.com/bowler-dashboard",
  "{{support_link}}": "https://leaguevault.com/support",
  "{{forgot_link}}": "https://leaguevault.com/forgot-password",
  "{{edit_link}}": "https://leaguevault.com/leagues?editLeague=42",
  "{{review_link}}": "https://leaguevault.com/admin/deletion-requests",
  "{{new_email_masked}}": "j***@example.com",
  "{{subject}}": "Your LeagueVault security notice",
  "{{greeting}}": "Hi Alex User,",
  "{{intro}}": "Your LeagueVault security notice is ready.",
  "{{performed_by_admin}}": "This change was performed by an administrator on your account.",
  "{{when_label}}": "When",
  "{{changed_at}}": "Fri, 24 Apr 2026 15:00:00 GMT",
  "{{locked_at}}": "Fri, 24 Apr 2026 15:00:00 GMT",
  "{{unlocks_at_label}}": "Lock lifts at",
  "{{unlocks_at}}": "Fri, 24 Apr 2026 15:15:00 GMT",
  "{{from_ip_label}}": "From IP",
  "{{ip_address}}": "203.0.113.9",
  "{{browser_label}}": "Browser",
  "{{user_agent}}": "Mozilla/5.0",
  "{{if_this_was_you}}": "If this was you, no action is needed.",
  "{{if_this_wasnt_you}}": "If this wasn't you, contact support immediately.",
  "{{reset_cta}}": "Reset your password",
  "{{footer}}": "Powered by LeagueVault",
  "{{email}}": "alex@example.com",
  "{{executed_at}}": "Fri, 24 Apr 2026 15:00:00 GMT",
  "{{bowlers_anonymized}}": "3",
  "{{account_status}}": "Your LeagueVault login account was deleted.",
  "{{payment_records_deleted}}": "1",
  "{{email_change_requests_deleted}}": "0",
  "{{request_email}}": "alex@example.com",
  "{{created_at}}": "Fri, 24 Apr 2026 15:00:00 GMT",
  "{{reason}}": "No longer using the service",
  "{{item_count}}": "2",
  "{{job_ids}}": "101, 102",
  "{{item_ids}}": "2001, 2002",
  "{{suppressed_line}}": "",
  "{{organization_id}}": "7",
  "{{location_id}}": "42",
  "{{context}}": "catalog sync",
  "{{missing_items}}": "Lineage: Weekly Lineage (variation-1)",
};

function replaceVariables(text: string, data: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(data)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

type UpdateMutation = UseMutationResult<
  unknown,
  Error,
  { id: number; data: { subject?: string; body?: string; active?: boolean } },
  unknown
>;

type SendTestMutation = UseMutationResult<
  unknown,
  Error,
  { id: number; toEmail: string; organizationId?: string },
  unknown
>;

interface EmailTemplateEditDialogProps {
  editingTemplate: EmailTemplate | null;
  setEditingTemplate: Dispatch<SetStateAction<EmailTemplate | null>>;
  editSubject: string;
  setEditSubject: Dispatch<SetStateAction<string>>;
  editBody: string;
  setEditBody: Dispatch<SetStateAction<string>>;
  editActive: boolean;
  setEditActive: Dispatch<SetStateAction<boolean>>;
  showPreview: boolean;
  setShowPreview: Dispatch<SetStateAction<boolean>>;
  testEmail: string;
  setTestEmail: Dispatch<SetStateAction<string>>;
  testOrgId: string;
  setTestOrgId: Dispatch<SetStateAction<string>>;
  orgsResponse: ApiResponse<Organization[]> | undefined;
  sendTestMutation: SendTestMutation;
  updateMutation: UpdateMutation;
  handleSave: () => void;
}

export function EmailTemplateEditDialog({
  editingTemplate,
  setEditingTemplate,
  editSubject,
  setEditSubject,
  editBody,
  setEditBody,
  editActive,
  setEditActive,
  showPreview,
  setShowPreview,
  testEmail,
  setTestEmail,
  testOrgId,
  setTestOrgId,
  orgsResponse,
  sendTestMutation,
  updateMutation,
  handleSave,
}: EmailTemplateEditDialogProps) {
  return (
    <Dialog open={!!editingTemplate} onOpenChange={(open) => { if (!open) setEditingTemplate(null); }}>
      <DialogContent viewport="dialog" className="max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle iconSpacing>
            <Mail className="size-5" />
            Edit: {editingTemplate?.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label htmlFor="active-toggle">Active</Label>
              <Switch id="active-toggle" checked={editActive} onCheckedChange={setEditActive} />
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowPreview(!showPreview)}>
              {showPreview ? <EyeOff className="size-4 mr-1.5" /> : <Eye className="size-4 mr-1.5" />}
              {showPreview ? "Hide Preview" : "Show Preview"}
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Subject Line</Label>
            <Input id="subject" value={editSubject} onChange={(e) => setEditSubject(e.target.value)} placeholder="Email subject..." />
          </div>

          <div className="space-y-2">
            <Label htmlFor="body">Email Body (HTML or Plain Text)</Label>
            <Textarea id="body" value={editBody} onChange={(e) => setEditBody(e.target.value)} placeholder="Email body..." rows={12} font="mono" />
          </div>

          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Info className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Available Template Variables</span>
            </div>
            <div className="grid gap-1.5">
              {TEMPLATE_VARIABLES.map((v) => (
                <div key={v.name} className="flex items-center gap-3 text-sm">
                  <code className="bg-background px-2 py-0.5 rounded text-xs font-mono border">{v.name}</code>
                  <span className="text-muted-foreground">{v.description}</span>
                </div>
              ))}
            </div>
          </div>

          {showPreview && (
            <>
              <Separator />
              <div className="space-y-3">
                <h4 className="text-sm font-medium">Preview (with sample data)</h4>
                <div className="rounded-lg border bg-white p-6 space-y-4">
                  <div className="text-center pb-4 border-b">
                    <img src={SAMPLE_DATA["{{organization_logo_url}}"]} alt="Organization Logo" className="h-12 mx-auto" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                    <p className="text-xs text-muted-foreground mt-1">Organization logo will appear here</p>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Subject</span>
                    <p className="text-sm font-medium mt-0.5">{replaceVariables(editSubject, SAMPLE_DATA)}</p>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Body</span>
                    <div className="text-sm mt-1 whitespace-pre-line bg-neutral-surface-50 rounded p-4">
                      {replaceVariables(editBody, SAMPLE_DATA)}
                    </div>
                  </div>
                  <div className="text-center pt-4 border-t text-xs text-muted-foreground">
                    Sent by Perfect Game
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        <Separator />

        <div className="space-y-3">
          <Label iconSpacing>
            <Send className="size-4" />
            Send Test Email
          </Label>
          <div className="space-y-2">
            <div>
              <Label htmlFor="test-org" size="xs" tone="muted" className="mb-1 block">Organization</Label>
              <Select value={testOrgId} onValueChange={setTestOrgId}>
                <SelectTrigger id="test-org">
                  <SelectValue placeholder="Sample data (no real org)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sample data (no real org)</SelectItem>
                  {(orgsResponse?.data || []).map((org) => (
                    <SelectItem key={org.id} value={String(org.id)}>
                      <span className="flex items-center gap-2">
                        {org.logo ? (
                          <img src={org.logo} alt="" className="size-4 rounded object-contain" />
                        ) : (
                          <Building2 className="size-4 text-muted-foreground" />
                        )}
                        {org.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
            <Label htmlFor="test-email-input" size="xs" tone="muted" className="mb-1 block">Recipient</Label>
              <div className="flex gap-2">
                <Input
                  id="test-email-input"
                  type="email"
                  placeholder="Enter email address..."
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="flex-1"
                />
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!editingTemplate || !testEmail) return;
                    sendTestMutation.mutate({
                      id: editingTemplate.id,
                      toEmail: testEmail,
                      organizationId: testOrgId && testOrgId !== "none" ? testOrgId : undefined,
                    });
                  }}
                  disabled={sendTestMutation.isPending || !testEmail}
                >
                  {sendTestMutation.isPending ? (
                    <Loader2 className="size-4 mr-1.5 animate-spin" />
                  ) : (
                    <Send className="size-4 mr-1.5" />
                  )}
                  Send Test
                </Button>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Choose an organization to test with their real name and logo, or use sample data. Subject will be prefixed with [TEST].
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setEditingTemplate(null)}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateMutation.isPending}>
            {updateMutation.isPending && <Loader2 className="size-4 mr-1.5 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
