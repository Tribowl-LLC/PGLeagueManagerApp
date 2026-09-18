import type { Dispatch, SetStateAction } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Loader2, Mail, Eye, EyeOff, Info, Send } from "lucide-react";
import type { EmailTemplate } from "@shared/schema";

const TEMPLATE_VARIABLES = [
  { name: "{{bowler_name}}", description: "The bowler's name (for bowler invite emails)" },
  { name: "{{admin_name}}", description: "The administrator's name (for org admin invite emails)" },
  { name: "{{user_name}}", description: "The end user's name (for org end user invite emails)" },
  { name: "{{organization_name}}", description: "The organization name" },
  { name: "{{organization_logo}}", description: "The org's logo URL (for email header)" },
  { name: "{{league_name}}", description: "The league name (if applicable)" },
  { name: "{{invite_link}}", description: "The password setup link (for invite emails)" },
  { name: "{{login_link}}", description: "Link to the login page" },
  { name: "{{dashboard_link}}", description: "Link to the bowler dashboard" },
];

const SAMPLE_DATA: Record<string, string> = {
  "{{bowler_name}}": "John Smith",
  "{{admin_name}}": "Jane Admin",
  "{{user_name}}": "Alex User",
  "{{organization_name}}": "Perfect Game Bowling",
  "{{organization_logo}}": "https://example.com/logo.png",
  "{{league_name}}": "Wednesday Night Mixed",
  "{{invite_link}}": "https://leaguevault.com/set-password?token=abc123",
  "{{login_link}}": "https://leaguevault.com/login",
  "{{dashboard_link}}": "https://leaguevault.com/bowler-dashboard",
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
  { id: number; toEmail: string },
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
            <Label htmlFor="body">Email Body (Plain Text)</Label>
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
                    <img src={SAMPLE_DATA["{{organization_logo}}"]} alt="Organization Logo" className="h-12 mx-auto" onError={(e) => { e.currentTarget.style.display = "none"; }} />
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
                    Sent by LeagueVault
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
            Test emails use the configured business context. Subject will be prefixed with [TEST].
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
